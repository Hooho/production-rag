import { useEffect, useState } from "react";
import { getEvalChunkOriginal, type EvalChunkOriginal } from "./api";
import { DetailDialog } from "./DetailDialog";
import { evidenceRanges } from "./evidenceRanges";
import { SourceTag } from "./Tag";

export type ChunkOriginalSource = {
  key: string; id: string; title: string | null; heading: string | null; text: string;
  chunkId?: string | null; parts?: string[]; snapshotNote?: string; relevance?: number | null; low?: boolean;
};
export type ChunkOriginal = {
  label: string; chunkId?: string | null; note?: string; sources: ChunkOriginalSource[]; evidence: { number: number; text: string }[];
};

export function ChunkOriginalDialog({ value, onClose }: { value: ChunkOriginal | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ id: string; data?: EvalChunkOriginal; error?: string } | null>(null);
  const chunkId = value?.chunkId;
  useEffect(() => {
    if (!chunkId) return;
    let cancelled = false;
    getEvalChunkOriginal(chunkId).then((data) => {
      if (!cancelled) setLoaded({ id: chunkId, data });
    }).catch((error: unknown) => {
      if (!cancelled) setLoaded({ id: chunkId, error: error instanceof Error ? error.message : "读取分片失败，请关闭后重试" });
    });
    return () => { cancelled = true; };
  }, [chunkId]);
  if (!value) return null;
  const current = loaded?.id === chunkId ? loaded : null;
  const sources = chunkId ? current?.data ? [{ ...value.sources[0], key: chunkId, id: value.sources[0]?.id ?? value.label,
    chunkId, title: current.data.title, heading: current.data.heading, text: current.data.content,
    parts: [], snapshotNote: undefined, relevance: value.sources[0]?.chunkId === chunkId ? value.sources[0].relevance : undefined
  }] : [] : value.sources;
  return <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
      <p className="ag-muted">{value.evidence.length ? `对应证据 ${value.evidence.map((item) => item.number).join("、")}` : "非证据"}</p>
      {chunkId && !current?.data && <p role="status" className="ag-muted">{current?.error ?? "正在读取该分片原文…"}</p>}
      {value.note && <p role="status" className="ag-muted">{value.note}</p>}
      {value.evidence.map((item) => <blockquote key={item.number}>证据 {item.number}：{item.text}</blockquote>)}
      {sources.filter((source, index, all) => all.findIndex((other) => other.text === source.text) === index).map((item) => <section key={item.key}>
        <h4><SourceTag id={item.id} /> · {item.title ?? "来源资料"}</h4>{item.heading && <p>{item.heading}</p>}
        {value.chunkId && item.chunkId === value.chunkId && item.relevance != null && <p className="ag-muted">重排分 {item.relevance.toFixed(2)}{item.low ? "（较低）" : ""}</p>}
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

