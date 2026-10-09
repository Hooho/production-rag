import { useEffect, useState } from "react";
import { approveDocumentReview, getDocumentReview, getDocumentReviews, rejectDocumentReview, type DocumentReviewDetail, type DocumentReviewList, type DocumentVisibility } from "./api";
import { formatShortTime } from "./format";
import { ProblemChunks } from "./Listing";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./DocumentReviews.css";

// 文档审核（只有管理员）：普通用户申请公开、公开文档上传的新版本都在这里审核，通过后才对所有人生效。
// 公开文档会进入所有人的检索结果，里面藏的注入指令会影响所有人，所以要看过内容再通过。
// 详情列出分片正文和注入规则的检查结果；规则只认常见写法，没命中不代表安全，还是要看一遍正文。

type ShowToast = (kind: "success" | "error", message: string) => void;
type ListStatus = "pending" | "done";

const RULE_LABELS: Record<string, string> = { override: "要求忽略原有指令", prompt_leak: "索取系统提示词", role_play: "越狱或改变身份", fake_role: "伪造对话角色标记" };
const VISIBILITY_LABELS: Record<DocumentVisibility, string> = { private: "仅自己", shared: "指定部门", public: "所有人" };

// 列表里标题右侧的类型标签（简短）；完整说明在详情里。
const KIND_TAGS: Record<string, string> = { publish: "申请公开", version: "公开文档新版本", flagged: "扫描有问题", share: "共享文档可疑" };

// reviewId 为空时显示列表，点一条进入详情页（/maintenance/reviews/<id>），详情页可以返回列表。
export default function DocumentReviews({ reviewId, onNavigate, onToast }: { reviewId: string | null; onNavigate: (path: string) => void; onToast: ShowToast }) {
  if (reviewId) {
    return <div className="dr-page">
      <button type="button" className="dr-back" onClick={() => onNavigate("/maintenance/reviews")}>‹ 返回审核列表</button>
      <ReviewDetail key={reviewId} reviewId={reviewId} onToast={onToast} onDecided={async () => onNavigate("/maintenance/reviews")} />
    </div>;
  }
  return <ReviewList onOpen={(id) => onNavigate(`/maintenance/reviews/${encodeURIComponent(id)}`)} />;
}

function ReviewList({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<ListStatus>("pending");
  const [list, setList] = useState<DocumentReviewList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setList(null);
    getDocumentReviews(status).then((result) => { setList(result); setError(""); }).catch((reason: Error) => setError(reason.message));
  }, [status]);
  return <div className="dr-page">
    <p className="dr-subtitle">文档上传后先做安全扫描，没问题的自动上架。三种情况要在这里审核：普通用户申请公开（公开文档进入所有人的检索结果，里面藏的注入指令会影响所有人）；公开文档的新版本；安全扫描发现疑似注入指令、上传者说明情况后提交的版本。审核期间文档保持原来的可见范围，旧版本继续服务。管理员上传的文档不需要审核。</p>
    <section className="dr-card">
      <div className="dr-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={status === "pending"} className={status === "pending" ? "is-active" : ""} onClick={() => setStatus("pending")}>待审核{list && <small>{list.pending}</small>}</button>
        <button type="button" role="tab" aria-selected={status === "done"} className={status === "done" ? "is-active" : ""} onClick={() => setStatus("done")}>已处理</button>
      </div>
      {error && <div className="field-error">{error}</div>}
      {!list && !error && <LoadingSkeleton label="正在加载审核列表"><SkeletonBlock className="dr-skeleton" /></LoadingSkeleton>}
      {list && (list.items.length === 0 ? <div className="dr-empty">{status === "pending" ? "没有待审核的文档" : "还没有处理过的审核"}</div> : <div className="dr-list">
        {list.items.map((item) => <button type="button" key={item.id} className="dr-item" onClick={() => onOpen(item.id)}>
          <span className="dr-item-copy">
            <strong>{item.title}<em>v{item.version ?? 1}</em><span className={`dr-kind is-${item.kind}`}>{KIND_TAGS[item.kind] ?? item.kind_label}</span></strong>
            <small>{item.owner} 上传 · {formatShortTime(item.created)} 提交 · 现在{VISIBILITY_LABELS[item.visibility] ?? item.visibility}可见{item.chunk_count ? ` · ${item.chunk_count} 段` : ""}{item.request_note ? ` · 说明：${item.request_note}` : ""}</small>
          </span>
          {status === "done" && <span className={`dr-status is-${item.status}`} title={item.request_note ?? item.note ?? ""}>{item.requested_by === item.reviewed_by && item.status === "approved" ? "管理员直接上架" : item.status_label}{item.reviewed_by ? ` · ${item.reviewed_by}` : ""}</span>}
          <span className="dr-arrow">›</span>
        </button>)}
      </div>)}
    </section>
  </div>;
}

