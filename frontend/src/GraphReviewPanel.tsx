import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  confirmGraphReview,
  decideGraphReview,
  getGraphReview,
  retryGraphReview,
  type GraphReviewChoice,
  type GraphReviewReport,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { Tag } from "./Tag";
import type { Tone } from "./tags";
import "./GraphReview.css";

const PAGE_SIZE = 10;

const statuses: Record<string, string> = {
  prepared: "已生成方案，待写入",
  running: "处理中",
  completed: "完成",
  pending: "待开始",
  failed: "失败",
  skipped: "未执行",
};

type Candidate = GraphReviewReport["scan"]["candidates"][number];
type Entity = Candidate["entities"][number];
type Judgment = GraphReviewReport["judgments"][number];
type Group = NonNullable<Judgment["decision"]>["groups"][number];
type Verdict = "merge" | "separate" | "failed" | "running";
type Decision = "approved" | "rejected" | undefined;
type Filter =
  | "pending"
  | "approved"
  | "rejected"
  | "separate"
  | "failed"
  | "all";

const verdicts: Record<Verdict, { label: string; tone: Tone }> = {
  merge: { label: "建议合并", tone: "info" },
  separate: { label: "不是同一个", tone: "neutral" },
  failed: { label: "判断失败", tone: "danger" },
  running: { label: "判断中", tone: "warning" },
};

function verdictOf(judgment: Judgment | undefined): Verdict {
  if (
    !judgment ||
    judgment.status === "running" ||
    judgment.status === "pending"
  )
    return "running";
  if (judgment.status === "failed" || judgment.error) return "failed";
  return judgment.decision?.groups.length ? "merge" : "separate";
}

// 每条建议的人工决定：确认前看 decisions；确认后（或旧报告）看 approved_ids。
export function decisionsOf(report: GraphReviewReport) {
  const result: Record<string, Decision> = {};
  if (report.approved_by) {
    for (const judgment of report.judgments)
      judgment.decision?.groups.forEach((_, index) => {
        const id = `${judgment.candidate_id}:${index}`;
        result[id] = report.approved_ids?.includes(id)
          ? "approved"
          : "rejected";
      });
    return result;
  }
  for (const [id, item] of Object.entries(report.decisions ?? {}))
    result[id] = item.decision;
  return result;
}

