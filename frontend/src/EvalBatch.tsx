import Table from "./Table";
import { SpecialSection } from "./Special";
import { useToast, errorText } from "./Toast";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { useEffect, useState } from "react";
import {
  getEvalBatch,
  retryEvalArm,
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
import { InfoPopover } from "./Popover";
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
  const toast = useToast();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [report, setReport] = useState<EvalBatchReport | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const live = Boolean(
    report?.arms.some(
      (arm) => arm.status === "running" || arm.status === "queued",
    ),
  );

  // 有组还在跑或排队时每 5 秒刷新一次，跑完就停。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let warned = false;
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
        .catch((reason) => {
          if (cancelled) return;
          setError(errorText(reason));
          if (!warned) {
            toast("error", errorText(reason));
            warned = true;
          }
          timer = window.setTimeout(load, 5000);
        });
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [batchId, refresh, toast]);

  if (error && !report) {
    return (
      <section className="evb-root">
        <button className="ev-back-button" onClick={onBack}>
          ← 返回历次记录
        </button>
        <p>报告暂时无法读取，请稍后重试。</p>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          重试
        </button>
      </section>
    );
  }
  if (!report)
    return (
      <LoadingSkeleton label="正在读取报告">
        <Table loading columnCount={6} className="diag-table ev-table" />
      </LoadingSkeleton>
    );

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
          评测对比报告
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
          const failed =
            arm.status === "failed" ||
            arm.status === "interrupted" ||
            Boolean(arm.error);
          return (
            <article
              key={arm.id}
              className={`evb-arm${failed ? " is-error" : ""}`}
            >
              <div className="evb-arm-title">
                <strong>
                  {arm.label}
                  {report.arms[0]?.id === arm.id ? " · 比较基准" : ""}
                </strong>
                <Tag size="sm" dot tone={status.tone}>
                  {status.label}
                  {arm.status === "running" && arm.progress?.total
                    ? ` ${Math.round((arm.progress.done / arm.progress.total) * 100)}%`
                    : ""}
                </Tag>
              </div>
              <p>
                {arm.kind === "generation"
                  ? "生成评测"
                  : arm.kind === "special"
                    ? "历史专项"
                    : "检索评测"}{" "}
                ·{" "}
                {arm.modes
                  ?.map((mode) => (mode === "fixed" ? "固定流程" : "Agent"))
                  .join("＋")}{" "}
                ·{" "}
                {arm.methods
                  ?.map(
                    (method) =>
                      ({ dense: "向量", keyword: "关键词", graph: "图检索" })[
                        method
                      ] ?? method,
                  )
                  .join("＋")}
              </p>
              {arm.effective && (
                <InfoPopover
                  title={`运行配置快照 · ${arm.label}`}
                  content={() => (
                    <>
                      <p className="evb-snapshot-line">
                        大模型：{arm.effective?.llm?.model} · 评审模型：
                        {arm.effective?.judge?.model}
                      </p>
                      <dl className="evb-snapshot">
                        {Object.entries(arm.effective?.settings ?? {}).flatMap(
                          ([key, value]) => [
                            <dt key={`${key}-name`}>{settingLabel(key)}</dt>,
                            <dd key={`${key}-value`}>{formatValue(value)}</dd>,
                          ],
                        )}
                        {Object.entries(arm.effective?.prompts ?? {}).flatMap(
                          ([key, value]) => [
                            <dt key={`prompt-${key}-name`}>
                              {PROMPT_LABELS[key] ?? key}
                            </dt>,
                            <dd key={`prompt-${key}-value`}>
                              {String(value)}
                            </dd>,
                          ],
                        )}
                      </dl>
                    </>
                  )}
                >
                  <button type="button" className="link-button button-sm">
                    运行配置快照
                  </button>
                </InfoPopover>
              )}
              <p>
                {lines.length
                  ? lines.join("；")
                  : "使用本次开始时固定的系统参数"}
              </p>
              {arm.error && <p className="evb-error">{arm.error}</p>}
              {arm.attempts?.length ? (
                <details>
                  <summary>历史尝试（{arm.attempts.length} 次）</summary>
                  {arm.attempts.map((attempt, index) => (
                    <p key={index}>
                      第 {index + 1} 次 · {runStatus(attempt.status).label} ·{" "}
                      {attempt.error || attempt.finished}
                    </p>
                  ))}
                </details>
              ) : null}
              {(arm.status === "failed" || arm.status === "interrupted") && (
                <button
                  type="button"
                  className={`secondary-button button-sm${retrying === arm.id ? " is-loading" : ""}`}
                  disabled={Boolean(retrying) || live}
                  onClick={async () => {
                    setRetrying(arm.id);
                    try {
                      await retryEvalArm(batchId, arm.id);
                      setReport(await getEvalBatch(batchId));
                      setRefresh((value) => value + 1);
                      toast("success", "已在本报告内重试此配置");
                    } catch (reason) {
                      toast("error", errorText(reason));
                    } finally {
                      setRetrying(null);
                    }
                  }}
                >
                  重试此配置
                </button>
              )}
            </article>
          );
        })}
      </div>

      {report.config_diff.length > 0 && (
        <div className="evb-block">
          <h4>配置差异</h4>
          <Table
            containerProps={{ className: "diag-table-wrap" }}
            className="diag-table ev-table"
          >
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
          </Table>
        </div>
      )}

      {report.runs.some(
        (run) => run?.kind === "special" || run?.variants?.length,
      ) && (
        <section className="evb-block">
          <h4>历史评测结果</h4>
          <p className="ev-muted-note">保留原计分规则与原结果。</p>
          {report.runs.map((run, index) =>
            run && (run.kind === "special" || run.variants?.length) ? (
              <details key={run.id}>
                <summary>{report.arms[index].label} · 原始评测详情</summary>
                {run.special?.map((section) => (
                  <SpecialSection key={section.suite_id} section={section} />
                ))}
                {run.variants?.length ? (
                  <Table className="ev-table">
                    <thead>
                      <tr>
                        <th>变体</th>
                        <th>原始统计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.variants.map((variant) => (
                        <tr key={variant.name}>
                          <td>{variant.label}</td>
                          <td>
                            {Object.entries(variant.summary)
                              .map(([key, value]) => `${key}: ${value ?? "—"}`)
                              .join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : null}
              </details>
            ) : null,
          )}
        </section>
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
