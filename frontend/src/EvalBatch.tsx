import { Fragment, useEffect, useState } from "react";
import {
  getEvalBatch,
  type EvalBatchCell,
  type EvalBatchModeSummary,
  type EvalBatchReport,
  type RuntimeSettingValue,
} from "./api";
import { paramsSummary } from "./EvalParamsPanel";
import { settingLabel } from "./SystemSettings";
import { Tag } from "./Tag";
import { runStatus } from "./tags";
import "./EvalBatch.css";

// 批次报告：一次评测跑的几组配置（后端 app/evaluation/batch.py）放在一起比——整体指标、配置差异、逐题拿到几条证据。
// 每组本身是一条普通评测记录，逐题的检索日志、证据详情点「查看这组详情」进去看。

type Mode = "fixed" | "agent";
const MODE_LABELS: Record<Mode, string> = { fixed: "固定流程", agent: "Agent" };
const PROMPT_LABELS: Record<string, string> = {
  intent: "改写提示词",
  sufficiency: "充分性判断提示词",
  answer: "回答提示词",
  agent: "Agent 提示词",
};

// 整体指标：higher 越大越好，lower 越小越好；最好的一组加粗。
type Metric = {
  label: string;
  value: (summary: EvalBatchModeSummary) => number | null | undefined;
  text: (summary: EvalBatchModeSummary) => string;
  better: "higher" | "lower";
};
const METRICS: Record<Mode, Metric[]> = {
  fixed: [
    {
      label: "得分",
      value: (item) => item.score,
      text: (item) => formatNumber(item.score),
      better: "higher",
    },
    {
      label: "证据全拿到的题",
      value: (item) => item.passed,
      text: (item) => String(item.passed),
      better: "higher",
    },
    {
      label: "拿到的证据",
      value: (item) => item.found,
      text: (item) => `${item.found} / ${item.total}`,
      better: "higher",
    },
  ],
  agent: [
    {
      label: "得分",
      value: (item) => item.score,
      text: (item) => formatNumber(item.score),
      better: "higher",
    },
    {
      label: "证据全拿到的题",
      value: (item) => item.passed,
      text: (item) => String(item.passed),
      better: "higher",
    },
    {
      label: "拿到的证据",
      value: (item) => item.found,
      text: (item) => `${item.found} / ${item.total}`,
      better: "higher",
    },
    {
      label: "平均输入 token",
      value: (item) => item.prompt_tokens,
      text: (item) =>
        item.prompt_tokens == null
          ? "—"
          : Math.round(item.prompt_tokens).toLocaleString(),
      better: "lower",
    },
    {
      label: "平均耗时",
      value: (item) => item.latency_ms,
      text: (item) =>
        item.latency_ms == null
          ? "—"
          : `${(item.latency_ms / 1000).toFixed(1)} 秒`,
      better: "lower",
    },
    {
      label: "平均检索次数",
      value: (item) => item.searches,
      text: (item) => formatNumber(item.searches),
      better: "lower",
    },
  ],
};

function formatNumber(value: number | null | undefined) {
  return value == null ? "—" : String(value);
}

function formatValue(value: RuntimeSettingValue | null) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "开" : "关";
  return String(value);
}

function diffLabel(key: string) {
  if (key.startsWith("setting:")) return settingLabel(key.slice(8));
  if (key.startsWith("prompt:"))
    return PROMPT_LABELS[key.slice(7)] ?? `${key.slice(7)} 提示词`;
  return key;
}

function cellTone(cell: EvalBatchCell) {
  if (!cell.total) return "";
  if ((cell.found ?? 0) >= cell.total) return "is-full";
  return (cell.found ?? 0) > 0 ? "is-partial" : "is-none";
}

// 某组这一格是空的：还没跑完，或者这组的题目里没有这道题。
function pendingText(status: string | undefined) {
  if (status === "running" || status === "queued") return "还没跑完";
  if (status !== "completed") return "这组没跑完";
  return "这组没有这题";
}

function cellKey(cell: EvalBatchCell | null) {
  return cell ? `${cell.found}/${cell.total}` : "";
}