// 和后端 review.components 同一规则：共享实体的已批准建议连成一个合并结果；key 取组内字典序最小的建议编号。
export function mergeComponents(report: GraphReviewReport, approved: string[]) {
  const chosen = new Map<string, Group>();
  for (const judgment of report.judgments)
    if (judgment.status === "completed")
      judgment.decision?.groups.forEach((group, index) => {
        const id = `${judgment.candidate_id}:${index}`;
        if (approved.includes(id)) chosen.set(id, group);
      });
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    if (!parents.has(key)) parents.set(key, key);
    let value = key;
    while (parents.get(value) !== value) value = parents.get(value)!;
    return value;
  };
  for (const group of chosen.values())
    for (const key of group.ids.slice(1))
      parents.set(root(key), root(group.ids[0]));
  const buckets = new Map<string, string[]>();
  for (const [id, group] of chosen) {
    const key = root(group.ids[0]);
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  }
  return [...buckets.values()]
    .map((ids) => {
      ids.sort();
      const options: GraphReviewChoice[] = [];
      for (const id of ids) {
        const { name, type } = chosen.get(id)!;
        if (!options.some((item) => item.name === name && item.type === type))
          options.push({ name, type });
      }
      return {
        key: ids[0],
        proposalIds: ids,
        entityIds: [...new Set(ids.flatMap((id) => chosen.get(id)!.ids))],
        options,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

function entityLabel(entity: Entity | undefined, fallback: string) {
  return entity ? entity.names.join(" / ") : fallback;
}

// 二次检查的过程和结果。每张卡片三层：系统为什么放在一起 → 模型的结论 → 人工的决定。
// 传 onDecide 时可以操作：每条建议可单独「合并 / 不合并」，也可勾选多条批量处理；这里只记录决定，最后统一写入。
export function GraphReviewDetails({
  report,
  onDecide,
  busy = false,
}: {
  report: GraphReviewReport;
  onDecide?: (ids: string[], decision: Decision | null) => Promise<void>;
  busy?: boolean;
}) {
  const editable = Boolean(onDecide);
  const [dialog, setDialog] = useState<{
    title: string;
    body: ReactNode;
  } | null>(null);
  const [filter, setFilter] = useState<Filter>(editable ? "pending" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<"groups" | "execution">("groups");
  const root = useRef<HTMLDivElement>(null);

  const decisions = decisionsOf(report);
  const judgments = useMemo(
    () => new Map(report.judgments.map((item) => [item.candidate_id, item])),
    [report.judgments],
  );
  const entities = useMemo(
    () =>
      new Map(
        report.scan.candidates.flatMap((candidate) =>
          candidate.entities.map((item) => [item.id, item] as const),
        ),
      ),
    [report.scan.candidates],
  );
  const rows = report.scan.candidates.map((candidate) => {
    const judgment = judgments.get(candidate.id);
    const ids = (judgment?.decision?.groups ?? []).map(
      (_, index) => `${candidate.id}:${index}`,
    );
    return { candidate, judgment, verdict: verdictOf(judgment), ids };
  });
  const match = (row: (typeof rows)[number], key: Filter) =>
    key === "all"
      ? true
      : key === "pending"
        ? row.ids.some((id) => !decisions[id])
        : key === "approved" || key === "rejected"
          ? row.ids.some((id) => decisions[id] === key)
          : row.verdict === key;
  const filters: [Filter, string][] = [
    ["pending", "待处理"],
    ["approved", "已批准"],
    ["rejected", "已否决"],
    ["separate", "模型判断不是同一个"],
    ["failed", "判断失败"],
    ["all", "全部"],
  ];
  const keyword = query.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      match(row, filter) &&
      (!keyword ||
        row.candidate.id === keyword ||
        row.candidate.entities.some((item) =>
          item.names.some((name) => name.toLowerCase().includes(keyword)),
        )),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = filtered.slice(
    (current - 1) * PAGE_SIZE,
    current * PAGE_SIZE,
  );
  const pagePending = visible.flatMap((row) =>
    row.ids.filter((id) => !decisions[id]),
  );

  useEffect(() => setPage(1), [filter, query]);

  function goto(next: number) {
    setPage(next);
    root.current?.scrollIntoView({ block: "start" });
  }

  async function decide(ids: string[], decision: Decision | null) {
    if (!onDecide || ids.length === 0) return;
    await onDecide(ids, decision);
    setSelected((items) => items.filter((id) => !ids.includes(id)));
  }

  function openEvidence(entity: Entity) {
    setDialog({
      title: `原文依据 · ${entity.names.join(" / ")}`,
      body: (
        <div className="gr-evidence">
          {entity.evidence.map((item, index) => (
            <section key={`${item.chunk_id}-${index}`}>
              <Tag mono size="sm" title={item.chunk_id}>
                分片 {item.chunk_id.split(":").at(-1)}
              </Tag>
              <p className="graph-chunk-text">{item.text}</p>
            </section>
          ))}
        </div>
      ),
    });
  }

  function openSimilarity(candidate: Candidate) {
    const method = report.scan.method;
    const [a, b] = candidate.entities;
    setDialog({
      title: `相似度 ${candidate.similarity?.toFixed(2)}`,
      body: (
        <div className="gr-similarity">
          <p>
            {method?.metric ?? "余弦相似度"}，向量模型{" "}
            <strong>{method?.embedding?.model ?? "—"}</strong>
            {method?.embedding && !method.embedding.semantic && (
              <Tag size="sm" tone="warning">
                字面相似，不是语义
              </Tag>
            )}
            。下面是实际拿去算向量的两段文字（格式：
            {method?.text_format ?? "名字（类型）：描述"}）。
          </p>
          {[a, b].map((entity, index) => (
            <section key={entity.id}>
              <strong>{entity.names.join(" / ")}</strong>
              <pre className="graph-prompt">
                {candidate.texts?.[index] ?? "—"}
              </pre>
            </section>
          ))}
          {candidate.ranks && (
            <p className="gr-small">
              {entityLabel(b, "")} 是「{entityLabel(a, "")}」最像的第{" "}
              {candidate.ranks[0]} 名；
              {entityLabel(a, "")} 是「{entityLabel(b, "")}」最像的第{" "}
              {candidate.ranks[1]} 名。
            </p>
          )}
        </div>
      ),
    });
  }

  function openText(title: string, text: string) {
    setDialog({ title, body: <pre className="graph-prompt">{text}</pre> });
  }

  const allProposals = rows.flatMap((row) => row.ids);
  const approvedCount = allProposals.filter(
    (id) => decisions[id] === "approved",
  ).length;
  const rejectedCount = allProposals.filter(
    (id) => decisions[id] === "rejected",
  ).length;
  const judged = report.judgments.filter(
    (item) => item.status !== "running",
  ).length;
  const method = report.scan.method;
  const steps: {
    label: string;
    by: string;
    value: string;
    state: "done" | "active" | "todo" | "failed";
  }[] = [
    {
      label: "找出候选",
      by: "系统",
      value: `${report.scan.candidate_count} 组`,
      state:
        report.scan.status === "completed"
          ? "done"
          : report.scan.status === "failed"
            ? "failed"
            : "active",
    },
    {
      label: "判断是否同一个",
      by: "大模型",
      value: `${judged}/${report.scan.candidate_count}`,
      state: judged >= report.scan.candidate_count ? "done" : "active",
    },
    {
      label: "逐条决定",
      by: "人工",
      value:
        report.scan.candidate_count === 0
          ? "无需确认"
          : `批准 ${approvedCount} · 否决 ${rejectedCount} · 待处理 ${allProposals.length - approvedCount - rejectedCount}`,
      state:
        report.approved_by || report.scan.candidate_count === 0
          ? "done"
          : report.status === "awaiting_review"
            ? "active"
            : "todo",
    },
    {
      label: "写入图谱",
      by: "系统",
      value: statuses[report.execution.status] ?? report.execution.status,
      state:
        report.execution.status === "completed"
          ? "done"
          : report.execution.status === "failed"
            ? "failed"
            : report.execution.status === "running"
              ? "active"
              : "todo",
    },
  ];

  return (
    <div className="gr" ref={root}>
      <ol className="gr-steps">
        {steps.map((step, index) => (
          <li key={step.label} className={`is-${step.state}`}>
            <span className="gr-step-dot">
              {step.state === "done"
                ? "✓"
                : step.state === "failed"
                  ? "!"
                  : index + 1}
            </span>
            <span>
              <strong>
                {step.label}
                <em className="gr-by">{step.by}</em>
              </strong>
              <small title={step.value}>{step.value}</small>
            </span>
          </li>
        ))}
      </ol>

      <div className="gr-method">
        {method ? (
          <>
            <p>
              <strong>怎么找出候选：</strong>① 名字完全相同的直接放一组；②
              其余用向量模型 <strong>{method.embedding?.model ?? "—"}</strong>{" "}
              给每个实体算向量，算的文字是「{method.text_format}」，两两算
              {method.metric}；每个实体取最像的 {method.top_k} 个，相似度 ≥{" "}
              {method.min_similarity} 才成对，最多 {method.max_pairs}{" "}
              对。只成对，不串联。
            </p>
            {method.embedding && !method.embedding.semantic && (
              <p className="gr-warn">
                当前没有配置 embedding
                模型，用的是字符二元组哈希：只看字面重合，不是语义相似。
              </p>
            )}
            {method.error && <p className="gr-warn">{method.error}</p>}
            <p className="gr-small">
              扫描 {report.scan.entity_count} 个实体 · 名字相同{" "}
              {report.scan.stats?.same_name ?? 0} 组 · 语义相似{" "}
              {report.scan.stats?.similar ?? 0} 对
              {report.scan.stats &&
                report.scan.stats.similar_total > report.scan.stats.similar &&
                `（共 ${report.scan.stats.similar_total} 对达到门槛，只保留相似度最高的 ${report.scan.stats.similar}）`}{" "}
              · 耗时 {report.scan.duration_ms ?? "—"} 毫秒
            </p>
          </>
        ) : (
          <p className="gr-small">
            旧规则（名字相同或互相包含）找出的候选 · 扫描{" "}
            {report.scan.entity_count} 个实体 · 耗时{" "}
            {report.scan.duration_ms ?? "—"}{" "}
            毫秒。点「重新检查」会按新规则重跑。
          </p>
        )}
        {report.approved_by && (
          <p className="gr-small">
            确认人 {report.approved_by} · {report.approved_at ?? ""}
          </p>
        )}
      </div>

      {report.execution.records.length > 0 && (
        <div className="gr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "groups"}
            onClick={() => setView("groups")}
          >
            候选 {rows.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "execution"}
            onClick={() => setView("execution")}
          >
            合并结果{" "}
            {
              report.execution.records.filter(
                (item) => item.status !== "skipped",
              ).length
            }
          </button>
        </div>
      )}

      {view === "execution" && report.execution.records.length > 0 ? (
        <div className="gr-list">
          {report.execution.records
            .filter((record) => record.status !== "skipped")
            .map((record) => (
              <article className="gr-card" key={record.id}>
                <header className="gr-card-head">
                  <strong className="gr-grow">
                    {record.name}
                    <Tag size="sm" hue>
                      {record.type}
                    </Tag>
                  </strong>
                  <Tag
                    size="sm"
                    dot
                    tone={
                      record.status === "completed"
                        ? "success"
                        : record.status === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {statuses[record.status] ?? record.status}
                  </Tag>
                </header>
                <p>由 {record.from_names?.join("、") || "—"} 合并</p>
                <p className="gr-small">
                  {record.mention_count ?? 0} 条名字出处 ·{" "}
                  {record.relation_count ?? 0} 条关系重新归属 ·{" "}
                  {record.type_corrections ?? 0} 处类型纠正
                  {record.proposal_ids &&
                    record.proposal_ids.length > 1 &&
                    ` · 来自 ${record.proposal_ids.length} 条建议`}
                </p>
                {record.reason && <p className="gr-reason">{record.reason}</p>}
              </article>
            ))}
        </div>
      ) : (
        <>
          <div className="gr-toolbar">
            <div className="gr-filters" role="group" aria-label="筛选">
              {filters
                .filter(
                  ([key]) =>
                    key === "all" ||
                    key === "pending" ||
                    rows.some((row) => match(row, key)),
                )
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {label}{" "}
                    <span>{rows.filter((row) => match(row, key)).length}</span>
                  </button>
                ))}
            </div>
            <input
              type="search"
              className="gr-search"
              placeholder="搜实体名或组号"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {editable && (
            <div className="gr-bulk">
              <span>
                已勾选 <strong>{selected.length}</strong> 条
              </span>
              <button
                type="button"
                className="link-button"
                disabled={busy || pagePending.length === 0}
                onClick={() =>
                  setSelected([...new Set([...selected, ...pagePending])])
                }
              >
                勾选本页待处理
              </button>
              <button
                type="button"
                className="link-button"
                disabled={selected.length === 0}
                onClick={() => setSelected([])}
              >
                清空勾选
              </button>
              <button
                type="button"
                className="secondary-button gr-mini"
                disabled={busy || selected.length === 0}
                onClick={() => void decide(selected, "rejected")}
              >
                所选不合并
              </button>
              <button
                type="button"
                className="primary-button gr-mini"
                disabled={busy || selected.length === 0}
                onClick={() => void decide(selected, "approved")}
              >
                所选合并（{selected.length}）
              </button>
            </div>
          )}

          <div className="gr-list">
            {visible.length === 0 && (
              <p className="graph-note">
                {filter === "pending"
                  ? "没有待处理的建议了。"
                  : "没有符合条件的候选。"}
              </p>
            )}
            {visible.map(({ candidate, judgment, verdict, ids }) => (
              <article className={`gr-card is-${verdict}`} key={candidate.id}>
                <header className="gr-card-head">
                  <span className="gr-card-id">#{candidate.id}</span>
                  {candidate.kind === "similar" ? (
                    <button
                      type="button"
                      className="gr-kind"
                      title="看相似度是拿什么算的"
                      onClick={() => openSimilarity(candidate)}
                    >
                      语义相似 {candidate.similarity?.toFixed(2)} ▸
                    </button>
                  ) : candidate.kind === "same_name" ? (
                    <span className="gr-kind is-static">名字相同</span>
                  ) : (
                    <span className="gr-card-reason">{candidate.reason}</span>
                  )}
                  <span className="gr-grow" />
                  <Tag size="sm" dot tone={verdicts[verdict].tone}>
                    {verdicts[verdict].label}
                  </Tag>
                </header>

                <div className="gr-layer">
                  <span className="gr-layer-label">系统 · 为什么放在一起</span>
                  <ul className="gr-entities">
                    {candidate.entities.map((item) => (
                      <li key={item.id}>
                        <div className="gr-entity-name">
                          <strong>{item.names.join(" / ")}</strong>
                          {item.types.map((type) => (
                            <Tag key={type} size="sm" hue>
                              {type}
                            </Tag>
                          ))}
                          {item.evidence.length > 0 && (
                            <button
                              type="button"
                              className="link-button gr-source"
                              onClick={() => openEvidence(item)}
                            >
                              原文 {item.evidence.length}
                            </button>
                          )}
                        </div>
                        {item.descriptions.length > 0 && (
                          <p
                            className="gr-desc"
                            title={item.descriptions.join("；")}
                          >
                            {item.descriptions.join("；")}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="gr-layer">
                  <span className="gr-layer-label">模型 · 是不是同一个</span>
                  {verdict === "running" && (
                    <p className="gr-small">等待模型判断…</p>
                  )}
                  {judgment?.error && (
                    <p className="field-error">
                      {judgment.error}。此组不合并。
                    </p>
                  )}
                  {judgment?.decision?.groups.map((group, index) => {
                    const corrections = group.ids
                      .map((key) => entities.get(key))
                      .filter(
                        (item): item is Entity =>
                          !!item && !item.types.includes(group.type),
                      );
                    return (
                      <div className="gr-proposal" key={index}>
                        <span className="gr-proposal-line">
                          {group.ids
                            .map((key) => entityLabel(entities.get(key), key))
                            .join(" + ")}
                          <span className="gr-arrow">→</span>
                          <strong>{group.name}</strong>
                          <Tag size="sm" hue>
                            {group.type}
                          </Tag>
                        </span>
                        {corrections.length > 0 && (
                          <span className="gr-small">
                            类型纠正：
                            {corrections
                              .map(
                                (item) =>
                                  `${item.names[0]} ${item.types.join("、")} → ${group.type}`,
                              )
                              .join("；")}
                          </span>
                        )}
                        <span className="gr-reason">理由：{group.reason}</span>
                      </div>
                    );
                  })}
                  {judgment?.decision?.separate_reason && (
                    <p className="gr-reason">
                      {verdict === "separate" ? "不合并：" : "其余不合并："}
                      {judgment.decision.separate_reason}
                    </p>
                  )}
                  {judgment && verdict !== "running" && (
                    <div className="gr-card-foot">
                      <span>
                        {judgment.duration_ms ?? "—"} 毫秒 · Token{" "}
                        {judgment.input_tokens ?? "—"} /{" "}
                        {judgment.output_tokens ?? "—"}
                      </span>
                      {judgment.prompt && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            openText(
                              `#${candidate.id} 完整提示词`,
                              judgment
                                .prompt!.map(
                                  (item) => `【${item.role}】\n${item.content}`,
                                )
                                .join("\n\n"),
                            )
                          }
                        >
                          提示词
                        </button>
                      )}
                      {judgment.raw_output != null && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            openText(
                              `#${candidate.id} 模型原始输出`,
                              judgment.raw_output!,
                            )
                          }
                        >
                          原始输出
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {ids.length > 0 && (
                  <div className="gr-layer gr-decide">
                    <span className="gr-layer-label">人工 · 决定</span>
                    {ids.map((id, index) => {
                      const state = decisions[id];
                      const group = judgment!.decision!.groups[index];
                      return (
                        <div
                          className={`gr-decision is-${state ?? "pending"}`}
                          key={id}
                        >
                          {editable && !state && (
                            <input
                              type="checkbox"
                              aria-label="勾选以批量处理"
                              checked={selected.includes(id)}
                              onChange={(event) =>
                                setSelected((items) =>
                                  event.target.checked
                                    ? [...items, id]
                                    : items.filter((key) => key !== id),
                                )
                              }
                            />
                          )}
                          <span className="gr-grow">
                            {ids.length > 1 && `${group.name}：`}
                            {state === "approved" ? (
                              <Tag size="sm" tone="success">
                                {report.approved_by
                                  ? "已合并"
                                  : "已批准，待写入"}
                              </Tag>
                            ) : state === "rejected" ? (
                              <Tag size="sm" tone="neutral">
                                {report.approved_by ? "未合并" : "已否决"}
                              </Tag>
                            ) : (
                              <Tag size="sm" tone="warning">
                                待处理
                              </Tag>
                            )}
                          </span>
                          {editable &&
                            (state ? (
                              <button
                                type="button"
                                className="link-button"
                                disabled={busy}
                                onClick={() => void decide([id], null)}
                              >
                                撤销
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="secondary-button gr-mini"
                                  disabled={busy}
                                  onClick={() => void decide([id], "rejected")}
                                >
                                  不合并
                                </button>
                                <button
                                  type="button"
                                  className="primary-button gr-mini"
                                  disabled={busy}
                                  onClick={() => void decide([id], "approved")}
                                >
                                  合并
                                </button>
                              </>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            ))}
          </div>

          {filtered.length > PAGE_SIZE && (
            <nav className="gr-pager" aria-label="候选分页">
              <span>
                第 {(current - 1) * PAGE_SIZE + 1}–
                {Math.min(current * PAGE_SIZE, filtered.length)} 条，共{" "}
                {filtered.length} 条
              </span>
              <span className="gr-pager-controls">
                <button
                  type="button"
                  disabled={current === 1}
                  onClick={() => goto(current - 1)}
                >
                  上一页
                </button>
                <span>
                  {current} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={current === pageCount}
                  onClick={() => goto(current + 1)}
                >
                  下一页
                </button>
              </span>
            </nav>
          )}
        </>
      )}

      {dialog && (
        <DetailDialog open title={dialog.title} onClose={() => setDialog(null)}>
          {dialog.body}
        </DetailDialog>
      )}
    </div>
  );
}

// 「将要执行」汇总：把已批准的建议按实际结果合起来；连在一起且名字不一致的，必须先选一个。
function MergePlan({
  report,
  approved,
  choices,
  onChoose,
}: {
  report: GraphReviewReport;
  approved: string[];
  choices: Record<string, GraphReviewChoice>;
  onChoose: (key: string, choice: GraphReviewChoice) => void;
}) {
  const names = new Map(
    report.scan.candidates.flatMap((candidate) =>
      candidate.entities.map((item) => [item.id, item.names[0]] as const),
    ),
  );
  const groups = mergeComponents(report, approved);
  if (groups.length === 0) return null;
  return (
    <details className="gr-plan" open>
      <summary>将要执行：{groups.length} 个合并结果</summary>
      <ol>
        {groups.map((group) => {
          const choice = choices[group.key];
          return (
            <li key={group.key}>
              <span>
                {group.entityIds.map((id) => names.get(id) ?? id).join("、")}
                <span className="gr-arrow">→</span>
                {group.options.length === 1 ? (
                  <strong>
                    {group.options[0].name}（{group.options[0].type}）
                  </strong>
                ) : (
                  <span className="gr-choose">
                    <span className="gr-warn-inline">
                      名字不一致，请选一个：
                    </span>
                    {group.options.map((option) => (
                      <label key={`${option.name}|${option.type}`}>
                        <input
                          type="radio"
                          name={`gr-choice-${group.key}`}
                          checked={
                            choice?.name === option.name &&
                            choice?.type === option.type
                          }
                          onChange={() => onChoose(group.key, option)}
                        />
                        {option.name}（{option.type}）
                      </label>
                    ))}
                  </span>
                )}
              </span>
              {group.proposalIds.length > 1 && (
                <small>
                  来自 {group.proposalIds.length} 条建议：
                  {group.proposalIds
                    .map((id) => `#${id.split(":")[0]}`)
                    .join("、")}
                </small>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// 弹窗正文：读取最新报告；等待确认时可逐条或批量决定，底部是「将要执行」汇总和完成确认。两处入口共用。
export function GraphReviewBody({
  documentId,
  buildId,
  tick = 0,
  canRetry = false,
  fallback,
  onChanged,
}: {
  documentId: string;
  buildId?: string;
  tick?: number;
  canRetry?: boolean;
  fallback?: GraphReviewReport | null;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof getGraphReview>
  > | null>(null);
  const [choices, setChoices] = useState<Record<string, GraphReviewChoice>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getGraphReview(documentId)
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError("");
        }
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [documentId, buildId, tick]);
  const live =
    data?.report && (!buildId || data.report.build_id === buildId)
      ? data.report
      : null;
  // 处理过程里看的是旧建图记录时，最新报告对不上，就展示步骤里存的快照（只读）。
  const report =
    live ??
    (fallback && (!data?.report || data.report.build_id !== fallback.build_id)
      ? fallback
      : null);
  const canConfirm =
    !!live && live.status === "awaiting_review" && !!data?.can_confirm;
  const decisions = report ? decisionsOf(report) : {};
  const approved = Object.keys(decisions)
    .filter((id) => decisions[id] === "approved")
    .sort();
  const total = report
    ? report.judgments.reduce(
        (sum, item) =>
          sum +
          (item.status === "completed"
            ? (item.decision?.groups.length ?? 0)
            : 0),
        0,
      )
    : 0;
  const pending = total - Object.keys(decisions).length;
  const groups = report ? mergeComponents(report, approved) : [];
  const unresolved = groups.filter(
    (group) => group.options.length > 1 && !choices[group.key],
  );

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    ids: string[],
    decision: "approved" | "rejected" | null | undefined,
  ) {
    if (!live) return;
    await run(async () => {
      const next = await decideGraphReview(
        documentId,
        live.build_id,
        ids,
        decision ?? null,
      );
      setData((value) => (value ? { ...value, report: next } : value));
      onChanged?.();
    });
  }

  async function finish() {
    if (!live) return;
    if (
      !window.confirm(
        `执行 ${groups.length} 个合并结果并写入图谱？${pending > 0 ? `还有 ${pending} 条未处理，将保持分开。` : ""}`,
      )
    )
      return;
    await run(async () => {
      const resolutions = Object.fromEntries(
        groups
          .filter((group) => group.options.length > 1)
          .map((group) => [group.key, choices[group.key]]),
      );
      await confirmGraphReview(
        documentId,
        live.build_id,
        approved,
        resolutions,
      );
      setData(await getGraphReview(documentId));
      onChanged?.();
    });
  }

  return (
    <div className="gr-body">
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {canConfirm && (
        <p className="gr-hint">
          每条建议可以单独点「合并 /
          不合并」，也可以勾选多条批量处理。这里只记录你的决定，随时可撤销；全部看完后点底部「完成确认，写入图谱」才真正执行。没处理的保持分开。
        </p>
      )}
      {report ? (
        <GraphReviewDetails
          report={report}
          onDecide={canConfirm ? decide : undefined}
          busy={busy}
        />
      ) : data ? (
        <p className="graph-note">已排队，候选识别完成后自动显示过程。</p>
      ) : (
        <p className="graph-note">正在读取…</p>
      )}
      {(canConfirm || (canRetry && data?.can_confirm)) && (
        <div className="gr-footer">
          {canConfirm && report && (
            <MergePlan
              report={report}
              approved={approved}
              choices={choices}
              onChoose={(key, choice) =>
                setChoices((items) => ({ ...items, [key]: choice }))
              }
            />
          )}
          <div className="gr-footer-row">
            {canConfirm ? (
              <span>
                已批准 <strong>{approved.length}</strong> · 待处理{" "}
                <strong>{pending}</strong>
                {unresolved.length > 0 && (
                  <span className="gr-warn-inline">
                    {" "}
                    · 有 {unresolved.length} 个合并结果要先选名字
                  </span>
                )}
              </span>
            ) : (
              <span />
            )}
            {canRetry && data?.can_confirm && !canConfirm && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await retryGraphReview(documentId);
                    setData(await getGraphReview(documentId));
                    onChanged?.();
                  })
                }
              >
                {busy ? "正在提交…" : report ? "重新检查" : "补跑二次检查"}
              </button>
            )}
            {canConfirm && (
              <button
                type="button"
                className="primary-button"
                disabled={busy || unresolved.length > 0}
                onClick={() => void finish()}
              >
                {busy
                  ? "正在提交…"
                  : `完成确认，写入图谱（${groups.length} 个合并结果）`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GraphReviewPanel({
  documentId,
  buildId,
  tick,
  canRetry,
  onChanged,
}: {
  documentId: string;
  buildId: string;
  tick: number;
  canRetry: boolean;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getGraphReview(documentId)
      .then(
        (value) =>
          !cancelled &&
          setStatus(
            value.report?.build_id === buildId ? value.report.status : null,
          ),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId, buildId, tick]);
  return (
    <>
      <button
        type="button"
        className={
          status === "awaiting_review" ? "primary-button" : "secondary-button"
        }
        onClick={() => setOpen(true)}
      >
        {status === "awaiting_review" ? "二次检查 · 去确认" : "二次检查合并"}
      </button>
      {open && (
        <DetailDialog
          open
          title="二次检查合并"
          className="gr-dialog"
          onClose={() => setOpen(false)}
        >
          <GraphReviewBody
            documentId={documentId}
            buildId={buildId}
            tick={tick}
            canRetry={canRetry}
            onChanged={onChanged}
          />
        </DetailDialog>
      )}
    </>
  );
}
