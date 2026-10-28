import { useEffect, useRef, useState } from "react";
import { getEvalChunkOriginal, type EvalChunkOriginal } from "./api";
import { DetailDialog } from "./DetailDialog";
import { evidenceRanges } from "./evidenceRanges";
import { SourceTag, Tag } from "./Tag";

export type ChunkOriginalSource = {
  key: string; id: string; title: string | null; heading: string | null; text: string;
  chunkId?: string | null; parts?: string[]; snapshotNote?: string; relevance?: number | null; low?: boolean;
};
export type ChunkOriginal = {
  label: string; context?: "target"; chunkId?: string | null; note?: string; sources: ChunkOriginalSource[]; evidence: { number: number; text: string }[];
};

export function ChunkOriginalDialog({ value, onClose }: { value: ChunkOriginal | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ id: string; data?: EvalChunkOriginal[]; error?: string } | null>(null);
  const selected = useRef<HTMLElement>(null);
  const chunkId = value?.chunkId;
  const ids = chunkId ? [...new Set([...(value?.sources.flatMap((source) => source.parts?.length ? source.parts : source.chunkId ? [source.chunkId] : []) ?? []), chunkId])] : [];
  const requestKey = JSON.stringify(ids);
  useEffect(() => {
    const chunkIds = JSON.parse(requestKey) as string[];
    if (!chunkIds.length) return;
    let cancelled = false;
    Promise.all(chunkIds.map(getEvalChunkOriginal)).then((data) => {
      if (!cancelled) setLoaded({ id: requestKey, data: data.sort((a, b) => a.position - b.position) });
    }).catch((error: unknown) => {
      if (!cancelled) setLoaded({ id: requestKey, error: error instanceof Error ? error.message : "读取分片失败，请关闭后重试" });
    });
    return () => { cancelled = true; };
  }, [requestKey]);
  useEffect(() => {
    if (loaded?.id === requestKey) selected.current?.scrollIntoView({ block: "start" });
  }, [loaded, requestKey, chunkId]);
  if (!value) return null;
  const current = loaded?.id === requestKey ? loaded : null;
  const target = value.context === "target";
  return <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
      <p className="ag-muted">{value.evidence.length ? `对应${target ? "计分项" : "证据"} ${value.evidence.map((item) => item.number).join("、")}` : "非证据"}</p>
      {chunkId && !current?.data && <p role="status" className="ag-muted">{current?.error ?? "正在读取原文分片…"}</p>}
      {value.note && <p role="status" className="ag-muted">{value.note}</p>}
      {!target && value.evidence.map((item) => <blockquote key={item.number}>证据 {item.number}：{item.text}</blockquote>)}
      {current?.data && <p className="ag-muted">虚线框标出各分片边界，已定位到{value.label}。</p>}
      {current?.data?.map((chunk) => {
        const direct = value.sources.some((source) => source.chunkId === chunk.chunk_id);
        const hit = evidenceRanges(chunk.content, value.evidence.map((quote) => quote.text)).length > 0;
        return <section key={chunk.chunk_id} ref={chunk.chunk_id === chunkId ? selected : undefined}
        className={`ag-original-chunk ${target ? "is-target" : direct ? "is-retrieved" : "is-extended"} ${chunk.chunk_id === chunkId ? "is-selected" : ""}`} aria-label={`第 ${chunk.position + 1} 片`}>
        <div className="ag-original-chunk-heading"><strong>第 {chunk.position + 1} 片</strong>{!target && <Tag size="sm" tone={direct ? "info" : "accent"} outline={!direct} className={direct ? undefined : "is-dashed"}>{direct ? (hit ? "检索命中" : "检索返回") : (hit ? "扩展命中" : "扩展返回")}</Tag>}{chunk.chunk_id === chunkId && <span>当前查看</span>}</div>
        <h4>{chunk.title ?? "来源资料"}</h4>{chunk.heading && <p className="ag-muted">{chunk.heading}</p>}
        {value.sources.find((source) => source.chunkId === chunk.chunk_id)?.relevance != null && <p className="ag-muted">重排分 {value.sources.find((source) => source.chunkId === chunk.chunk_id)?.relevance?.toFixed(2)}</p>}
        <OriginalText text={chunk.content} evidence={target ? [] : value.evidence.map((quote) => quote.text)} />
      </section>;
      })}
      {!chunkId && value.sources.map((item) => <section key={item.key}>
        <h4><SourceTag id={item.id} /> · {item.title ?? "来源资料"}</h4>{item.heading && <p>{item.heading}</p>}
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