// 一条审核的详情：说明审核什么、注入规则的检查结果、分页的分片正文，以及通过 / 不通过。
function ReviewDetail({ reviewId, onToast, onDecided }: { reviewId: string; onToast: ShowToast; onDecided: () => Promise<void> }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DocumentReviewDetail | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getDocumentReview(reviewId, page).then((result) => { setData(result); setError(""); }).catch((reason: Error) => setError(reason.message));
  }, [reviewId, page]);

  const decide = async (action: "approve" | "reject") => {
    if (!data) return;
    setBusy(true);
    try {
      // 带上看到的版本：上传者在这期间又更新了文档，接口会拒绝，需要重新看过。
      if (action === "approve") await approveDocumentReview(reviewId, data.document?.document_id);
      else await rejectDocumentReview(reviewId, note.trim());
      onToast("success", action === "reject" ? "已标记为不通过，上传者会看到原因。" : data.review.kind === "publish" ? "已通过，文档现在所有人可见。" : "已通过，新版本已替换当前版本。");
      await onDecided();
    } catch (reason) {
      onToast("error", (reason as Error).message);
      setData(await getDocumentReview(reviewId, page).catch(() => data));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <section className="dr-card"><div className="field-error">{error}</div></section>;
  if (!data) return <section className="dr-card"><LoadingSkeleton label="正在加载审核内容"><SkeletonBlock className="dr-skeleton" /></LoadingSkeleton></section>;
  const { review, document, chunks } = data;
  const problemPositions = new Set((data.problems?.chunks ?? []).map((chunk) => chunk.position));
  const pageSize = chunks?.page_size ?? 10;
  const replaces = data.current_version ? `替换当前的第 ${data.current_version} 版` : "这是第一版，通过后才对其他人可见";
  const what = review.kind === "publish" ? `申请把可见范围从「${VISIBILITY_LABELS[data.visibility] ?? data.visibility}」改成所有人` : review.kind === "version" ? `公开文档的新版本 · ${replaces}` : `安全扫描发现疑似注入指令，上传者说明后提交 · ${replaces}`;
  const scan = data.problems?.scan;
  const problemCount = data.problems?.chunks.length ?? 0;
  const decided = `${review.status_label}${review.reviewed_by ? ` · ${review.reviewed_by}` : ""}${review.reviewed ? ` · ${formatShortTime(review.reviewed)}` : ""}${review.note ? ` · ${review.note}` : ""}`;
  return <section className="dr-card dr-detail">
    <header className="dr-detail-head">
      <h2>{document?.title ?? "文档"}{document && <em>v{document.version}</em>}</h2>
      <p>{what}{document && ` · ${document.owner} 上传 · ${document.filename}`}{document?.version_note ? ` · 版本说明：${document.version_note}` : ""}</p>
    </header>
    {review.request_note && <p className="dr-request-note">上传者的说明：「{review.request_note}」</p>}
    <div className={`dr-injection ${problemCount > 0 ? "is-hit" : ""}`}>
      <p>{scan ? `安全扫描检查了 ${scan.checked} 个分片：规则命中 ${scan.rule_hits} 处，注入检测模型命中 ${scan.model_hits} 处${scan.model ? `（${scan.model}）` : scan.model_error ? `（模型没参与：${scan.model_error}）` : "（没有注入检测模型）"}。` : "这一版没有安全扫描记录（升级前上传的）。"}{problemCount > 0 ? "有问题的分片和命中的原文如下：" : "规则和模型只认常见写法，没命中不代表安全，请看一遍正文。"}</p>
    </div>
    {data.problems && problemCount > 0 && <ProblemChunks chunks={data.problems.chunks} />}
    {chunks && <div className="dr-chunks">
      <div className="dr-chunks-head"><strong>全部分片正文</strong><span>{chunks.total_pages > 0 ? `第 ${chunks.page} / ${chunks.total_pages} 页 · ` : ""}共 {chunks.total} 片</span></div>
      {chunks.chunks.map((chunk) => <article key={chunk.chunk_id} className={`dr-chunk ${problemPositions.has(chunk.position) ? "is-hit" : ""}`}>
        <header>第 {chunk.position} 片{chunk.heading_path.length > 0 && ` · ${chunk.heading_path.join(" / ")}`}{problemPositions.has(chunk.position) && <em>扫描有问题</em>}</header>
        <p>{chunk.content}</p>
      </article>)}
      {chunks.total_pages > 1 && <div className="dr-pager">
        <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <button type="button" className="secondary-button" disabled={page >= chunks.total_pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>}
    </div>}
    {data.can_decide ? <div className="dr-actions">
      <textarea value={note} rows={2} maxLength={300} placeholder="不通过时填写原因，上传者会在文档详情里看到" onChange={(event) => setNote(event.target.value)} />
      <div className="dr-buttons">
        <button type="button" className="secondary-button" disabled={busy || !note.trim()} onClick={() => void decide("reject")}>不通过</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("approve")}>{busy ? "处理中…" : review.kind === "publish" ? "通过，设为所有人可见" : "通过，替换当前版本"}</button>
      </div>
    </div> : <p className="dr-blocked">{review.status === "pending" ? data.blocked_reason : decided}</p>}
  </section>;
}
