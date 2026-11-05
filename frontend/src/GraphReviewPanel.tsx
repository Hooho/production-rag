import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  decideGraphReview,
  getGraphReview,
  retryFailedGraphReview,
  retryGraphReview,
  rewriteGraphReview,
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

type Candidate = NonNullable<GraphReviewReport["scan"]>["candidates"][number];
type Entity = Candidate["entities"][number];
type Judgment = GraphReviewReport["judgments"][number];
type Group = NonNullable<Judgment["decision"]>["groups"][number];
type Verdict = "merge" | "separate" | "failed" | "running";
type Decision = "approved" | "rejected" | undefined;
type Filter =
  | "merge"
  | "running"
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

// 每条建议的人工决定（只看 decisions；旧流程的 approved_ids 不再沿用，重新检查后按新规则决定）。
export function decisionsOf(report: GraphReviewReport) {
  const result: Record<string, Decision> = {};
  for (const [id, item] of Object.entries(report.decisions ?? {}))
    result[id] = item.decision;
  return result;
}

// 待处理的建议条数（模型建议合并、还没批准也没否决的）。
export function pendingCount(report: GraphReviewReport) {
  const decisions = report.decisions ?? {};
  return (report.judgments ?? []).reduce(
    (sum, item) =>
      sum +
      (item.status === "completed"
        ? (item.decision?.groups ?? []).filter(
            (_, index) => !decisions[`${item.candidate_id}:${index}`],
          ).length
        : 0),
    0,
  );
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
  const scan = report.scan!;
  const applied = new Set(report.applied?.approved_ids ?? []);
  const records = report.applied?.records ?? report.execution?.records ?? [];
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
  const list = useRef<HTMLDivElement>(null);

  const decisions = decisionsOf(report);
  const judgments = useMemo(
    () => new Map(report.judgments.map((item) => [item.candidate_id, item])),
    [report.judgments],
  );
  const entities = useMemo(
    () =>
      new Map(
        scan.candidates.flatMap((candidate) =>
          candidate.entities.map((item) => [item.id, item] as const),
        ),
      ),
    [scan.candidates],
  );
  const rows = scan.candidates.map((candidate) => {
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
    ["merge", "模型建议合并"],
    ["approved", "已批准"],
    ["rejected", "已否决"],
    ["separate", "模型判断不是同一个"],
    ["failed", "判断失败"],
    ["running", "等待判断"],
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

  function similarityLabel(candidate: Candidate) {
    const low = candidate.similarity?.toFixed(2);
    const high = candidate.similarity_max?.toFixed(2);
    return high && high !== low ? `${low}–${high}` : low;
  }

  function openSimilarity(candidate: Candidate) {
    const method = scan.method;
    const names = candidate.entities.map((entity) => entityLabel(entity, ""));
    setDialog({
      title: `语义相似 ${similarityLabel(candidate)}`,
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
            。组里任意两个都 ≥ {method?.min_similarity ?? "门槛"}{" "}
            才放在一起；名字相同的记 1。
          </p>
          {candidate.pairs && (
            <table className="gr-pairs">
              <tbody>
                {[...candidate.pairs]
                  .sort((x, y) => y[2] - x[2])
                  .map(([i, j, score]) => (
                    <tr key={`${i}-${j}`}>
                      <td>{names[i]}</td>
                      <td>↔</td>
                      <td>{names[j]}</td>
                      <td>{score.toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <p className="gr-small">
            实际拿去算向量的文字（格式：
            {method?.text_format ?? "名字（类型）：描述"}）：
          </p>
          {candidate.entities.map((entity, index) => (
            <section key={entity.id}>
              <strong>{names[index]}</strong>
              <pre className="graph-prompt">
                {candidate.texts?.[index] ?? "—"}
              </pre>
            </section>
          ))}
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
  const method = scan.method;
  const steps: {
    label: string;
    by: string;
    value: string;
    state: "done" | "active" | "todo" | "failed";
    // 点步骤卡片跳到对应的内容；selected：当前看的正是这一步的内容。
    open?: () => void;
    selected?: boolean;
  }[] = [
    {
      label: "找出候选",
      by: "系统",
      value: `${scan.candidate_count} 组`,
      state:
        scan.status === "completed"
          ? "done"
          : scan.status === "failed"
            ? "failed"
            : "active",
    },
    {
      label: "判断是否同一个",
      by: "大模型",
      value: `${judged}/${scan.candidate_count}`,
      state: judged >= scan.candidate_count ? "done" : "active",
    },
    {
      label: "逐条决定",
      by: "人工",
      value:
        scan.candidate_count === 0
          ? "无需确认"
          : `批准 ${approvedCount} · 否决 ${rejectedCount} · 待处理 ${allProposals.length - approvedCount - rejectedCount}`,
      state:
        scan.candidate_count === 0 ||
        approvedCount + rejectedCount === allProposals.length
          ? "done"
          : report.status === "ready"
            ? "active"
            : "todo",
    },
    {
      label: "重写图谱",
      by: "系统",
      value:
        report.status === "rewriting"
          ? "正在重写"
          : report.applied
            ? `已应用 ${report.applied.groups.length} 个合并`
            : "未重写（可选）",
      state:
        report.status === "rewriting"
          ? "active"
          : report.applied
            ? "done"
            : "todo",
    },
  ];

  const show = (next: Filter) => {
    setView("groups");
    setFilter(next);
    window.setTimeout(
      () =>
        list.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
      0,
    );
  };
  const actions: Record<
    string,
    Pick<(typeof steps)[number], "open" | "selected">
  > = {
    找出候选: {
      open: () => show("all"),
      selected: view === "groups" && filter === "all",
    },
    判断是否同一个: {
      open: () =>
        show(
          rows.some((row) => row.verdict === "running") ? "running" : "merge",
        ),
      selected:
        view === "groups" && (filter === "merge" || filter === "running"),
    },
    逐条决定: {
      open: () => show("pending"),
      selected: view === "groups" && filter === "pending",
    },
    重写图谱: records.length
      ? {
          open: () => {
            setView("execution");
            window.setTimeout(
              () =>
                list.current?.scrollIntoView({
                  block: "start",
                  behavior: "smooth",
                }),
              0,
            );
          },
          selected: view === "execution",
        }
      : {},
  };

  return (
    <div className="gr" ref={root}>
      <ol className="gr-steps">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={`is-${step.state}${actions[step.label]?.open ? " is-link" : ""}${actions[step.label]?.selected ? " is-selected" : ""}`}
            role={actions[step.label]?.open ? "button" : undefined}
            tabIndex={actions[step.label]?.open ? 0 : undefined}
            title={
              actions[step.label]?.open ? "点击查看这一步的内容" : undefined
            }
            onClick={actions[step.label]?.open}
            onKeyDown={(event) => {
              if (
                (event.key === "Enter" || event.key === " ") &&
                actions[step.label]?.open
              ) {
                event.preventDefault();
                actions[step.label].open!();
              }
            }}
          >
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
              <strong>怎么找出候选：</strong>用向量模型{" "}
              <strong>{method.embedding?.model ?? "—"}</strong>{" "}
              给每个实体算向量，算的文字是「{method.text_format}」，两两算
              {method.metric}（名字完全相同的记
              1）。从最像的两个开始往组里合并，
              <strong>组里任意两个都 ≥ {method.min_similarity}</strong>{" "}
              才能放在一起，每组最多 {method.max_group_size ?? "—"}{" "}
              个，每个实体只进一组（只看它最像的 {method.top_k}{" "}
              个）。不会串联，也不补查组外的对。
            </p>
            {method.embedding && !method.embedding.semantic && (
              <p className="gr-warn">
                当前没有配置 embedding
                模型，用的是字符二元组哈希：只看字面重合，不是语义相似。
              </p>
            )}
            {method.error && <p className="gr-warn">{method.error}</p>}
            <p className="gr-small">
              扫描 {scan.entity_count} 个实体 · 名字相同{" "}
              {scan.stats?.same_name ?? 0} 组 · 语义相似{" "}
              {scan.stats?.similar ?? 0} 组
              {scan.stats?.total &&
                scan.stats.total > scan.stats.same_name + scan.stats.similar &&
                `（共 ${scan.stats.total} 组，只保留最像的 ${scan.stats.same_name + scan.stats.similar} 组）`}{" "}
              · 耗时 {scan.duration_ms ?? "—"} 毫秒
            </p>
          </>
        ) : (
          <p className="gr-small">
            旧规则（名字相同或互相包含）找出的候选 · 扫描 {scan.entity_count}{" "}
            个实体 · 耗时 {scan.duration_ms ?? "—"}{" "}
            毫秒。点「重新检查」会按新规则重跑。
          </p>
        )}
        {report.prompt_tag && (
          <p className="gr-small">
            模型判断用的提示词：<code>{report.prompt_tag}</code>{" "}
            {report.system_prompt && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  openText("二次检查合并提示词", report.system_prompt!)
                }
              >
                查看
              </button>
            )}
            （在「提示词管理 · 知识图谱」里修改，改完点「重新检查」生效）
          </p>
        )}
        {report.applied && (
          <p className="gr-small">
            图谱上次按确认结果重写：{report.applied.by} · {report.applied.at}
            ，应用了 {report.applied.groups.length} 个合并结果
          </p>
        )}
      </div>

      <div ref={list} />
      {records.length > 0 && (
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
            {records.filter((item) => item.status !== "skipped").length}
          </button>
        </div>
      )}

      {view === "execution" && records.length > 0 ? (
        <div className="gr-list">
          {records
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
                className="secondary-button button-sm"
                disabled={busy || selected.length === 0}
                onClick={() => void decide(selected, "rejected")}
              >
                所选不合并
              </button>
              <button
                type="button"
                className="primary-button button-sm"
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
                      语义相似 {similarityLabel(candidate)} ▸
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
                                {applied.has(id)
                                  ? "已批准 · 已写入图谱"
                                  : "已批准 · 待重写"}
                              </Tag>
                            ) : state === "rejected" ? (
                              <Tag size="sm" tone="neutral">
                                {applied.has(id)
                                  ? "已否决 · 重写后撤掉"
                                  : "已否决"}
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
                                  className="secondary-button button-sm"
                                  disabled={busy}
                                  onClick={() => void decide([id], "rejected")}
                                >
                                  不合并
                                </button>
                                <button
                                  type="button"
                                  className="primary-button button-sm"
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

// 「重写后图谱上的合并」汇总：把已批准的建议按实际结果合起来；连在一起且名字不一致的，必须先选一个。
// 和上次已应用的对比，列出这次会撤掉的合并（结果只取决于现在批准了哪些）。
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
  const scan = report.scan!;
  const names = new Map(
    scan.candidates.flatMap((candidate) =>
      candidate.entities.map((item) => [item.id, item.names[0]] as const),
    ),
  );
  const label = (ids: string[]) =>
    ids.map((id) => names.get(id) ?? id).join("、");
  const groups = mergeComponents(report, approved);
  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length &&
    [...a].sort().join("|") === [...b].sort().join("|");
  const dropped = (report.applied?.groups ?? []).filter(
    (old) => !groups.some((group) => sameIds(group.entityIds, old.ids)),
  );
  if (groups.length === 0 && dropped.length === 0) return null;
  return (
    <details className="gr-plan" open>
      <summary>
        重写后图谱上的合并：{groups.length} 个
        {dropped.length > 0 && `，撤掉 ${dropped.length} 个`}
      </summary>
      <ol>
        {groups.map((group) => {
          const choice = choices[group.key];
          const kept = (report.applied?.groups ?? []).some((old) =>
            sameIds(group.entityIds, old.ids),
          );
          return (
            <li key={group.key}>
              <span>
                {label(group.entityIds)}
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
                <Tag size="sm" tone={kept ? "neutral" : "info"}>
                  {kept ? "已在图谱中" : "新增"}
                </Tag>
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
        {dropped.map((old) => (
          <li key={`drop-${old.key}`} className="gr-dropped">
            <span>
              {label(old.ids)}
              <span className="gr-arrow">→</span>
              <s>
                {old.name}（{old.type}）
              </s>
              <Tag size="sm" tone="warning">
                撤掉（现在没有批准）
              </Tag>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const ACTIVE = ["queued", "running", "rewriting"];

// 弹窗正文：读取最新报告；排队、判断、重写时自动刷新。图谱已经写好，这里的合并是可选的：
// 逐条或批量记录决定，最后「按确认结果重写图谱」才改图谱。两处入口（实体关系、处理过程）共用。
export function GraphReviewBody({
  documentId,
  buildId,
  tick = 0,
  canRetry = true,
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
  const [poll, setPoll] = useState(0);
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
  }, [documentId, buildId, tick, poll]);
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
  const active = !!live && ACTIVE.includes(live.status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setPoll((value) => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [active, poll]);
  const wasActive = useRef(false);
  useEffect(() => {
    // 判断或重写刚结束：通知外面刷新（处理过程、实体关系页签）。
    if (wasActive.current && !active) onChanged?.();
    wasActive.current = active;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const canDecide = !!live && live.status === "ready" && !!data?.can_confirm;
  const decisions = report ? decisionsOf(report) : {};
  const approved = Object.keys(decisions)
    .filter((id) => decisions[id] === "approved")
    .sort();
  const pending = report ? pendingCount(report) : 0;
  const groups = report?.scan ? mergeComponents(report, approved) : [];
  const unresolved = groups.filter(
    (group) => group.options.length > 1 && !choices[group.key],
  );
  const canRewrite =
    canDecide && (groups.length > 0 || !!live?.applied?.groups.length);

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
      setData((value) =>
        value ? { ...value, report: { ...next, status: "ready" } } : value,
      );
    });
  }

  async function rewrite() {
    if (!live) return;
    if (
      !window.confirm(
        `按 ${groups.length} 个合并结果重写图谱？从已保存的抽取结果重新写一遍，不调用模型。${pending > 0 ? `还有 ${pending} 条未处理，保持分开。` : ""}`,
      )
    )
      return;
    await run(async () => {
      const resolutions = Object.fromEntries(
        groups
          .filter((group) => group.options.length > 1)
          .map((group) => [group.key, choices[group.key]]),
      );
      await rewriteGraphReview(documentId, live.build_id, resolutions);
      setData(await getGraphReview(documentId));
      onChanged?.();
    });
  }

  async function retry() {
    if (
      live?.decisions &&
      Object.keys(live.decisions).length > 0 &&
      !window.confirm(
        "重新检查会清掉模型判断和你的决定（图谱上已应用的合并保留，直到下次重写）。继续？",
      )
    )
      return;
    await run(async () => {
      await retryGraphReview(documentId);
      setData(await getGraphReview(documentId));
      onChanged?.();
    });
  }

  const failedCount = (live?.judgments ?? []).filter(
    (item) => item.status === "failed",
  ).length;

  async function retryFailed() {
    await run(async () => {
      await retryFailedGraphReview(documentId);
      setData(await getGraphReview(documentId));
      onChanged?.();
    });
  }

  const showRetry =
    canRetry &&
    !!data?.can_confirm &&
    (!live || ["ready", "failed", "idle"].includes(live.status));

  return (
    <div className="gr-body">
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {canDecide && (
        <p className="gr-hint">
          图谱已经写好，可以直接用；这里的合并是可选的。每条建议可以单独点「合并
          /
          不合并」，也可以勾选多条批量处理，随时可撤销。点底部「按确认结果重写图谱」才会改图谱（不调用模型）。没处理的保持分开。
        </p>
      )}
      {live?.status === "rewriting" && (
        <p className="gr-hint">正在按确认结果重写图谱…</p>
      )}
      {live?.status === "failed" && (
        <p className="field-error">二次检查失败：{live.error ?? "未知原因"}</p>
      )}
      {report?.scan ? (
        <GraphReviewDetails
          report={report}
          onDecide={canDecide ? decide : undefined}
          busy={busy}
        />
      ) : report?.status === "idle" ? (
        <p className="graph-note">
          还没开始二次检查。图谱已经写好，不检查也能用。
        </p>
      ) : data ? (
        <p className="graph-note">
          {report || live
            ? "排队等待二次检查，找出候选后自动显示过程…"
            : "这次建图还没有二次检查记录。"}
        </p>
      ) : (
        <p className="graph-note">正在读取…</p>
      )}
      {(canDecide || showRetry) && (
        <div className="gr-footer">
          {canDecide && report && (
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
            {canDecide ? (
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
            {canDecide && failedCount > 0 && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                title="只重新判断失败的组，其他组的判断和你的决定都保留"
                onClick={() => void retryFailed()}
              >
                重试失败的 {failedCount} 组
              </button>
            )}
            {showRetry && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void retry()}
              >
                {busy
                  ? "正在提交…"
                  : live?.status === "idle" || !report
                    ? "开始二次检查"
                    : "重新检查"}
              </button>
            )}
            {canDecide && (
              <button
                type="button"
                className="primary-button"
                disabled={busy || unresolved.length > 0 || !canRewrite}
                title={canRewrite ? undefined : "还没有批准任何合并建议"}
                onClick={() => void rewrite()}
              >
                {busy
                  ? "正在提交…"
                  : `按确认结果重写图谱（${groups.length} 个合并）`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 「实体关系」页签上的入口按钮：有待处理的建议时显示条数。
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
  const [report, setReport] = useState<GraphReviewReport | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getGraphReview(documentId)
      .then(
        (value) =>
          !cancelled &&
          setReport(value.report?.build_id === buildId ? value.report : null),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId, buildId, tick, open]);
  const pending = report?.status === "ready" ? pendingCount(report) : 0;
  return (
    <>
      <button
        type="button"
        className={pending > 0 ? "primary-button" : "secondary-button"}
        onClick={() => setOpen(true)}
      >
        {pending > 0
          ? `二次检查 · 待处理 ${pending}`
          : report && ACTIVE.includes(report.status)
            ? "二次检查 · 进行中"
            : "二次检查合并"}
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
