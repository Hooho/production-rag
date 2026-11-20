import { useEffect, useRef, useState } from "react";
import { GraphOptions, type GraphChoice } from "./GraphBuildDialog";
import {
  createGraphExperiment,
  getGraphExperiment,
  getGraphExperimentOptions,
  listGraphExperiments,
  retryGraphExperiment,
  getPrompt,
  type GraphExperiment,
  type PromptDetail,
} from "./api";
import { errorText, useToast } from "./Toast";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { DetailDialog } from "./DetailDialog";
import { HighlightedText } from "./HighlightedText";
import "./GraphExperiments.css";

const statuses: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};
export function GraphExperiments() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<GraphChoice>({
    schema_id: null,
    provider: null,
    model: null,
  });
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  const [version, setVersion] = useState("");
  const [references, setReferences] = useState<
    { id: string; title: string; number: number }[]
  >([]);
  const [reference, setReference] = useState("");
  const [history, setHistory] = useState<
    Omit<GraphExperiment, "data">[] | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [runs, setRuns] = useState<GraphExperiment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{
    title: string;
    value: unknown;
  } | null>(null);
  const generation = useRef(0);
  async function refreshHistory() {
    const data = await listGraphExperiments();
    setHistory(data.items);
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getPrompt("graph_extract"),
      getGraphExperimentOptions(),
      listGraphExperiments(),
    ])
      .then(([p, o, h]) => {
        if (cancelled) return;
        setPrompt(p);
        setReferences(o.references);
        setHistory(h.items);
      })
      .catch((reason) => !cancelled && toast("error", errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, [toast]);
  useEffect(() => {
    const token = ++generation.current;
    setRuns([]);
    if (!selected.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(selected.map(getGraphExperiment))
      .then((values) => {
        if (token === generation.current) setRuns(values);
      })
      .catch((reason) => {
        if (token === generation.current) toast("error", errorText(reason));
      })
      .finally(() => {
        if (token === generation.current) setLoading(false);
      });
  }, [selected, toast]);
  const runningIds = runs
    .filter((run) => ["queued", "running"].includes(run.status))
    .map((run) => run.id)
    .join(",");
  useEffect(() => {
    if (!runningIds) return;
    let stopped = false,
      notified = false,
      inflight = false;
    const token = generation.current;
    const timer = window.setInterval(async () => {
      if (inflight) return;
      inflight = true;
      try {
        const values = await Promise.all(
          runningIds.split(",").map(getGraphExperiment),
        );
        if (stopped || token !== generation.current) return;
        setRuns((previous) =>
          previous.map(
            (run) => values.find((value) => value.id === run.id) ?? run,
          ),
        );
        await refreshHistory();
      } catch (reason) {
        if (!stopped && !notified) {
          notified = true;
          toast("error", errorText(reason));
        }
      } finally {
        inflight = false;
      }
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [runningIds, toast]);
  async function start() {
    setBusy("start");
    try {
      const run = await createGraphExperiment({
        text,
        schema_id: choice.schema_id,
        llm:
          choice.provider && choice.model
            ? { provider: choice.provider, model: choice.model }
            : null,
        prompt_version: version === "" ? null : Number(version),
        reference_id: reference || null,
      });
      setSelected([run.id]);
      await refreshHistory();
      toast("success", "实验已加入队列");
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setBusy(null);
    }
  }
  async function retry(id: string) {
    setBusy(id);
    try {
      const run = await retryGraphExperiment(id);
      setRuns((previous) =>
        previous.map((item) => (item.id === id ? run : item)),
      );
      await refreshHistory();
      toast("success", "已从失败步骤重试");
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="gx-page">
      <section className="gx-compose">
        <div className="gx-heading">
          <div>
            <h2>分片提取实验</h2>
            <p className="graph-note">
              粘贴一段文字，查看实体、关系与合并过程。实验独立保存，不写入正式图谱。
            </p>
          </div>
          <span className="gx-badge">独立实验</span>
        </div>
        <label className="gx-input">
          分片原文
          <textarea
            aria-label="实验分片原文"
            value={text}
            maxLength={100000}
            onChange={(event) => setText(event.target.value)}
            placeholder="粘贴要提取实体和关系的文字"
          />
        </label>
        <div className="gx-config">
          <GraphOptions value={choice} onChange={setChoice} />
          <div className="gx-selects">
            <label>
              抽取提示词
              <select
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              >
                <option value="">
                  当前配置{prompt ? ` · ${prompt.active_label}` : ""}
                </option>
                {prompt?.versions.map((item) => (
                  <option value={item.version} key={item.version}>
                    {item.label}
                    {item.note ? ` · ${item.note}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              参照图谱
              <select
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              >
                <option value="">不参照已有图谱</option>
                {references.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · v{item.number}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="gx-actions">
          <span className="graph-note">
            {text.length.toLocaleString()} 字符 · 作为一个分片处理
          </span>
          <button
            className={`primary-button${busy === "start" ? " is-loading" : ""}`}
            disabled={!!busy || !text.trim() || !prompt}
            onClick={start}
          >
            开始实验
          </button>
        </div>
      </section>
      <section className="gx-history">
        <h2>实验记录</h2>
        <p className="graph-note">选择一条查看结果，选择两条并排比较。</p>
        {history === null ? (
          <LoadingSkeleton>
            <SkeletonBlock style={{ height: 72 }} />
          </LoadingSkeleton>
        ) : !history.length ? (
          <p className="graph-note">暂无实验记录</p>
        ) : (
          <div className="gx-records">
            {history.map((item) => (
              <label
                className={`gx-record${selected.includes(item.id) ? " is-selected" : ""}`}
                key={item.id}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={!selected.includes(item.id) && selected.length >= 2}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  <strong>{new Date(item.created).toLocaleString()}</strong>
                  <small>
                    {statuses[item.status] ?? item.status} ·{" "}
                    {item.id.slice(0, 8)}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>
      {loading ? (
        <LoadingSkeleton>
          <SkeletonBlock style={{ height: 280 }} />
        </LoadingSkeleton>
      ) : (
        <div
          className={`gx-results${runs.length === 2 ? " is-comparing" : ""}`}
        >
          {runs.map((run) => (
            <article className="gx-run" key={run.id}>
              <div className="gx-heading">
                <div>
                  <h2>实验 {run.id.slice(0, 8)}</h2>
                  <p className="graph-note">
                    {run.data.llm.provider} / {run.data.llm.model} · 提示词 v
                    {run.data.prompt_version}
                  </p>
                  <p className="graph-note">
                    {run.data.schema.name} ·{" "}
                    {run.data.reference.version
                      ? `参照图谱 v${run.data.reference.version.number}`
                      : "不参照图谱"}
                  </p>
                </div>
                <span className="gx-badge">{statuses[run.status]}</span>
              </div>
              <div className="gx-actions">
                <button
                  className="secondary-button button-sm"
                  onClick={() => {
                    setText(run.data.text);
                    setChoice({
                      schema_id: run.data.schema.id,
                      provider: run.data.llm.provider,
                      model: run.data.llm.model,
                    });
                    setVersion(String(run.data.prompt_version));
                    setReference(run.data.reference.version?.id ?? "");
                  }}
                >
                  复用输入与选择
                </button>
                <button
                  className="secondary-button button-sm"
                  onClick={() =>
                    setDetail({
                      title: "实际使用的提示词",
                      value: run.data.system_prompt,
                    })
                  }
                >
                  提示词
                </button>
                {run.status === "failed" && (
                  <button
                    className={`secondary-button button-sm${busy === run.id ? " is-loading" : ""}`}
                    disabled={!!busy}
                    onClick={() => retry(run.id)}
                  >
                    重试失败步骤
                  </button>
                )}
              </div>
              <section className="gx-step">
                <h3>分片原文</h3>
                <p className="gx-text">{run.data.text}</p>
              </section>
              {!run.data.steps.length && (
                <p className="graph-note">等待后台执行</p>
              )}
              {run.data.steps.map((step, index) => (
                <section className="gx-step" key={index}>
                  <div className="gx-heading">
                    <h3>
                      {index + 1}. {step.name}
                    </h3>
                    <span className="graph-note">
                      {statuses[step.status]}
                      {step.duration_ms !== undefined
                        ? ` · ${(step.duration_ms / 1000).toFixed(2)} 秒`
                        : ""}
                    </span>
                  </div>
                  {step.error && <p className="gx-error">{step.error}</p>}
                  <div className="gx-actions">
                    <button
                      className="link-button button-sm"
                      onClick={() =>
                        setDetail({
                          title: `${step.name} · 输入`,
                          value: step.input,
                        })
                      }
                    >
                      步骤输入
                    </button>
                    <button
                      className="link-button button-sm"
                      onClick={() =>
                        setDetail({
                          title: `${step.name} · 完整输出`,
                          value: step.output,
                        })
                      }
                    >
                      完整输出
                    </button>
                  </div>
                  <StepOutput
                    stage={index}
                    value={step.output}
                    onSource={(entity, evidence) =>
                      setDetail({
                        title: "分片原文",
                        value: (
                          <HighlightedText
                            text={run.data.text}
                            groups={[
                              { kind: "entity", texts: [entity] },
                              { kind: "evidence", texts: [evidence] },
                            ]}
                          />
                        ),
                      })
                    }
                  />
                </section>
              ))}
            </article>
          ))}
        </div>
      )}
      <DetailDialog
        open={detail !== null}
        title={detail?.title ?? "详情"}
        onClose={() => setDetail(null)}
      >
        {detail &&
          (typeof detail.value === "string" ? (
            <pre className="gx-text">{detail.value}</pre>
          ) : detail.title === "分片原文" ? (
            (detail.value as React.ReactNode)
          ) : (
            <pre className="gx-text">
              {JSON.stringify(detail.value, null, 2)}
            </pre>
          ))}
      </DetailDialog>
    </div>
  );
}
type ExperimentRow = Record<string, unknown>;
const mergeMethods: Record<string, string> = {
  exact: "同名匹配",
  normalized: "规范化匹配",
  canonical: "标准名匹配",
  alias: "别名匹配",
  new: "新实体",
};
function ResultTable({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="gx-table">
      <h4>
        {title} · {rows.length}
      </h4>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="graph-note">无</p>
      )}
    </div>
  );
}
function StepOutput({
  value,
  stage,
  onSource,
}: {
  value: unknown;
  stage: number;
  onSource: (entity: string, evidence: string) => void;
}) {
  if (!value || typeof value !== "object") return null;
  const data = value as ExperimentRow;
  const result = (data.result ?? data) as ExperimentRow;
  const rows = (key: string): ExperimentRow[] =>
    Array.isArray(result[key]) ? (result[key] as ExperimentRow[]) : [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const source = (row: ExperimentRow) => (
    <button
      className="link-button button-sm"
      onClick={() => onSource(text(row.name ?? row.source), text(row.evidence))}
    >
      原文
    </button>
  );
  const relations = () => (
    <ResultTable
      title={stage === 0 ? "抽取关系" : "最终关系"}
      columns={["起点 → 关系类型 → 终点", "关系描述", "原文引用", "操作"]}
      rows={rows("relations").map((row) => [
        `${text(row.source)} → ${text(row.category)} → ${text(row.target)}`,
        text(row.description) || "—",
        text(row.evidence) || "—",
        source(row),
      ])}
    />
  );
  if (stage === 1) {
    const mentions = rows("mentions");
    const merges = rows("merges");
    const scopes: Record<string, string> = {
      new: "本次新建",
      document: "本段实体",
      global: "已有图谱实体",
    };
    return (
      <ResultTable
        title="实体合并过程"
        columns={["原实体", "类型", "合并到", "处理方式", "匹配范围", "操作"]}
        rows={mentions.map((row) => {
          const merge = merges.find((item) => item.mention_id === row.id);
          const detail = (merge?.detail ?? {}) as ExperimentRow;
          const method = text(row.resolve_method);
          return [
            text(row.name),
            text(row.type),
            text(row.resolved_name ?? row.canonical ?? row.name),
            mergeMethods[method] ?? method,
            scopes[text(detail.scope)] ?? "—",
            source(row),
          ];
        })}
      />
    );
  }
  const entities = rows("entities");
  const finalEntities =
    stage === 2
      ? [
          ...new Map(
            entities.map((row, index) => [row.entity_id ?? index, row]),
          ).values(),
        ]
      : entities;
  return (
    <>
      <ResultTable
        title={stage === 0 ? "抽取实体" : "最终实体"}
        columns={
          stage === 0
            ? ["实体名称", "标准名", "实体类型", "描述", "操作"]
            : ["实体名称", "实体类型", "描述", "操作"]
        }
        rows={finalEntities.map((row) =>
          stage === 0
            ? [
                text(row.name),
                text(row.canonical) || text(row.name),
                text(row.type),
                text(row.description) || "—",
                source(row),
              ]
            : [
                text(row.resolved_name ?? row.canonical ?? row.name),
                text(row.type),
                text(row.description) || "—",
                source(row),
              ],
        )}
      />
      {relations()}
      {stage === 0 && rows("dropped").length > 0 && (
        <ResultTable
          title="丢弃内容"
          columns={["内容类型", "原始内容", "丢弃原因"]}
          rows={rows("dropped").map((row) => [
            row.kind === "entity" ? "实体" : "关系",
            JSON.stringify(row.item),
            text(row.reason),
          ])}
        />
      )}
    </>
  );
}
