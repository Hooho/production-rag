import { useEffect, useRef, useState } from "react";
import { getEvalChunkOriginal, type EvalChunkOriginal } from "./api";
import { ChunkOriginalText } from "./ChunkOriginalText";
import { DetailDialog } from "./DetailDialog";
import { evidenceRanges } from "./evidenceRanges";
import type { HighlightGroup } from "./HighlightedText";
import { SourceTag, Tag } from "./Tag";

export type ChunkOriginalSource = {
  key: string;
  id: string;
  title: string | null;
  heading: string | null;
  text: string;
  chunkId?: string | null;
  parts?: string[];
  snapshotNote?: string;
  relevance?: number | null;
  low?: boolean;
};
export type ChunkOriginal = {
  label: string;
  context?: "target";
  chunkId?: string | null;
  note?: string;
  sources: ChunkOriginalSource[];
  evidence: { number: number; text: string }[];
  // 打开原文时高亮的词（例如搜索框里输入的内容）。
  highlight?: string[];
};

export function ChunkOriginalDialog({
  value,
  onClose,
}: {
  value: ChunkOriginal | null;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    id: string;
    data?: EvalChunkOriginal[];
    error?: string;
  } | null>(null);
  const selected = useRef<HTMLElement>(null);
  const chunkId = value?.chunkId;
  const ids = chunkId
    ? [
        ...new Set([
          ...(value?.sources.flatMap((source) =>
            source.parts?.length
              ? source.parts
              : source.chunkId
                ? [source.chunkId]
                : [],
          ) ?? []),
          chunkId,
        ]),
      ]
    : [];
  const requestKey = JSON.stringify(ids);
  useEffect(() => {
    const chunkIds = JSON.parse(requestKey) as string[];
    if (!chunkIds.length) return;
    let cancelled = false;
    Promise.all(chunkIds.map(getEvalChunkOriginal))
      .then((data) => {
        if (!cancelled)
          setLoaded({
            id: requestKey,
            data: data.sort((a, b) => a.position - b.position),
          });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoaded({
            id: requestKey,
            error:
              error instanceof Error
                ? error.message
                : "读取分片失败，请关闭后重试",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);
  useEffect(() => {
    if (value?.context !== "target" && loaded?.id === requestKey)
      selected.current?.scrollIntoView({ block: "start" });
  }, [loaded, requestKey, chunkId, value?.context]);
  if (!value) return null;
  const current = loaded?.id === requestKey ? loaded : null;
  const target = value.context === "target";
  // 搜索词高亮：这次要看的名字用 entity 样式（浅蓝底 + 下划线）。
  const highlightGroups: HighlightGroup[] = value.highlight?.length
    ? [{ kind: "entity", texts: value.highlight }]
    : [];
  if (target)
    return (
      <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
        <div className="ag-target-original-content">
          {chunkId && !current?.data && (
            <p role="status" className="ag-muted">
              {current?.error ?? "正在读取原文分片…"}
            </p>
          )}
          {value.note && (
            <p role="status" className="ag-muted">
              {value.note}
            </p>
          )}
          {current?.data?.map((chunk) => (
            <ChunkOriginalText
              key={chunk.chunk_id}
              text={chunk.content}
              groups={highlightGroups}
            />
          ))}
          {!chunkId &&
            value.sources.map((source) => (
              <ChunkOriginalText
                key={source.key}
                text={source.text}
                groups={highlightGroups}
              />
            ))}
        </div>
      </DetailDialog>
    );
  return (
    <DetailDialog open title={`${value.label} · 原文`} onClose={onClose}>
      <p className="ag-muted">
        {value.evidence.length
          ? `对应计分项 ${value.evidence.map((item) => item.number).join("、")}`
          : "未关联计分项"}
      </p>
      {chunkId && !current?.data && (
        <p role="status" className="ag-muted">
          {current?.error ?? "正在读取原文分片…"}
        </p>
      )}
      {value.note && (
        <p role="status" className="ag-muted">
          {value.note}
        </p>
      )}
      {value.evidence.map((item) => (
        <blockquote key={item.number}>
          计分项 {item.number}：{item.text}
        </blockquote>
      ))}
      {current?.data && (
        <p className="ag-muted">
          虚线框标出各分片边界，已定位到{value.label}。
        </p>
      )}
      {current?.data?.map((chunk) => {
        const direct = value.sources.some(
          (source) => source.chunkId === chunk.chunk_id,
        );
        const hit =
          evidenceRanges(
            chunk.content,
            value.evidence.map((quote) => quote.text),
          ).length > 0;
        return (
          <section
            key={chunk.chunk_id}
            ref={chunk.chunk_id === chunkId ? selected : undefined}
            className={`ag-original-chunk ${direct ? "is-retrieved" : "is-extended"} ${chunk.chunk_id === chunkId ? "is-selected" : ""}`}
            aria-label={`第 ${chunk.position + 1} 片`}
          >
            <div className="ag-original-chunk-heading">
              <strong>第 {chunk.position + 1} 片</strong>
              <Tag
                size="sm"
                tone={direct ? "info" : "accent"}
                outline={!direct}
                className={direct ? undefined : "is-dashed"}
              >
                {direct
                  ? hit
                    ? "检索命中"
                    : "检索返回"
                  : hit
                    ? "扩展命中"
                    : "扩展返回"}
              </Tag>
              {chunk.chunk_id === chunkId && <span>当前查看</span>}
            </div>
            <h4>{chunk.title ?? "来源资料"}</h4>
            {chunk.heading && <p className="ag-muted">{chunk.heading}</p>}
            {value.sources.find((source) => source.chunkId === chunk.chunk_id)
              ?.relevance != null && (
              <p className="ag-muted">
                重排分{" "}
                {value.sources
                  .find((source) => source.chunkId === chunk.chunk_id)
                  ?.relevance?.toFixed(2)}
              </p>
            )}
            <ChunkOriginalText
              text={chunk.content}
              evidenceHint={false}
              groups={[
                {
                  kind: "evidence",
                  texts: value.evidence.map((quote) => quote.text),
                },
              ]}
            />
          </section>
        );
      })}
      {!chunkId &&
        value.sources.map((item) => (
          <section key={item.key}>
            <h4>
              <SourceTag id={item.id} /> · {item.title ?? "来源资料"}
            </h4>
            {item.heading && <p>{item.heading}</p>}
            {item.snapshotNote && (
              <p className="ag-muted">{item.snapshotNote}</p>
            )}
            <ChunkOriginalText
              text={item.text}
              evidenceHint={false}
              groups={[
                {
                  kind: "evidence",
                  texts: value.evidence.map((quote) => quote.text),
                },
              ]}
            />
          </section>
        ))}
    </DetailDialog>
  );
}
