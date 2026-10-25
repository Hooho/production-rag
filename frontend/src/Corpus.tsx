import { useEffect, useRef, useState } from "react";
import { deleteEvalCorpus, getEvalCorpus, getEvalCorpusChunks, importEvalCorpus, listEvalCorpus, uploadEvalCorpus, type DocumentChunkPage, type EvalCorpusEntry, type EvalCorpusStatus } from "./api";
import { DocumentChunkCard } from "./DocumentChunkCard";
import { formatShortTime } from "./format";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { Tag } from "./Tag";
import type { Tone } from "./tags";
import "./Regression.css";
import "./Corpus.css";

// 评测语料库：评测检索的文档。上传 Markdown / 文本，发起评测时勾选用哪几份（不勾就是全部）。
// 初始语料（eval/seed/corpus）第一次打开时复制进来，和上传的一样，可以删。
// 每份可以看原文，导入后看分片（和知识库文档的「全部分块」同一个卡片）；没导入的可以点「导入」，不用等评测。
type ShowToast = (kind: "success" | "error", message: string) => void;
type View = "content" | "chunks" | null;

const STATUS: Record<EvalCorpusStatus, { label: string; tone: Tone; hint: string }> = {
  imported: { label: "已导入", tone: "success", hint: "评测账号里已经切好分片" },
  stale: { label: "内容改过", tone: "warning", hint: "分片还是旧内容的，点「导入」或下次评测开跑时重新导入" },
  not_imported: { label: "未导入", tone: "neutral", hint: "点「导入」，或下次评测开跑时导入" },
  importing: { label: "正在导入", tone: "info", hint: "正在切分、算向量、生成上下文说明" },
};
// 预览只显示开头这么多字，长文档点「显示全文」再展开。
const PREVIEW_CHARS = 3000;

