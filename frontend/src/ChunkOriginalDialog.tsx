import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { evidenceRanges } from "./evidenceRanges";
import { SourceTag } from "./Tag";

export type ChunkOriginalSource = {
  key: string; id: string; title: string | null; heading: string | null; text: string;
  chunkId?: string | null; parts?: string[]; snapshotNote?: string; relevance?: number | null; low?: boolean;
};
export type ChunkOriginal = {
  label: string; chunkId?: string | null; note?: string; sources: ChunkOriginalSource[]; evidence: { number: number; text: string }[];
};

const dialogTriggers = new WeakMap<HTMLDialogElement, HTMLElement>();

// 从弹窗内打开详情时，左右并排显示，并用箭头连接到触发入口。
export function DetailDialog({ open, title, onClose, children, className = "" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const arrowId = useId();
  const [connector, setConnector] = useState<{ from: number; to: number; y: number } | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) {
      if (element?.open) element.close();
      return;
    }
    const parent = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).filter((item) => item !== element).at(-1);
    const trigger = parent ? dialogTriggers.get(parent) : null;
    const companion = parent && trigger ? parent : null;
    const previousScroll = companion?.scrollTop ?? 0;
    if (companion) {
      companion.classList.add("ag-dialog-has-companion");
      element.classList.add("ag-dialog-companion");
      trigger?.classList.add("ag-dialog-anchor");
      if (trigger) {
        const anchor = trigger.getBoundingClientRect();
        const bounds = companion.getBoundingClientRect();
        if (anchor.bottom > bounds.bottom - 24) companion.scrollTop += anchor.bottom - bounds.bottom + 24;
        else if (anchor.top < bounds.top + 24) companion.scrollTop -= bounds.top + 24 - anchor.top;
      }
    }
    if (!element.open) element.showModal();
    function updateConnector() {
      if (!companion || !trigger || !element) return;
      const anchor = trigger.getBoundingClientRect();
      const container = companion.getBoundingClientRect();
      const panel = element.getBoundingClientRect();
      const y = anchor.top + anchor.height / 2;
      setConnector(anchor.bottom > container.top && anchor.top < container.bottom && panel.right < anchor.left
        ? { from: panel.right, to: anchor.left - 5, y } : null);
    }
    updateConnector();
    window.addEventListener("resize", updateConnector);
    companion?.addEventListener("scroll", updateConnector, true);
    return () => {
      window.removeEventListener("resize", updateConnector);
      companion?.removeEventListener("scroll", updateConnector, true);
      companion?.classList.remove("ag-dialog-has-companion");
      if (companion) companion.scrollTop = previousScroll;
      element.classList.remove("ag-dialog-companion");
      trigger?.classList.remove("ag-dialog-anchor");
      setConnector(null);
    };
  }, [open]);
  return <dialog ref={dialog} onClickCapture={(event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button, a, summary") : null;
    if (target && target.closest("dialog") === event.currentTarget) dialogTriggers.set(event.currentTarget, target);
  }} className={`ag-delivery-dialog ${className}`} aria-label={title} onClose={(event) => { event.stopPropagation(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    {connector && <svg className="ag-dialog-connector" aria-hidden="true">
      <defs><marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="currentColor" /></marker></defs>
      <path d={`M ${connector.from} ${connector.y} H ${connector.to}`} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${arrowId})`} />
    </svg>}
    <div className="ag-delivery-dialog-head"><strong>{title}</strong>
      <button type="button" className="secondary-button" autoFocus onClick={() => dialog.current?.close()}>关闭</button></div>
    {children}
  </dialog>;
}

export function ChunkOriginalDialog({ value, onClose }: { value: ChunkOriginal | null; onClose: () => void }) {
  if (!value) return null;
  return <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
      <p className="ag-muted">{value.evidence.length ? `对应证据 ${value.evidence.map((item) => item.number).join("、")}` : "非证据"}</p>
      {value.note && <p role="status" className="ag-muted">{value.note}</p>}
      {value.evidence.map((item) => <blockquote key={item.number}>证据 {item.number}：{item.text}</blockquote>)}
      {value.sources.filter((source, index, all) => all.findIndex((other) => other.text === source.text) === index).map((item) => <section key={item.key}>
        <h4><SourceTag id={item.id} /> · {item.title ?? "来源资料"}</h4>{item.heading && <p>{item.heading}</p>}
        {value.chunkId && item.chunkId === value.chunkId && item.relevance != null && <p className="ag-muted">重排分 {item.relevance.toFixed(2)}{item.low ? "（较低）" : ""}</p>}
        {(item.parts?.length ?? 0) > 1 && <p className="ag-muted">以下为包含该分片的交付原文（含相邻分片）。</p>}
        {item.snapshotNote && <p className="ag-muted">{item.snapshotNote}</p>}
        <OriginalText text={item.text} evidence={value.evidence.map((quote) => quote.text)} />
      </section>)}
    </DetailDialog>;
}

function OriginalText({ text, evidence }: { text: string; evidence: string[] }) {
  const ranges = evidenceRanges(text, evidence);
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

