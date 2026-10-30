import { useEffect, useState } from "react";
import {
  getEvalBatch,
  type EvalBatchReport,
  type RuntimeSettingValue,
} from "./api";
import {
  BatchModeCards,
  BatchQuestionList,
  BatchTypeStats,
  batchColumns,
  batchOrder,
} from "./AgentEval";
import { paramsSummary } from "./EvalParamsPanel";
import { settingLabel } from "./SystemSettings";
import { Tag } from "./Tag";
import { runStatus } from "./tags";
import "./EvalBatch.css";

// 批次报告：一次评测跑的几组配置（后端 app/evaluation/batch.py）。
// 上面是每组的状态和各组配置不同的项；下面和单次评测同一套报告（汇总卡片、按类型、逐题），
// 一组配置的一个模式一列（AgentEval.tsx 的 Batch* 组件）。逐题展开后每列并排一份检索日志。

const PROMPT_LABELS: Record<string, string> = {
  intent: "改写提示词",
  sufficiency: "充分性判断提示词",
  answer: "回答提示词",
  agent: "Agent 提示词",
};

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
  const live = Boolean(
    report?.arms.some(
      (arm) => arm.status === "running" || arm.status === "queued",
    ),
  );

  // 有组还在跑或排队时每 5 秒刷新一次，跑完就停。
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
            timer = window.setTimeout(load, 5000);
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

  const columns = batchColumns(
    report.arms.map((arm, index) => ({
      id: arm.id,
      label: arm.label,
      run: report.runs[index] ?? null,
    })),
  );
  const order = batchOrder(columns);

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

      {report.config_diff.length > 0 && (
        <div className="evb-block">
          <h4>配置差异</h4>
          <div className="diag-table-wrap">
            <table className="diag-table ev-table">
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
                    <td>{diffLabel(row.key)}</td>
                    {row.values.map((value, index) => (
                      <td key={report.arms[index]?.id ?? index}>
                        {formatValue(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {columns.length === 0 ? (
        <p className="ev-muted-note">
          还没有跑完的组，跑完一组就会显示在下面。
        </p>
      ) : (
        <div className="ev-overview ag-eval">
          <BatchModeCards columns={columns} />
          <div className="ev-section-title">
            按类型<small>每列是一组配置的一个模式</small>
          </div>
          <BatchTypeStats columns={columns} order={order} />
          <div className="ev-section-title">
            逐题<small>点开看每列的检索日志</small>
          </div>
          <BatchQuestionList columns={columns} order={order} />
        </div>
      )}
    </section>
  );
}
