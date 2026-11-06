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
import { ConfirmPopover } from "./ConfirmPopover";
import { Tag } from "./Tag";
import { errorText, useToast } from "./Toast";
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
  separate: { label: "建议不合并", tone: "neutral" },
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

// 五步，每步一个页签，只显示这一步的内容。
export type ReviewStep = 1 | 2 | 3 | 4 | 5;

// 打开时停在哪一步：判断中 → 2；还有待处理 → 3；有批准、还没写入 → 4；写入中或都处理完 → 5。
export function defaultStep(report: GraphReviewReport): ReviewStep {
  if (!report.scan) return 1;
  if (["queued", "running"].includes(report.status)) return 2;
  if (report.status === "rewriting") return 5;
  if (pendingCount(report) > 0) return 3;
  const approved = Object.values(report.decisions ?? {}).filter(
    (item) => item.decision === "approved",
  ).length;
  if (approved > 0 || report.applied) return report.applied ? 5 : 4;
  return 2;
}

type Row = {
  candidate: Candidate;
  judgment: Judgment | undefined;
  verdict: Verdict;
  ids: string[];
};

// 二次检查的过程和结果，分五个页签：
//   1 找出候选（系统）  2 模型判断（大模型）  3 逐条决定（人工）  4 确认（人工）  5 写入图谱（系统）
// onDecide 有值时第 3 步可以操作；第 2 步的按钮、第 4 步的确认内容由外面传进来（它们要调接口）。
export function GraphReviewDetails({
  report,
  step,
  onStep,
  onDecide,
  busy = false,
  judgeActions,
  confirmPanel,
}: {
  report: GraphReviewReport;
  step: ReviewStep;
  onStep: (step: ReviewStep) => void;
  onDecide?: (ids: string[], decision: Decision | null) => Promise<void>;
  busy?: boolean;
  judgeActions?: ReactNode;
  confirmPanel?: ReactNode;
}) {
  const editable = Boolean(onDecide);
  const scan = report.scan!;
  const applied = new Set(report.applied?.approved_ids ?? []);
  const records = report.applied?.records ?? report.execution?.records ?? [];
  const [dialog, setDialog] = useState<{
    title: string;
    body: ReactNode;
  } | null>(null);
  const firstFilter: Record<ReviewStep, Filter> = {
    1: "all",
    2: "merge",
    3: "pending",
    4: "all",
    5: "all",
  };
  const [filter, setFilter] = useState<Filter>(firstFilter[step]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const root = useRef<HTMLDivElement>(null);

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
  const rows: Row[] = scan.candidates.map((candidate) => {
    const judgment = judgments.get(candidate.id);
    const ids = (judgment?.decision?.groups ?? []).map(
      (_, index) => `${candidate.id}:${index}`,
    );
    return { candidate, judgment, verdict: verdictOf(judgment), ids };
  });
  const decidable = rows.filter((row) => row.ids.length > 0);

  // 每一步的列表范围和筛选项。
  const scope: Record<ReviewStep, Row[]> = {
    1: rows,
    2: rows,
    3: decidable,
    4: [],
    5: [],
  };
  const stepFilters: Record<ReviewStep, [Filter, string][]> = {
    1: [["all", "全部"]],
    2: [
      ["merge", "建议合并"],
      ["separate", "建议不合并"],
      ["failed", "判断失败"],
      ["running", "等待判断"],
      ["all", "全部"],
    ],
    3: [
      ["pending", "待处理"],
      ["approved", "已批准"],
      ["rejected", "已否决"],
      ["all", "全部"],
    ],
    4: [],
    5: [],
  };
  const match = (row: Row, key: Filter) =>
    key === "all"
      ? true
      : key === "pending"
        ? row.ids.some((id) => !decisions[id])
        : key === "approved" || key === "rejected"
          ? row.ids.some((id) => decisions[id] === key)
          : row.verdict === key;
  const keyword = query.trim().toLowerCase();
  const filtered = scope[step].filter(
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

  useEffect(() => setPage(1), [filter, query, step]);
  useEffect(() => {
    setFilter(firstFilter[step]);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  function goto(next: number) {
    setPage(next);
    root.current?.scrollIntoView({ block: "start" });
  }

  async function decide(ids: string[], decision: Decision | null) {
    if (!onDecide || ids.length === 0) return;
    await onDecide(ids, decision);
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
  const approvedIds = allProposals.filter((id) => decisions[id] === "approved");
  const rejectedCount = allProposals.filter(
    (id) => decisions[id] === "rejected",
  ).length;
  const pending = allProposals.length - approvedIds.length - rejectedCount;
  const judged = report.judgments.filter(
    (item) => item.status !== "running",
  ).length;
  const failed = report.judgments.filter(
    (item) => item.status === "failed",
  ).length;
  const plan = mergeComponents(report, [...approvedIds].sort());
  const judging = ["queued", "running"].includes(report.status);
  const method = scan.method;

  const steps: {
    step: ReviewStep;
    label: string;
    by: string;
    value: string;
    state: "done" | "active" | "todo" | "failed";
  }[] = [
    {
      step: 1,
      label: "找出候选",
      by: "系统",
      value: `${scan.candidate_count} 组`,
      state: scan.status === "failed" ? "failed" : "done",
    },
    {
      step: 2,
      label: "模型判断",
      by: "大模型",
      value: `${judged}/${scan.candidate_count}${failed ? ` · 失败 ${failed}` : ""}`,
      state: judging ? "active" : failed ? "failed" : "done",
    },
    {
      step: 3,
      label: "逐条决定",
      by: "人工",
      value: `待处理 ${pending} · 批准 ${approvedIds.length} · 否决 ${rejectedCount}`,
      state:
        allProposals.length === 0 || pending === 0
          ? judging
            ? "todo"
            : "done"
          : "active",
    },
    {
      step: 4,
      label: "确认",
      by: "人工",
      value: `${plan.length} 个合并结果`,
      state:
        report.status === "rewriting"
          ? "done"
          : plan.length > 0 || report.applied
            ? "active"
            : "todo",
    },
    {
      step: 5,
      label: "写入图谱",
      by: "系统",
      value:
        report.status === "rewriting"
          ? "正在写入"
          : report.applied
            ? `已写入 ${report.applied.groups.length} 个合并`
            : "未写入（可选）",
      state:
        report.status === "rewriting"
          ? "active"
          : report.applied
            ? "done"
            : "todo",
    },
  ];

  function renderCard(row: Row) {
    const { candidate, judgment, verdict, ids } = row;
    const showModel = step >= 2;
    const showDecide = step === 3 && ids.length > 0;
    return (
      <article
        className={`gr-card ${showModel ? `is-${verdict}` : ""}`}
        key={candidate.id}
      >
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
          {showModel && (
            <Tag size="sm" dot tone={verdicts[verdict].tone}>
              {verdicts[verdict].label}
            </Tag>
          )}
        </header>

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
                <p className="gr-desc" title={item.descriptions.join("；")}>
                  {item.descriptions.join("；")}
                </p>
              )}
            </li>
          ))}
        </ul>

        {showModel && (
          <div className="gr-layer">
            <span className="gr-layer-label">模型判断</span>
            {verdict === "running" && <p className="gr-small">等待模型判断…</p>}
            {judgment?.error && (
              <p className="field-error">{judgment.error}。此组不合并。</p>
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
            {!!judgment?.decision?.ignored?.length && (
              <p className="gr-small">
                模型把{" "}
                {judgment.decision.ignored
                  .map((key) => entityLabel(entities.get(key), key))
                  .join("、")}{" "}
                单独列出，视为不合并。
              </p>
            )}
            {judgment?.decision?.separate_reason && (
              <p className="gr-reason">
                {verdict === "separate"
                  ? "不合并的原因："
                  : "其余不合并的原因："}
                {judgment.decision.separate_reason}
              </p>
            )}
            {step === 2 && judgment && verdict !== "running" && (
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
        )}

        {showDecide && (
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
                  <span className="gr-grow">
                    {ids.length > 1 && `${group.name}：`}
                    {state === "approved" ? (
                      <Tag size="sm" tone="success">
                        {applied.has(id)
                          ? "已批准 · 已写入图谱"
                          : "已批准 · 待写入"}
                      </Tag>
                    ) : state === "rejected" ? (
                      <Tag size="sm" tone="neutral">
                        {applied.has(id) ? "已否决 · 写入后撤掉" : "已否决"}
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
    );
  }

  function renderList() {
    const options = stepFilters[step];
    return (
      <>
        <div className="gr-toolbar">
          <div className="gr-filters" role="group" aria-label="筛选">
            {options
              .filter(
                ([key]) =>
                  key === "all" ||
                  key === firstFilter[step] ||
                  scope[step].some((row) => match(row, key)),
              )
              .map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label}{" "}
                  <span>
                    {scope[step].filter((row) => match(row, key)).length}
                  </span>
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

        <div className="gr-list">
          {visible.length === 0 && (
            <p className="graph-note">
              {step === 3 && filter === "pending"
                ? judging
                  ? "模型还在判断，判断出建议合并的组会出现在这里。"
                  : "没有待处理的建议了，可以去第 4 步确认。"
                : "没有符合条件的候选。"}
            </p>
          )}
          {visible.map(renderCard)}
        </div>

        {filtered.length > PAGE_SIZE && (
          <nav className="gr-pager" aria-label="分页">
            <span>
              第 {(current - 1) * PAGE_SIZE + 1}–
              {Math.min(current * PAGE_SIZE, filtered.length)} 组，共{" "}
              {filtered.length} 组
            </span>
            <span className="gr-pager-controls">
              <button
                type="button"
                className="secondary-button button-sm"
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
                className="secondary-button button-sm"
                disabled={current === pageCount}
                onClick={() => goto(current + 1)}
              >
                下一页
              </button>
            </span>
          </nav>
        )}
      </>
    );
  }

  return (
    <div className="gr" ref={root}>
      <ol className="gr-steps" role="tablist">
        {steps.map((item) => (
          <li
            key={item.step}
            role="tab"
            aria-selected={step === item.step}
            tabIndex={0}
            className={`is-${item.state} is-link${step === item.step ? " is-selected" : ""}`}
            onClick={() => onStep(item.step)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onStep(item.step);
              }
            }}
          >
            <span className="gr-step-dot">
              {item.state === "done"
                ? "✓"
                : item.state === "failed"
                  ? "!"
                  : item.step}
            </span>
            <span>
              <strong>
                {item.label}
                <em className="gr-by">{item.by}</em>
              </strong>
              <small title={item.value}>{item.value}</small>
            </span>
          </li>
        ))}
      </ol>

      {step === 1 && (
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
                {scan.stats?.similar ?? 0} 组 · 耗时 {scan.duration_ms ?? "—"}{" "}
                毫秒
              </p>
            </>
          ) : (
            <p className="gr-small">
              旧规则找出的候选 · 扫描 {scan.entity_count} 个实体。点第 2
              步的「重新检查」会按新规则重跑。
            </p>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="gr-method">
          <p>
            每组调用一次模型，判断组里哪些是同一个东西、统一叫什么。已判断{" "}
            <strong>
              {judged}/{scan.candidate_count}
            </strong>{" "}
            组{failed ? `，失败 ${failed} 组` : ""}
            {judging ? "，正在判断…" : "。"}
          </p>
          {report.prompt_tag && (
            <p className="gr-small">
              用的提示词：<code>{report.prompt_tag}</code>{" "}
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
          {judgeActions && <div className="gr-actions">{judgeActions}</div>}
        </div>
      )}

      {step === 3 && (
        <div className="gr-method">
          <p>
            只列出模型建议合并的组。每条点「合并」或「不合并」，随时可撤销。这里只记录决定，不会改图谱；全部看完去第
            4 步确认。
          </p>
        </div>
      )}

      {step <= 3 && renderList()}

      {step === 4 &&
        (confirmPanel ?? (
          <p className="graph-note">
            {plan.length
              ? `已批准的建议会合成 ${plan.length} 个合并结果。`
              : "还没有批准任何合并建议。"}
          </p>
        ))}

      {step === 5 && (
        <div className="gr-list">
          {report.status === "rewriting" && (
            <p className="gr-hint">正在按确认结果写入图谱（不调用模型）…</p>
          )}
          {report.applied ? (
            <p className="gr-small">
              上次写入：{report.applied.by} · {report.applied.at}，
              {report.applied.groups.length}{" "}
              个合并结果。之后补跑分片、重新写入时也会按这些合并。
            </p>
          ) : (
            report.status !== "rewriting" && (
              <p className="graph-note">
                还没有按确认结果写入过。图谱照常可用，合并是可选的。
              </p>
            )
          )}
          {records
            .filter((record) => record.status !== "skipped" || report.applied)
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
                    {record.status === "skipped"
                      ? "跳过"
                      : (statuses[record.status] ?? record.status)}
                  </Tag>
                </header>
                <p>由 {record.from_names?.join("、") || "—"} 合并</p>
                <p className="gr-small">
                  {record.mention_count ?? 0} 条名字出处 ·{" "}
                  {record.relation_count ?? 0} 条关系重新归属 ·{" "}
                  {record.type_corrections ?? 0} 处类型纠正
                </p>
                {record.reason && <p className="gr-reason">{record.reason}</p>}
              </article>
            ))}
        </div>
      )}

      {dialog && (
        <DetailDialog open title={dialog.title} onClose={() => setDialog(null)}>
          {dialog.body}
        </DetailDialog>
      )}
    </div>
  );
}

// 第 4 步「确认」的内容：已批准的建议按实际结果合起来；连在一起且名字不一致的，必须先选一个。
// 和上次已写入的对比，列出这次会撤掉的合并（结果只取决于现在批准了哪些）。
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
  if (groups.length === 0 && dropped.length === 0)
    return (
      <p className="graph-note">还没有批准任何合并建议，去第 3 步决定。</p>
    );
  return (
    <ol className="gr-plan">
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
                  <span className="gr-warn-inline">名字不一致，请选一个：</span>
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
  );
}

const ACTIVE = ["queued", "running", "rewriting"];

// 弹窗正文：读取最新报告；排队、判断、写入时自动刷新。图谱已经写好，这里的合并是可选的。
// 两处入口（实体关系、处理过程）共用。
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
  // 操作反馈统一走 Toast（AGENTS.md「前端交互约束 · 操作反馈」），弹窗里不再放错误横幅。
  const toast = useToast();
  const loadFailed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [poll, setPoll] = useState(0);
  const [step, setStep] = useState<ReviewStep | null>(null);
  useEffect(() => {
    let cancelled = false;
    getGraphReview(documentId)
      .then((value) => {
        if (!cancelled) {
          setData(value);
          loadFailed.current = false;
        }
      })
      .catch((reason) => {
        // 轮询时连续失败只提示一次。
        if (cancelled || loadFailed.current) return;
        loadFailed.current = true;
        toast("error", `读取二次检查失败：${errorText(reason)}`);
      });
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
    // 判断或写入刚结束：通知外面刷新（处理过程、实体关系页签）。
    if (wasActive.current && !active) onChanged?.();
    wasActive.current = active;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // 第一次拿到报告时决定停在哪一步，之后由用户切换。
  useEffect(() => {
    if (report?.scan && step === null) setStep(defaultStep(report));
  }, [report, step]);
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
  const failedCount = (live?.judgments ?? []).filter(
    (item) => item.status === "failed",
  ).length;

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      toast("error", errorText(reason));
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
    await run(async () => {
      const resolutions = Object.fromEntries(
        groups
          .filter((group) => group.options.length > 1)
          .map((group) => [group.key, choices[group.key]]),
      );
      await rewriteGraphReview(documentId, live.build_id, resolutions);
      toast("success", `已提交：按 ${groups.length} 个合并结果写入图谱`);
      setData(await getGraphReview(documentId));
      setStep(5);
      onChanged?.();
    });
  }

  async function retry() {
    await run(async () => {
      await retryGraphReview(documentId);
      toast("success", "已开始重新检查");
      setData(await getGraphReview(documentId));
      setStep(2);
      onChanged?.();
    });
  }

  async function retryFailed() {
    await run(async () => {
      await retryFailedGraphReview(documentId);
      toast("success", `已排队重试 ${failedCount} 组`);
      setData(await getGraphReview(documentId));
      onChanged?.();
    });
  }

  const showRetry =
    canRetry &&
    !!data?.can_confirm &&
    (!live || ["ready", "failed", "idle"].includes(live.status));

  // 已经有人工决定时，重新检查会把它们清掉，先在按钮旁边确认。
  const retryButton = showRetry && (
    <ConfirmPopover
      when={!!live?.decisions && Object.keys(live.decisions).length > 0}
      message="重新检查会清掉模型判断和你的决定（图谱上已写入的合并保留，直到下次写入）。"
      confirmText="重新检查"
      onConfirm={retry}
    >
      <button type="button" className="secondary-button" disabled={busy}>
        {busy
          ? "正在提交…"
          : live?.status === "idle" || !report
            ? "开始二次检查"
            : "重新检查"}
      </button>
    </ConfirmPopover>
  );

  const judgeActions =
    (canDecide && failedCount > 0) || showRetry ? (
      <>
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
        {retryButton}
      </>
    ) : null;

  const confirmPanel =
    report?.scan && canDecide ? (
      <div className="gr-confirm">
        <p className="gr-small">
          下面是写入后图谱上会有的合并：根据第 3
          步批准的建议整理，相关的几条会接成一个结果。
          和上次写入相比，「新增」会合并，「撤掉」会拆开。还有 {pending}{" "}
          条没处理，保持分开。
        </p>
        <MergePlan
          report={report}
          approved={approved}
          choices={choices}
          onChoose={(key, choice) =>
            setChoices((items) => ({ ...items, [key]: choice }))
          }
        />
        <div className="gr-actions">
          {unresolved.length > 0 && (
            <span className="gr-warn-inline">
              有 {unresolved.length} 个合并结果要先选名字
            </span>
          )}
          <ConfirmPopover
            message={`按 ${groups.length} 个合并结果写入图谱？从已保存的抽取结果重新写一遍，不调用模型。${pending > 0 ? `还有 ${pending} 条未处理，保持分开。` : ""}`}
            confirmText="写入图谱"
            onConfirm={rewrite}
          >
            <button
              type="button"
              className="primary-button"
              disabled={busy || unresolved.length > 0 || !canRewrite}
              title={canRewrite ? undefined : "还没有批准任何合并建议"}
            >
              {busy ? "正在提交…" : `确认，写入图谱（${groups.length} 个合并）`}
            </button>
          </ConfirmPopover>
        </div>
      </div>
    ) : undefined;

  return (
    <div className="gr-body">
      {/* 后台检查任务本身失败是状态，不是这次操作的反馈，留在弹窗里说明。 */}
      {live?.status === "failed" && (
        <p className="gr-warn">
          二次检查失败：{live.error ?? "未知原因"}，可以点「重新检查」再跑一次。
        </p>
      )}
      {report?.scan && step ? (
        <GraphReviewDetails
          report={report}
          step={step}
          onStep={setStep}
          onDecide={canDecide ? decide : undefined}
          busy={busy}
          judgeActions={judgeActions}
          confirmPanel={confirmPanel}
        />
      ) : (
        <>
          <p className="graph-note">
            {report?.status === "idle"
              ? "还没开始二次检查。图谱已经写好，不检查也能用。"
              : !data
                ? "正在读取…"
                : report || live
                  ? "排队等待二次检查，找出候选后自动显示过程…"
                  : "这次建图还没有二次检查记录。"}
          </p>
          {retryButton && <div className="gr-actions">{retryButton}</div>}
        </>
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
