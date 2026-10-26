import { useEffect, useState } from "react";
import { locateEvalEvidence } from "./api";
import { ChunkOriginalDialog, type ChunkOriginal } from "./ChunkOriginalDialog";

export type EvidenceChunkSelection = { chunkId: string; label: string; evidence: { number: number; text: string } };

// 只按记录中的分片 ID 打开原文，语料重新切分后不把其他分片冒充成历史分片。
export function EvidenceChunkDialog({ selection, onClose }: { selection: EvidenceChunkSelection; onClose: () => void }) {
  const [value, setValue] = useState<ChunkOriginal>({ label: selection.label, evidence: [selection.evidence], sources: [], note: "正在加载分片原文…" });
  useEffect(() => {
    let cancelled = false;
    locateEvalEvidence([selection.evidence.text]).then((data) => {
      if (cancelled) return;
      const chunk = data.items[0]?.chunks.find((item) => item.chunk_id === selection.chunkId);
      setValue({ label: selection.label, evidence: [selection.evidence],
        sources: chunk ? [{ key: selection.chunkId, id: selection.label, title: chunk.title, heading: chunk.heading, text: chunk.content }] : [],
        note: chunk ? undefined : "当前语料中找不到该证据分片，语料可能已更新或重新切分。"
      });
    }).catch((error: unknown) => {
      if (!cancelled) setValue({ label: selection.label, evidence: [selection.evidence], sources: [], note: error instanceof Error ? error.message : "加载分片失败，请关闭后重试。" });
    });
    return () => { cancelled = true; };
  }, [selection]);
  return <ChunkOriginalDialog value={value} onClose={onClose} />;
}
