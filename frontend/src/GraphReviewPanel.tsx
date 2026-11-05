import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  confirmGraphReview,
  getGraphReview,
  retryGraphReview,
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
type Verdict = "merge" | "separate" | "failed" | "running";
type Filter = "all" | Verdict | "checked";

const verdicts: Record<Verdict, { label: string; tone: Tone }> = {
  merge: { label: "建议合并", tone: "info" },
  separate: { label: "保持分开", tone: "neutral" },
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

function entityName(entity: Entity | undefined, fallback: string) {
  return entity ? entity.names.join(" / ") : fallback;
}

// 二次检查的过程和结果：顶部是四步进度和统计，下面按候选组逐张卡片展示（候选实体 + 模型结论 + 勾选），分页浏览。
// 传了 onApproval 就是可确认模式：每条合并建议前有勾选框。
export function GraphReviewDetails({
  report,
  approved = [],
  onApproval,
}: {
  report: GraphReviewReport;
  approved?: string[];
  onApproval?: (ids: string[]) => void;
}) {
  const [dialog, setDialog] = useState<{
    title: string;
    body: ReactNode;
  } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"groups" | "execution">("groups");
  const root = useRef<HTMLDivElement>(null);
  function goto(next: number) {
    setPage(next);
    root.current?.scrollIntoView({ block: "start" });
  }

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
  const rows = useMemo(
    () =>
      report.scan.candidates.map((candidate) => {
        const judgment = judgments.get(candidate.id);
        const ids = (judgment?.decision?.groups ?? []).map(
          (_, index) => `${candidate.id}:${index}`,
        );
        return { candidate, judgment, verdict: verdictOf(judgment), ids };
      }),
    [report.scan.candidates, judgments],
  );
  const counts = useMemo(() => {
    const value: Record<Filter, number> = {
      all: rows.length,
      merge: 0,
      separate: 0,
      failed: 0,
      running: 0,
      checked: 0,
    };
    for (const row of rows) {
      value[row.verdict] += 1;
      if (row.ids.some((id) => approved.includes(id))) value.checked += 1;
    }
    return value;
  }, [rows, approved]);
  const allProposals = rows.flatMap((row) => row.ids);
  const keyword = query.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      (filter === "all" ||
        (filter === "checked"
          ? row.ids.some((id) => approved.includes(id))
          : row.verdict === filter)) &&
      (!keyword ||
        row.candidate.id.toLowerCase() === keyword ||
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
  const pageProposals = visible.flatMap((row) => row.ids);

  useEffect(() => setPage(1), [filter, query]);

  function toggle(ids: string[], on: boolean) {
    if (!onApproval) return;
    const rest = approved.filter((key) => !ids.includes(key));
    onApproval(on ? [...rest, ...ids] : rest);
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

  function openText(title: string, text: string) {
    setDialog({ title, body: <pre className="graph-prompt">{text}</pre> });
  }

  const judged = report.judgments.filter(
    (item) => item.status !== "running",
  ).length;
  const confirmState =
    report.scan.candidate_count === 0
      ? "无需确认"
      : report.approved_by
        ? "已确认"
        : report.status === "awaiting_review"
          ? "等待确认"
          : "等待模型判断";
  const steps: {
    label: string;
    by: string;
    value: string;
    state: "done" | "active" | "todo" | "failed";
  }[] = [
    {
      label: "找出候选",
      by: "系统规则",
      value: `${report.scan.candidate_count} 组`,
      state:
        report.scan.status === "completed"
          ? "done"
          : report.scan.status === "failed"
            ? "failed"
            : "active",
    },
    {
      label: "模型判断",
      by: "大模型",
      value: `${judged}/${report.scan.candidate_count}`,
      state: judged >= report.scan.candidate_count ? "done" : "active",
    },
    {
      label: "人工确认",
      by: "人工",
      value: confirmState,
      state:
        report.approved_by || report.scan.candidate_count === 0
          ? "done"
          : report.status === "awaiting_review"
            ? "active"
            : "todo",
    },
    {
      label: "合并实体",
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
              <small>{step.value}</small>
            </span>
          </li>
        ))}
      </ol>
      <p className="gr-meta">
        系统按名字规则扫描 {report.scan.entity_count}{" "}
        个实体（名字相同或一个包含另一个就归为一组，不调用模型）· 找到{" "}
        {report.scan.candidate_count} 组候选 · 耗时{" "}
        {report.scan.duration_ms ?? "—"} 毫秒
        {report.approved_by &&
          ` · 确认人 ${report.approved_by} ${report.approved_at ?? ""}`}
      </p>

      {report.execution.records.length > 0 && (
        <div className="gr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "groups"}
            onClick={() => setView("groups")}
          >
            候选组 {rows.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "execution"}
            onClick={() => setView("execution")}
          >
            合并结果 {report.execution.records.length}
          </button>
        </div>
      )}

      {view === "execution" && report.execution.records.length > 0 ? (
        <div className="gr-list">
          {report.execution.records.map((record) => (
            <article className="gr-card" key={record.id}>
              <header className="gr-card-head">
                <strong>
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
              <p className="gr-merge-from">
                由 {record.from_names?.join("、") || "—"} 合并
              </p>
              <p className="gr-small">
                {record.mention_count ?? 0} 条名字出处 ·{" "}
                {record.relation_count ?? 0} 条关系重新归属 ·{" "}
                {record.type_corrections ?? 0} 处类型纠正
              </p>
              {record.reason && <p className="gr-reason">{record.reason}</p>}
            </article>
          ))}
        </div>
      ) : (
        <>
          <div className="gr-toolbar">
            <div
              className="gr-filters"
              role="group"
              aria-label="按模型结论筛选"
            >
              {(
                [
                  ["all", "全部"],
                  ["merge", "建议合并"],
                  ["separate", "保持分开"],
                  ["failed", "失败"],
                  ["running", "判断中"],
                  ...(onApproval || approved.length
                    ? [["checked", "已勾选"]]
                    : []),
                ] as [Filter, string][]
              )
                .filter(
                  ([key]) =>
                    key === "all" || key === "checked" || counts[key] > 0,
                )
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {label} <span>{counts[key]}</span>
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

          {onApproval && allProposals.length > 0 && (
            <div className="gr-bulk">
              <span>
                已勾选 <strong>{approved.length}</strong> /{" "}
                {allProposals.length} 条合并建议
              </span>
              <button
                type="button"
                className="link-button"
                disabled={pageProposals.length === 0}
                onClick={() => toggle(pageProposals, true)}
              >
                勾选本页
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => toggle(allProposals, true)}
              >
                全部勾选
              </button>
              <button
                type="button"
                className="link-button"
                disabled={approved.length === 0}
                onClick={() => onApproval([])}
              >
                清空
              </button>
            </div>
          )}

          <div className="gr-list">
            {visible.length === 0 && (
              <p className="graph-note">没有符合条件的候选组。</p>
            )}
            {visible.map(({ candidate, judgment, verdict }) => (
              <article className={`gr-card is-${verdict}`} key={candidate.id}>
                <header className="gr-card-head">
                  <span className="gr-card-id">#{candidate.id}</span>
                  <span className="gr-card-reason">
                    系统规则：{candidate.reason}
                  </span>
                  <Tag size="sm" dot tone={verdicts[verdict].tone}>
                    {verdicts[verdict].label}
                  </Tag>
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

                {judgment?.error && (
                  <p className="field-error">
                    {judgment.error}。此组不执行自动合并。
                  </p>
                )}

                {judgment?.decision?.groups.map((group, index) => {
                  const id = `${candidate.id}:${index}`;
                  const checked =
                    approved.includes(id) ||
                    (!onApproval && !!report.approved_ids?.includes(id));
                  return (
                    <label
                      className={`gr-proposal ${checked ? "is-checked" : ""}`}
                      key={id}
                    >
                      {onApproval ? (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            toggle([id], event.target.checked)
                          }
                        />
                      ) : (
                        <Tag size="sm" tone={checked ? "success" : "neutral"}>
                          {checked
                            ? "已批准"
                            : report.approved_by
                              ? "未批准"
                              : "待确认"}
                        </Tag>
                      )}
                      <span>
                        <span className="gr-proposal-line">
                          {group.ids
                            .map((key) => entityName(entities.get(key), key))
                            .join(" + ")}
                          <span className="gr-arrow">→</span>
                          <strong>{group.name}</strong>
                          <Tag size="sm" hue>
                            {group.type}
                          </Tag>
                        </span>
                        {group.reason && (
                          <span className="gr-reason">{group.reason}</span>
                        )}
                      </span>
                    </label>
                  );
                })}

                {judgment?.decision?.separate_reason && (
                  <p className="gr-reason">
                    保持分开：{judgment.decision.separate_reason}
                  </p>
                )}

                {judgment && (
                  <footer className="gr-card-foot">
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
                  </footer>
                )}
              </article>
            ))}
          </div>

          {filtered.length > PAGE_SIZE && (
            <nav className="gr-pager" aria-label="候选组分页">
              <span>
                第 {(current - 1) * PAGE_SIZE + 1}–
                {Math.min(current * PAGE_SIZE, filtered.length)} 组，共{" "}
                {filtered.length} 组
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

// 弹窗正文：读取最新报告；等待确认时可逐组勾选，底部固定一条确认栏。文档「实体关系」和「处理过程」两处共用。
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
  const [approved, setApproved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setApproved([]);
  }, [buildId]);
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

  async function submit(retry = false) {
    if (busy) return;
    if (
      !retry &&
      !window.confirm(
        `执行勾选的 ${approved.length} 项合并建议？其余建议保持分开。`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (retry) await retryGraphReview(documentId);
      else await confirmGraphReview(documentId, live!.build_id, approved);
      setApproved([]);
      setData(await getGraphReview(documentId));
      onChanged?.();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
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
          逐组看模型的合并建议，勾选同意的项，再点底部「确认并合并」。没勾选的保持分开；判断失败的组不会合并。
        </p>
      )}
      {report ? (
        <GraphReviewDetails
          report={report}
          approved={approved}
          onApproval={canConfirm && !busy ? setApproved : undefined}
        />
      ) : data ? (
        <p className="graph-note">已排队，候选识别完成后自动显示过程。</p>
      ) : (
        <p className="graph-note">正在读取…</p>
      )}
      {(canConfirm || (canRetry && data?.can_confirm)) && (
        <div className="gr-footer">
          {canRetry && data?.can_confirm && !canConfirm && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? "正在提交…" : report ? "重新检查" : "补跑二次检查"}
            </button>
          )}
          {canConfirm && (
            <>
              <span>
                已勾选 <strong>{approved.length}</strong> 项，其余保持分开
              </span>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "正在提交…" : `确认并合并（${approved.length} 项）`}
              </button>
            </>
          )}
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
