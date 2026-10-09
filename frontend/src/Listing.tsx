import { Fragment, useEffect, useState, type ReactNode } from "react";
import { getDocumentProblems, listDocument, submitDocumentReview, unlistDocument, type DocumentProblems, type DocumentStatus, type ProblemChunk } from "./api";
import { formatShortTime } from "./format";
import "./Listing.css";

// 文档上架：上传完不直接生效，处理完停在「待上架」，上传者确认后上架才进入检索；上架后可以下架。
// 安全扫描发现疑似注入指令的版本不能上架：这里列出有问题的分片，在原文上标出命中的地方，
// 上传者可以改好后重新上传，或者写明情况提交管理员审核。

type ShowToast = (kind: "success" | "error", message: string) => void;

const LISTING_LABELS = { listed: "已上架", unlisted: "已下架", never: "还没上架" };

export function ListingPanel({ document, isAdmin, onToast, onChanged, onUploadVersion, onSelectVersion }: { document: DocumentStatus; isAdmin: boolean; onToast: ShowToast; onChanged: () => Promise<void>; onUploadVersion: () => void; onSelectVersion: (documentId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const listing = document.listing ?? "listed";
  const status = document.status;
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
      onToast("success", success);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (document.can_edit === false) return null;
  // 看的是当前版本时，提示还有一个更新的版本在等上架或处理。
  const waiting = document.is_current ? (document.versions ?? []).find((version) => !version.is_current && version.version > (document.version ?? 1) && /^(staged|flagged|review):/.test(version.status)) : undefined;
  const publicNeedsReview = document.visibility === "public" && !isAdmin;
  let body = null;
  if (status.startsWith("staged:")) {
    body = <>
      <p>这一版已经处理完，安全扫描没有发现问题。{publicNeedsReview ? "这是公开文档，点上架后先交给管理员审核，通过后才替换当前版本。" : document.is_current ? "" : "上架后才会被检索到。"}</p>
      <div className="lt-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => listDocument(document.document_id), publicNeedsReview ? "已提交管理员审核，通过后上架。" : "已上架，下一次检索就能用到。")}>{publicNeedsReview ? "上架（提交审核）" : "上架"}</button></div>
    </>;
  } else if (status.startsWith("flagged:")) {
    body = <FlaggedVersion document={document} isAdmin={isAdmin} busy={busy}
      onList={(note) => void run(() => listDocument(document.document_id, note), "已上架，备注已记录在文档审核里。")}
      onSubmit={(note) => void run(() => submitDocumentReview(document.document_id, note), "已提交管理员审核，通过后上架。")}
      onUploadVersion={onUploadVersion} />;
  } else if (status.startsWith("review:")) {
    const note = document.version_review?.request_note;
    body = <p>这一版正在等管理员审核（{formatShortTime(document.version_review?.created)} 提交）{note ? `，你的说明：「${note}」` : ""}。通过后自动上架。</p>;
  } else if (status === "rejected") {
    body = <p>这一版没有通过审核：{document.version_review?.note ?? document.error ?? "没有填写原因"}。请修改后重新上传。<button type="button" className="link-text" onClick={onUploadVersion}>上传新版本</button></p>;
  } else if (document.is_current) {
    body = <>
      <p>{listing === "listed" ? "这一版正在被检索使用。下架后谁都检索不到（包括你自己），版本保留，可以随时重新上架。" : "文档已下架，谁都检索不到。重新上架不用再扫描。"}</p>
      <div className="lt-actions">{listing === "listed" ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => unlistDocument(document.document_id), "已下架，检索不到这份文档了。")}>下架</button> : <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => listDocument(document.document_id), "已重新上架。")}>重新上架</button>}</div>
    </>;
  }
  // 看的不是当前版本时，单独标出这一版的状态，和整份文档的上架状态区分开。
  const versionState = document.is_current ? "" : status.startsWith("staged:") ? "待上架" : status.startsWith("flagged:") ? "扫描有问题" : status.startsWith("review:") ? "待管理员审核" : status === "rejected" ? "审核未通过" : "";
  const tone = status.startsWith("flagged:") || status === "rejected" ? "is-danger" : status.startsWith("staged:") || status.startsWith("review:") ? "is-waiting" : listing === "listed" ? "is-listed" : "is-unlisted";
  return <section className={`lt-panel ${tone}`}>
    <header><strong>上架状态</strong><span className={`lt-badge is-${listing}`}>文档{LISTING_LABELS[listing]}</span>{versionState && <span className={`lt-badge is-version ${tone}`}>这一版：{versionState}</span>}</header>
    {body}
    {waiting && <p className="lt-waiting">v{waiting.version} {waiting.status.startsWith("flagged:") ? "安全扫描有问题，需要处理" : waiting.status.startsWith("review:") ? "正在等管理员审核" : "已处理完，等待上架"}。<button type="button" className="link-text" onClick={() => onSelectVersion(waiting.document_id)}>去查看</button></p>}
  </section>;
}