export default function Corpus({ onToast }: { onToast: ShowToast }) {
  const [items, setItems] = useState<EvalCorpusEntry[] | null>(null);
  const [maxBytes, setMaxBytes] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [rejected, setRejected] = useState<{ filename: string; reason: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  async function refresh() {
    const data = await listEvalCorpus();
    setItems(data.items);
    setMaxBytes(data.max_bytes);
  }

  useEffect(() => {
    refresh().catch((reason: Error) => onToast("error", reason.message));
  }, []);

  // 有语料正在导入时每 3 秒刷新一次，导入完状态和分片数自动更新。
  const importing = (items ?? []).some((item) => item.status === "importing");
  useEffect(() => {
    if (!importing) return;
    const timer = window.setInterval(() => { refresh().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [importing]);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setRejected([]);
    try {
      const result = await uploadEvalCorpus(files);
      setRejected(result.rejected);
      if (result.added.length) onToast("success", `已上传 ${result.added.length} 份：${result.added.map((item) => `《${item.title}》`).join("、")}`);
      else onToast("error", "没有收下任何文件，原因见下面。");
      await refresh();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const totalChars = (items ?? []).reduce((sum, item) => sum + item.char_count, 0);

  return <div className="rg-root cp-root">
    <div className="rg-intro">
      <p>评测检索的文档。发起评测时勾选用哪几份，只导入、只检索勾选的；加一份新语料不会影响已有评测的结果。</p>
      <p>只收 UTF-8 编码的 .md、.txt，单个不超过 {maxBytes ? Math.round(maxBytes / 1024 / 1024) : 5} MB；标题用文件名，不能重名。</p>
      <input ref={input} type="file" accept=".md,.txt,text/markdown,text/plain" multiple hidden onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
      <button type="button" className="primary-button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? "正在上传…" : "上传语料"}</button>
    </div>
    {rejected.length > 0 && <div className="cp-rejected" role="alert">
      <strong>没有收下的文件</strong>
      <ul>{rejected.map((item, index) => <li key={index}>{item.reason}</li>)}</ul>
    </div>}
    {items === null ? <LoadingSkeleton label="正在加载评测语料库"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton>
      : items.length === 0 ? <div className="rg-empty">语料库是空的，先上传语料才能跑评测。</div>
      : <>
        <div className="cp-total">{items.length} 份 · 共 {totalChars.toLocaleString()} 字</div>
        <ul className="rg-sets">{items.map((item) => <CorpusItem key={item.id} item={item} busy={importing} onToast={onToast} onChanged={() => void refresh()} />)}</ul>
      </>}
  </div>;
}

function CorpusItem({ item, busy, onToast, onChanged }: { item: EvalCorpusEntry; busy: boolean; onToast: ShowToast; onChanged: () => void }) {
  const [view, setView] = useState<View>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const status = STATUS[item.status];
  const canImport = !item.missing && (item.status === "not_imported" || item.status === "stale");

  async function startImport() {
    setWorking(true);
    try {
      await importEvalCorpus(item.id);
      onChanged();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    setWorking(true);
    try {
      await deleteEvalCorpus(item.id);
      onToast("success", `已删除《${item.title}》`);
      onChanged();
    } catch (reason) {
      onToast("error", (reason as Error).message);
      setWorking(false);
    }
  }

  return <li className="cp-item">
    <div className="cp-head">
      <div className="cp-main">
        <span className="rg-set-name">{item.title}
          <Tag size="sm" tone={item.missing ? "danger" : status.tone} title={item.missing ? undefined : status.hint} className="is-after">{item.missing ? "文件不存在" : status.label}</Tag>
        </span>
        <span className="rg-set-meta">
          <span>{item.filename}</span>
          <span>{item.char_count.toLocaleString()} 字</span>
          {item.chunks !== null && <span>{item.chunks} 个分片</span>}
          <span>{item.created_by === "system" ? "初始语料" : `${item.created_by} 上传`} · {formatShortTime(item.created)}</span>
        </span>
        {item.import_error && <span className="cp-error">上次导入失败：{item.import_error}</span>}
      </div>
      <div className="rg-item-actions">
        {!confirming && <>
          {canImport && <button type="button" className="rg-link is-edit" disabled={busy || working} onClick={() => void startImport()}>导入</button>}
          <button type="button" className="rg-link is-edit" disabled={item.missing} aria-expanded={view === "content"} onClick={() => setView(view === "content" ? null : "content")}>{view === "content" ? "收起原文" : "原文"}</button>
          <button type="button" className="rg-link is-edit" disabled={item.status === "not_imported" || item.status === "importing"} title={item.status === "not_imported" ? "还没导入，先点「导入」" : undefined} aria-expanded={view === "chunks"} onClick={() => setView(view === "chunks" ? null : "chunks")}>{view === "chunks" ? "收起分片" : "分片"}</button>
        </>}
        {confirming
          ? <><button type="button" className="secondary-button" disabled={working} onClick={() => setConfirming(false)}>取消</button><button type="button" className="rg-danger" disabled={working} onClick={() => void remove()}>确认删除（评测账号里导入的这份也删掉）</button></>
          : <button type="button" className="rg-link" disabled={busy} onClick={() => setConfirming(true)}>删除</button>}
      </div>
    </div>
    {view === "content" && <ContentPreview item={item} onToast={onToast} />}
    {view === "chunks" && <ChunkList item={item} onToast={onToast} />}
  </li>;
}

function ContentPreview({ item, onToast }: { item: EvalCorpusEntry; onToast: ShowToast }) {
  const [content, setContent] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    getEvalCorpus(item.id).then((data) => setContent(data.content)).catch((reason: Error) => onToast("error", reason.message));
  }, [item.id]);

  return <div className="cp-preview">
    {content === null ? <span className="rg-muted">正在读取…</span> : <>
      <pre>{full || content.length <= PREVIEW_CHARS ? content : `${content.slice(0, PREVIEW_CHARS)}…`}</pre>
      {content.length > PREVIEW_CHARS && <button type="button" className="rg-link is-edit" onClick={() => setFull(!full)}>{full ? "只看开头" : `显示全文（${content.length.toLocaleString()} 字）`}</button>}
    </>}
  </div>;
}

// 分片列表：每页 10 片，卡片和知识库文档详情的「全部分块」一样（位置、上下文说明、内容、技术信息）。
function ChunkList({ item, onToast }: { item: EvalCorpusEntry; onToast: ShowToast }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(DocumentChunkPage & { stale: boolean }) | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setData(null);
    getEvalCorpusChunks(item.id, page).then(setData).catch((reason: Error) => onToast("error", reason.message));
  }, [item.id, page, item.chunks]);

  if (data === null) return <div className="cp-preview"><span className="rg-muted">正在读取分片…</span></div>;
  return <div className="cp-preview cp-chunks">
    <div className="cp-chunks-head">
      <span>共 {data.total} 片 · 平均 {data.average_length} 字{data.document.metadata?.chunk_size ? ` · 分片大小 ${data.document.metadata.chunk_size} / 重叠 ${data.document.metadata.overlap ?? "—"}` : ""}</span>
      {data.stale && <span className="cp-error">语料内容改过，下面是旧内容的分片</span>}
    </div>
    <div className="document-chunks-list">{data.chunks.map((chunk) => <DocumentChunkCard key={chunk.chunk_id} chunk={chunk} expanded={Boolean(expanded[chunk.chunk_id])} onToggle={() => setExpanded((items) => ({ ...items, [chunk.chunk_id]: !items[chunk.chunk_id] }))} />)}</div>
    {data.total_pages > 1 && <div className="cp-pager">
      <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page} / {data.total_pages} 页</span>
      <button type="button" className="secondary-button" disabled={page >= data.total_pages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </div>;
}
