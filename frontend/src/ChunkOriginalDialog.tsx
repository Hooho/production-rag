import { useEffect, useRef, type ReactNode } from "react";
import { SourceTag } from "./Tag";

export type ChunkOriginalSource = {
  key: string; id: string; title: string | null; heading: string | null; text: string;
  parts?: string[]; snapshotNote?: string; relevance?: number | null; low?: boolean;
};
export type ChunkOriginal = {
  label: string; sources: ChunkOriginalSource[]; evidence: { number: number; text: string }[];
};

// 原文和推理全文共用右侧弹窗，保留原生对话框的焦点管理与 Escape 关闭。
export function DetailDialog({ open, title, onClose, children, className = "" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} className={`ag-delivery-dialog ${className}`} aria-label={title} onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="ag-delivery-dialog-head"><strong>{title}</strong>
      <button type="button" className="secondary-button" autoFocus onClick={() => dialog.current?.close()}>关闭</button></div>
    {children}
  </dialog>;
}

export function ChunkOriginalDialog({ value, onClose }: { value: ChunkOriginal | null; onClose: () => void }) {
  if (!value) return null;
  return <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
      <p className="ag-muted">{value.evidence.length ? `对应证据 ${value.evidence.map((item) => item.number).join("、")}` : "非证据"}</p>
      {value.evidence.map((item) => <blockquote key={item.number}>证据 {item.number}：{item.text}</blockquote>)}
      {value.sources.filter((source, index, all) => all.findIndex((other) => other.text === source.text) === index).map((item) => <section key={item.key}>
        <h4><SourceTag id={item.id} /> · {item.title ?? "来源资料"}</h4>{item.heading && <p>{item.heading}</p>}
        {item.relevance != null && <p className="ag-muted">来源重排分 {item.relevance.toFixed(2)}{item.low ? "（较低）" : ""}</p>}
        {(item.parts?.length ?? 0) > 1 && <p className="ag-muted">以下为包含该分片的交付原文（含相邻分片）。</p>}
        {item.snapshotNote && <p className="ag-muted">{item.snapshotNote}</p>}
        <OriginalText text={item.text} evidence={value.evidence.map((quote) => quote.text)} />
      </section>)}
    </DetailDialog>;
}

function OriginalText({ text, evidence }: { text: string; evidence: string[] }) {
  const ranges: [number, number][] = [];
  for (const quote of evidence) {
    if (!quote) continue;
    let start = text.indexOf(quote);
    while (start >= 0) {
      ranges.push([start, start + quote.length]);
      start = text.indexOf(quote, start + quote.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let end = 0;
  return <div className="ag-delivery-text">{merged.map(([start, to]) => {
    const prefix = text.slice(end, start);
    end = to;
    return <span key={start}>{prefix}<mark>{text.slice(start, to)}</mark></span>;
  })}{text.slice(end)}</div>;
}