export default function BatchReport({
  batchId,
  onBack,
  onOpenRun,
}: {
  batchId: string;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}) {
  const [report, setReport] = useState<EvalBatchReport | null>(null);
  const [error, setError] = useState("");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const live = Boolean(
    report?.arms.some(
      (arm) => arm.status === "running" || arm.status === "queued",
    ),
  );

  // 有组还在跑或排队时每 3 秒刷新一次，跑完就停。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = () =>
      getEvalBatch(batchId)
        .then((data) => {
          if (cancelled) return;
          setReport(data);
          setError("");
          if (
            data.arms.some(
              (arm) => arm.status === "running" || arm.status === "queued",
            )
          )
            timer = window.setTimeout(load, 3000);
        })
        .catch((reason: Error) => !cancelled && setError(reason.message));
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [batchId]);

  if (error && !report) {
    return (
      <section className="evb-root">
        <button className="ev-back-button" onClick={onBack}>
          ← 返回历次记录
        </button>
        <p className="evb-error">{error}</p>
      </section>
    );
  }
  if (!report) return <p className="ev-muted-note">正在读取批次报告…</p>;

  const modes = (["fixed", "agent"] as Mode[]).filter((mode) =>
    report.arms.some((arm) => arm.summary?.[mode]),
  );
  const questions = onlyDiff
    ? report.questions.filter((row) =>
        modes.some(
          (mode) =>
            new Set(row.cells.map((cell) => cellKey(cell?.[mode] ?? null)))
              .size > 1,
        ),
      )
    : report.questions;
  const groups = Array.from(new Set(report.questions.map((row) => row.group)));

  return (
    <section className="evb-root">
      <button className="ev-back-button" onClick={onBack}>
        ← 返回历次记录
      </button>
      <header className="evb-head">
        <h3>
          批次报告
          {report.name ? ` · ${report.name}` : ""}
        </h3>
        <span>
          {report.arms.length} 组配置，按顺序跑
          {live ? "，还在进行中，页面会自动刷新" : ""}
        </span>
      </header>

      <div className="evb-arms">
        {report.arms.map((arm) => {
          const status = runStatus(arm.status);
          const lines = paramsSummary(arm.params);
          return (
            <article key={arm.id} className="evb-arm">
              <div className="evb-arm-title">
                <strong>{arm.label}</strong>
                <Tag size="sm" dot tone={status.tone}>
                  {status.label}
                  {arm.status === "running" && arm.progress?.total
                    ? ` ${Math.round((arm.progress.done / arm.progress.total) * 100)}%`
                    : ""}
                </Tag>
              </div>
              <p>{lines.length ? lines.join("；") : "参数全部跟随系统设置"}</p>
              {arm.error && <p className="evb-error">{arm.error}</p>}
              <button
                type="button"
                className="ev-link"
                onClick={() => onOpenRun(arm.id)}
              >
                查看这组详情
              </button>
            </article>
          );
        })}
      </div>

      {modes.length > 0 && (
        <div className="evb-block">
          <h4>整体指标</h4>
          <table className="evb-table">
            <thead>
              <tr>
                <th>指标</th>
                {report.arms.map((arm) => (
                  <th key={arm.id}>{arm.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modes.map((mode) =>
                METRICS[mode].map((metric) => {
                  const values = report.arms.map((arm) => {
                    const summary = arm.summary?.[mode];
                    return summary ? metric.value(summary) : null;
                  });
                  const present = values.filter(
                    (value): value is number => typeof value === "number",
                  );
                  const best = present.length
                    ? metric.better === "higher"
                      ? Math.max(...present)
                      : Math.min(...present)
                    : null;
                  return (
                    <tr key={`${mode}-${metric.label}`}>
                      <th>
                        {MODE_LABELS[mode]} · {metric.label}
                      </th>
                      {report.arms.map((arm, index) => {
                        const summary = arm.summary?.[mode];
                        const isBest =
                          present.length > 1 &&
                          values[index] === best &&
                          new Set(present).size > 1;
                        return (
                          <td key={arm.id} className={isBest ? "is-best" : ""}>
                            {summary ? metric.text(summary) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="evb-block">
        <h4>配置差异</h4>
        {report.config_diff.length === 0 ? (
          <p className="ev-muted-note">各组配置完全一样。</p>
        ) : (
          <table className="evb-table">
            <thead>
              <tr>
                <th>配置项</th>
                {report.arms.map((arm) => (
                  <th key={arm.id}>{arm.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.config_diff.map((row) => (
                <tr key={row.key}>
                  <th>{diffLabel(row.key)}</th>
                  {row.values.map((value, index) => (
                    <td key={report.arms[index]?.id ?? index}>
                      {formatValue(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {report.questions.length > 0 && (
        <div className="evb-block">
          <div className="evb-block-head">
            <h4>逐题对比</h4>
            <label className="evb-toggle">
              <input
                type="checkbox"
                checked={onlyDiff}
                onChange={() => setOnlyDiff(!onlyDiff)}
              />
              只看各组结果不同的题
            </label>
          </div>
          <p className="ev-muted-note">
            每格是拿到的证据条数；点题目展开看每组没拿到哪几条、丢在哪一步。
          </p>
          <table className="evb-table evb-questions">
            <thead>
              <tr>
                <th>题目</th>
                {report.arms.map((arm) => (
                  <th key={arm.id}>{arm.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {questions.map((row, rowIndex) => {
                const open = openKey === row.key;
                const showGroup =
                  groups.length > 1 &&
                  (rowIndex === 0 ||
                    questions[rowIndex - 1].group !== row.group);
                return (
                  <Fragment key={row.key}>
                    {showGroup && (
                      <tr className="evb-group-row">
                        <th colSpan={report.arms.length + 1}>{row.group}</th>
                      </tr>
                    )}
                    <tr
                      className={`evb-question-row ${open ? "is-open" : ""}`}
                      onClick={() => setOpenKey(open ? null : row.key)}
                    >
                      <th>
                        <span className="evb-caret">{open ? "▾" : "▸"}</span>
                        {row.type && <em>{row.type}</em>}
                        {row.question}
                      </th>
                      {row.cells.map((cell, index) => (
                        <td key={report.arms[index]?.id ?? index}>
                          {cell ? (
                            <span className="evb-cells">
                              {modes.map((mode) =>
                                cell[mode] ? (
                                  <span
                                    key={mode}
                                    className={`evb-cell ${cellTone(cell[mode]!)}`}
                                  >
                                    {modes.length > 1
                                      ? `${MODE_LABELS[mode]} `
                                      : ""}
                                    {cell[mode]!.found ?? "—"}/
                                    {cell[mode]!.total}
                                  </span>
                                ) : null,
                              )}
                            </span>
                          ) : (
                            <span className="ev-muted-note">
                              {pendingText(report.arms[index]?.status)}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                    {open && (
                      <tr className="evb-detail-row">
                        <td colSpan={report.arms.length + 1}>
                          <div className="evb-detail">
                            {report.arms.map((arm, index) => {
                              const cell = row.cells[index];
                              return (
                                <div key={arm.id}>
                                  <strong>{arm.label}</strong>
                                  {!cell ? (
                                    <p className="ev-muted-note">
                                      {pendingText(arm.status)}
                                    </p>
                                  ) : (
                                    modes.map((mode) =>
                                      cell[mode] ? (
                                        <div key={mode}>
                                          {modes.length > 1 && (
                                            <span className="evb-mode">
                                              {MODE_LABELS[mode]}
                                            </span>
                                          )}
                                          {cell[mode]!.missing.length === 0 ? (
                                            <p className="ev-muted-note">
                                              证据全拿到了
                                            </p>
                                          ) : (
                                            <ul>
                                              {cell[mode]!.missing.map(
                                                (item, itemIndex) => (
                                                  <li key={itemIndex}>
                                                    {item.label}
                                                    <span>{item.reason}</span>
                                                  </li>
                                                ),
                                              )}
                                            </ul>
                                          )}
                                        </div>
                                      ) : null,
                                    )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
