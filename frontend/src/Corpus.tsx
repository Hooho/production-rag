import { useEffect, useRef, useState } from "react";
import { deleteEvalCorpus, getEvalCorpus, listEvalCorpus, uploadEvalCorpus, type EvalCorpusEntry, type EvalCorpusStatus } from "./api";
import { formatShortTime } from "./format";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { Tag } from "./Tag";
import type { Tone } from "./tags";
import "./Regression.css";
import "./Corpus.css";

// 评测语料库：评测检索的文档。上传 Markdown / 文本，发起评测时勾选用哪几份（不勾就是全部）。
// 初始语料（eval/seed/corpus）第一次打开时复制进来，和上传的一样，可以删。
type ShowToast = (kind: "success" | "error", message: string) => void;

const STATUS: Record<EvalCorpusStatus, { label: string; tone: Tone; hint: string }> = {
  imported: { label: "已导入", tone: "success", hint: "评测账号里已经切好分片" },
  stale: { label: "内容改过", tone: "warning", hint: "下次评测开跑时重新导入" },
  not_imported: { label: "未导入", tone: "neutral", hint: "下次评测开跑时导入" },
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
        <ul className="rg-sets">{items.map((item) => <CorpusItem key={item.id} item={item} onToast={onToast} onDeleted={() => void refresh()} />)}</ul>
      </>}
  </div>;
}

function CorpusItem({ item, onToast, onDeleted }: { item: EvalCorpusEntry; onToast: ShowToast; onDeleted: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = STATUS[item.status];

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content !== null) return;
    try {
      setContent((await getEvalCorpus(item.id)).content);
    } catch (reason) {
      setOpen(false);
      onToast("error", (reason as Error).message);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteEvalCorpus(item.id);
      onToast("success", `已删除《${item.title}》`);
      onDeleted();
    } catch (reason) {
      onToast("error", (reason as Error).message);
      setBusy(false);
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
          {item.status === "imported" && item.chunks !== null && <span>{item.chunks} 个分片</span>}
          <span>{item.created_by === "system" ? "初始语料" : `${item.created_by} 上传`} · {formatShortTime(item.created)}</span>
        </span>
      </div>
      <div className="rg-item-actions">
        {!confirming && <button type="button" className="rg-link is-edit" onClick={() => void toggle()} aria-expanded={open} disabled={item.missing}>{open ? "收起" : "查看"}</button>}
        {confirming
          ? <><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button><button type="button" className="rg-danger" disabled={busy} onClick={() => void remove()}>确认删除（评测账号里导入的这份也删掉）</button></>
          : <button type="button" className="rg-link" onClick={() => setConfirming(true)}>删除</button>}
      </div>
    </div>
    {open && <div className="cp-preview">
      {content === null ? <span className="rg-muted">正在读取…</span> : <>
        <pre>{full || content.length <= PREVIEW_CHARS ? content : `${content.slice(0, PREVIEW_CHARS)}…`}</pre>
        {content.length > PREVIEW_CHARS && <button type="button" className="rg-link is-edit" onClick={() => setFull(!full)}>{full ? "只看开头" : `显示全文（${content.length.toLocaleString()} 字）`}</button>}
      </>}
    </div>}
  </li>;
}