// 扫描有问题的版本：说明为什么不能上架、列出有问题的分片，以及两种处理方式。
function FlaggedVersion({ document, isAdmin, busy, onList, onSubmit, onUploadVersion }: { document: DocumentStatus; isAdmin: boolean; busy: boolean; onList: (note: string) => void; onSubmit: (note: string) => void; onUploadVersion: () => void }) {
  const [data, setData] = useState<DocumentProblems | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [adminNote, setAdminNote] = useState("");
  useEffect(() => {
    getDocumentProblems(document.document_id).then(setData).catch((reason: Error) => setError(reason.message));
  }, [document.document_id]);
  const scan = data?.scan ?? document.document_metadata?.injection_scan;
  return <>
    <p className="lt-alert">安全扫描发现疑似注入指令，这一版不能上架{scan ? `（规则命中 ${scan.rule_hits} 处，注入检测模型命中 ${scan.model_hits} 处）` : ""}。文档里藏的指令会被当成资料交给模型，可能让回答被带偏。请检查下面标出的原文：</p>
    {error && <div className="field-error">{error}</div>}
    {data && <ProblemChunks chunks={data.chunks} />}
    <div className="lt-resolve">
      <div className="lt-option">
        <strong>改好后重新上传</strong>
        <small>删掉或改写标出的内容，作为新版本上传，会重新扫描。</small>
        <button type="button" className="secondary-button" onClick={onUploadVersion}>上传新版本</button>
      </div>
      {/* 管理员自己就是审核人，不显示「提交审核」，用下面的「直接上架」。 */}
      {!isAdmin && <div className="lt-option">
        <strong>内容没有问题，提交管理员审核</strong>
        <small>例如这是一篇讲提示注入的文章，命中的内容是在举例。写明情况，管理员看过后决定是否上架。</small>
        <textarea value={note} rows={2} maxLength={300} placeholder="说明为什么这些内容没有问题" onChange={(event) => setNote(event.target.value)} />
        <button type="button" className="primary-button" disabled={busy || !note.trim()} onClick={() => onSubmit(note.trim())}>提交审核</button>
      </div>}
      {isAdmin && <div className="lt-option">
        <strong>内容没有问题，直接上架</strong>
        <small>你是管理员，看过内容确认没问题可以直接上架。备注会记成一条审核记录，之后在「文档审核 › 已处理」里能查到。</small>
        <textarea value={adminNote} rows={2} maxLength={300} placeholder="必填：说明为什么这些内容没有问题" onChange={(event) => setAdminNote(event.target.value)} />
        <button type="button" className="primary-button" disabled={busy || !adminNote.trim()} onClick={() => onList(adminNote.trim())}>直接上架</button>
      </div>}
    </div>
  </>;
}

// 有问题的分片：在原文上标出规则命中的地方；模型判断为攻击的分片没有具体位置，标出整段和攻击概率。
export function ProblemChunks({ chunks }: { chunks: ProblemChunk[] }) {
  if (chunks.length === 0) return <p className="lt-empty">没有找到有问题的分片（可能是旧版本没有记录扫描结果）。</p>;
  return <div className="lt-problems">{chunks.map((chunk) => <article key={chunk.chunk_id} className={`lt-chunk ${chunk.model_score !== null && chunk.model_score !== undefined && chunk.spans.length === 0 ? "is-whole" : ""}`}>
    <header>
      <span>第 {chunk.position} 片{chunk.heading_path.length > 0 && ` · ${chunk.heading_path.join(" / ")}`}{chunk.page_start ? ` · 第 ${chunk.page_start} 页` : ""}</span>
      <span className="lt-tags">{[...new Set(chunk.spans.map((span) => span.label))].map((label) => <em key={label}>规则：{label}</em>)}{chunk.model_score !== null && chunk.model_score !== undefined && <em className="is-model">模型判断为攻击 {chunk.model_score.toFixed(2)}</em>}</span>
    </header>
    <p><HighlightedText text={chunk.content} spans={chunk.spans} /></p>
  </article>)}</div>;
}

// 把命中位置标成 <mark>；重叠的位置合并成一段。
function HighlightedText({ text, spans }: { text: string; spans: ProblemChunk["spans"] }) {
  const merged: { start: number; end: number; labels: string[] }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (!last.labels.includes(span.label)) last.labels.push(span.label);
    } else merged.push({ start: span.start, end: span.end, labels: [span.label] });
  }
  const parts: ReactNode[] = [];
  let position = 0;
  merged.forEach((span, index) => {
    if (span.start > position) parts.push(<Fragment key={`t${index}`}>{text.slice(position, span.start)}</Fragment>);
    parts.push(<mark key={`m${index}`} title={span.labels.join("、")}>{text.slice(span.start, span.end)}</mark>);
    position = span.end;
  });
  if (position < text.length) parts.push(<Fragment key="rest">{text.slice(position)}</Fragment>);
  return <>{parts}</>;
}
