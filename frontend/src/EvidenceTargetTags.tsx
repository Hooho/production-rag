import { useEffect, useState } from "react";
import { locateEvalEvidence } from "./api";
import { ChunkOriginalDialog, type ChunkOriginal } from "./ChunkOriginalDialog";
import { Tag } from "./Tag";

export type EvidenceTarget = {
  chunk_id?: string;
  title: string;
  position: number | null;
  quote: string;
};

export function EvidenceTargetTags({
  targets,
  number,
  buttonLabel,
}: {
  targets: EvidenceTarget[];
  number: number;
  buttonLabel?: string;
}) {
  const [selected, setSelected] = useState<EvidenceTarget | null>(null);
  const [original, setOriginal] = useState<ChunkOriginal | null>(null);
  useEffect(() => {
    if (!selected) return;
    const base: ChunkOriginal = {
      context: "target",
      label:
        selected.position == null ? "分片" : `第 ${selected.position + 1} 片`,
      sources: [],
      evidence: [{ number, text: selected.quote }],
    };
    if (selected.chunk_id) {
      setOriginal({ ...base, chunkId: selected.chunk_id });
      return;
    }
    let cancelled = false;
    setOriginal({ ...base, note: "正在读取原文分片…" });
    locateEvalEvidence([selected.quote])
      .then((data) => {
        if (cancelled) return;
        const chunk = data.items[0]?.chunks.find(
          (item) =>
            item.title === selected.title &&
            item.position === selected.position,
        );
        setOriginal(
          chunk
            ? {
                ...base,
                chunkId: chunk.chunk_id,
                sources: [
                  {
                    key: `${chunk.title}:${chunk.position}`,
                    id: base.label,
                    title: chunk.title,
                    heading: chunk.heading,
                    text: chunk.content,
                  },
                ],
              }
            : {
                ...base,
                note: "当前语料中找不到该目标分片，语料可能已更新或重新切分。",
              },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setOriginal({
            ...base,
            note: error instanceof Error ? error.message : "读取分片失败",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, number]);
  return (
    <>
      <div className="ag-call-param-values ag-evidence-target-tags">
        {targets.length === 0 && (
          <small className="ag-muted">记录中未保存目标分片</small>
        )}
        {targets.map((target) => (
          <Tag
            key={target.chunk_id ?? `${target.title}:${target.position}`}
            size="sm"
            tone="info"
            title="点击查看原文"
            onClick={() => setSelected(target)}
          >
            {buttonLabel ??
              (target.position == null
                ? "查看分片"
                : `第 ${target.position + 1} 片`)}
          </Tag>
        ))}
      </div>
      <ChunkOriginalDialog
        value={original}
        onClose={() => {
          setSelected(null);
          setOriginal(null);
        }}
      />
    </>
  );
}
