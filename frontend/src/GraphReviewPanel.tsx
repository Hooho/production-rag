import { useEffect, useState } from "react";
import {
  confirmGraphReview,
  getGraphReview,
  retryGraphReview,
  type GraphReviewReport,
} from "./api";
import { DetailDialog } from "./DetailDialog";

const statuses: Record<string, string> = {
  prepared: "已生成方案，待写入",
  running: "处理中",
  completed: "完成",
  pending: "待开始",
  failed: "失败",
  skipped: "未执行",
};

export function GraphReviewDetails({
  report,
  approved = [],
  onApproval,
}: {
  report: GraphReviewReport;
  approved?: string[];
  onApproval?: (ids: string[]) => void;
}) {
  const [source, setSource] = useState<{ title: string; text: string } | null>(
    null,
  );
  const entities = new Map(
    report.scan.candidates.flatMap((candidate) =>
      candidate.entities.map((item) => [item.id, item] as const),
    ),
  );
  return (
    <div className="graph-review-details">
      <details>
        <summary>
          1. 找出疑似重复或类型冲突的候选 ·{" "}
          {statuses[report.scan.status] ?? report.scan.status}
        </summary>
        <p>
          扫描 {report.scan.entity_count} 个实体，找到{" "}
          {report.scan.candidate_count} 组候选 · 耗时{" "}
          {report.scan.duration_ms ?? "—"} 毫秒。
        </p>
        {report.scan.candidates.map((candidate) => (
          <details key={candidate.id}>
            <summary>
              候选组 {candidate.id} ·{" "}
              {candidate.entities
                .map((item) => item.names.join(" / "))
                .join("、")}
            </summary>
            <p>{candidate.reason}</p>
            {candidate.entities.map((item) => (
              <div key={item.id}>
                <strong>
                  {item.names.join(" / ")}（{item.types.join("、")}）
                </strong>
                <p>{item.descriptions.join("；")}</p>
                {item.evidence.map((evidence) => (
                  <details key={evidence.chunk_id}>
                    <summary>原文依据片段 · {evidence.chunk_id}</summary>
                    <p className="graph-chunk-text">{evidence.text}</p>
                  </details>
                ))}
              </div>
            ))}
          </details>
        ))}
      </details>
      <details open>
        <summary>
          2. 模型判断 · 已返回{" "}
          {report.judgments.filter((item) => item.status !== "running").length}/
          {report.scan.candidate_count} 组
        </summary>
        {report.judgments.map((judgment) => (
          <details
            key={judgment.candidate_id}
            open={judgment.status === "failed"}
          >
            <summary>
              候选组 {judgment.candidate_id} ·{" "}
              {statuses[judgment.status] ?? judgment.status}
            </summary>
            <small>
              耗时 {judgment.duration_ms ?? "—"} 毫秒 · Token 输入{" "}
              {judgment.input_tokens ?? "—"}，输出{" "}
              {judgment.output_tokens ?? "—"}
            </small>
            {judgment.error && (
              <p className="field-error">
                {judgment.error}。此组不执行自动合并。
              </p>
            )}
            {judgment.decision?.groups.map((group, index) => {
              const id = `${judgment.candidate_id}:${index}`;
              return (
                <div className="graph-review-proposal" key={id}>
                  <strong>
                    {group.ids
                      .map((key) => entities.get(key)?.names.join(" / ") ?? key)
                      .join("、")}{" "}
                    → {group.name}（{group.type}）
                  </strong>
                  <p>{group.reason}</p>
                  {onApproval ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={approved.includes(id)}
                        onChange={(event) =>
                          onApproval(
                            event.target.checked
                              ? [...approved, id]
                              : approved.filter((key) => key !== id),
                          )
                        }
                      />
                      确认此项合并及类型调整
                    </label>
                  ) : (
                    <small>
                      {report.approved_ids?.includes(id)
                        ? "人工已批准"
                        : "未批准，不执行"}
                    </small>
                  )}
                </div>
              );
            })}
            {judgment.decision?.separate_reason && (
              <p>保持分开的依据：{judgment.decision.separate_reason}</p>
            )}
            {judgment.prompt && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setSource({
                    title: "二次检查完整提示词",
                    text: judgment
                      .prompt!.map(
                        (item) => `【${item.role}】\n${item.content}`,
                      )
                      .join("\n\n"),
                  })
                }
              >
                完整提示词
              </button>
            )}
            {judgment.raw_output != null && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setSource({
                    title: "二次检查模型原始输出",
                    text: judgment.raw_output!,
                  })
                }
              >
                模型原始输出
              </button>
            )}
          </details>
        ))}
      </details>
      <details open>
        <summary>
          3. 人工确认 ·{" "}
          {report.scan.candidate_count === 0
            ? "无需确认"
            : report.approved_by
              ? "已确认"
              : report.status === "awaiting_review"
                ? "等待确认"
                : report.scan.candidate_count === 0
                  ? "无需确认"
                  : "等待模型判断"}
        </summary>
        <p>
          {report.approved_by
            ? `确认人：${report.approved_by} · ${report.approved_at ?? ""}`
            : "仅执行人工勾选批准的建议，未勾选的保持分开。模型失败或证据不足的组不会合并。"}
        </p>
      </details>
      {report.status === "awaiting_review" && !onApproval && (
        <p className="graph-note">
          上传者或管理员可在文档「实体关系」页签勾选并确认合并建议。
        </p>
      )}
      <details>
        <summary>
          4. 合并实体 ·{" "}
          {statuses[report.execution.status] ?? report.execution.status}
        </summary>
        <p>只有确认后的方案才会执行；写入图谱完成后新图才生效。</p>
        {report.execution.records.map((record) => (
          <p key={record.id}>
            <strong>
              {record.name}（{record.type}） · {statuses[record.status]}
            </strong>{" "}
            · {record.from_names?.join("、")} · {record.mention_count ?? 0}{" "}
            条名字出处 · {record.relation_count ?? 0} 条关系重新归属 ·{" "}
            {record.type_corrections ?? 0} 处类型纠正 · {record.reason}
          </p>
        ))}
      </details>
      {source && (
        <DetailDialog open title={source.title} onClose={() => setSource(null)}>
          <pre className="graph-prompt">{source.text}</pre>
        </DetailDialog>
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
  const [data, setData] = useState<Awaited<
    ReturnType<typeof getGraphReview>
  > | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
  const report = data?.report?.build_id === buildId ? data.report : null;
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
      if (retry) {
        await retryGraphReview(documentId);
        setOpen(true);
      } else await confirmGraphReview(documentId, buildId, approved);
      setApproved([]);
      setData(await getGraphReview(documentId));
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="graph-review-panel">
        <strong>二次检查合并</strong>
        <span className="graph-note">
          {!report
            ? "旧图尚未执行"
            : report.status === "awaiting_review"
              ? "等待人工确认"
              : report.status === "completed"
                ? "已完成"
                : "处理中"}
        </span>
        {report && (
          <button
            type="button"
            className="link-button"
            onClick={() => setOpen(true)}
          >
            {report.status === "awaiting_review" ? "查看并确认" : "查看过程"}
          </button>
        )}
        {canRetry && data?.can_confirm && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            {busy ? "正在提交…" : report ? "重新检查" : "补跑二次检查"}
          </button>
        )}
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </div>
      {open && (
        <DetailDialog open title="二次检查合并" onClose={() => setOpen(false)}>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {report ? (
            <GraphReviewDetails
              report={report}
              approved={approved}
              onApproval={
                report.status === "awaiting_review" &&
                data?.can_confirm &&
                !busy
                  ? setApproved
                  : undefined
              }
            />
          ) : (
            <p className="graph-note">已排队，候选识别完成后自动显示过程。</p>
          )}
          {report?.status === "awaiting_review" && data?.can_confirm && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy
                ? "正在提交…"
                : `确认并继续（批准 ${approved.length} 项，其余不合并）`}
            </button>
          )}
        </DetailDialog>
      )}
    </>
  );
}
