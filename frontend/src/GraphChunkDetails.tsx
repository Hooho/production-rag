import { useEffect, useState } from "react";
import {
  listDocumentChunks,
  type ChunkGraphStatus,
  type DocumentChunkPage,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { Tag } from "./Tag";

const FILTERS: [ChunkGraphStatus | null, string][] = [
  [null, "全部"],
  ["extracted", "成功"],
  ["reused", "复用"],
  ["failed", "失败"],
  ["pending", "待返回"],
  ["empty", "无实体"],
];

export function GraphChunkDetails({
  documentId,
  buildId,
  tick,
  busy,
  onClose,
  onOpenChunk,
}: {
  documentId: string;
  buildId: string;
  tick: number;
  busy: boolean;
  onClose: () => void;
  onOpenChunk: (chunkId: string, position: number) => void;
}) {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<ChunkGraphStatus | null>(null);
  const [data, setData] = useState<DocumentChunkPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sourceDetail, setSourceDetail] = useState<{
    title: string;
    text: string;
    original: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDocumentChunks(documentId, page, 10, null, filter)
      .then((value) => {
        if (cancelled) return;
        if (value.graph?.build_id !== buildId) {
          setError("建图记录已切换，请关闭后重新打开详情。");
          return;
        }
        if (page > Math.max(1, value.total_pages)) {
          setPage(Math.max(1, value.total_pages));
          return;
        }
        setData(value);
        setError("");
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, buildId, page, filter, tick, busy]);
  return (
    <DetailDialog
      open
      title="分片抽取详情"
      onClose={onClose}
      className="graph-chunk-dialog"
    >
      <p className="graph-note">
        {data?.graph?.schema_name} · {data?.graph?.model} ·{" "}
        {data?.graph?.prompt_tag}
      </p>
      <div className="graph-chunk-filters" aria-label="抽取状态筛选">
        {FILTERS.map(([value, label]) => (
          <button
            type="button"
            key={label}
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setPage(1);
              setData(null);
            }}
          >
            {label}
            {value && data?.graph_counts ? ` ${data.graph_counts[value]}` : ""}
          </button>
        ))}
      </div>
      {busy && (
        <p className="graph-note">
          建图中，结果自动刷新；待返回包括尚未开始和正在抽取的分片。每片返回后更新结果。
        </p>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p className="graph-note">正在读取分片…</p>
      ) : (
        <>
          <div className="graph-chunk-results" aria-busy={loading}>
            {data.chunks.map((chunk) => {
              const graph = chunk.graph;
              const failed = graph?.status === "failed";
              const label = !graph
                ? "待返回"
                : failed
                  ? "失败"
                  : graph.status === "reused"
                    ? "复用"
                    : "成功";
              return (
                <details className="graph-chunk-result" key={chunk.chunk_id}>
                  <summary>
                    <strong>第 {chunk.position + 1} 片</strong>
                    <Tag
                      size="sm"
                      tone={failed ? "danger" : graph ? "success" : "neutral"}
                    >
                      {label}
                    </Tag>
                    <span>
                      {failed
                        ? graph.error || "未记录失败原因"
                        : graph
                          ? `${graph.mentions.length} 个实体 · ${graph.relations.length} 条关系`
                          : "尚未记录抽取结果"}
                    </span>
                  </summary>
                  <div className="graph-chunk-result-body">
                    {failed ? (
                      <p className="field-error">
                        失败原因：{graph.error || "未记录失败原因"}
                      </p>
                    ) : graph ? (
                      <>
                        <h4>实体（{graph.mentions.length}）</h4>
                        {graph.mentions.length ? (
                          <ul>
                            {graph.mentions.map((item, index) => (
                              <li key={index}>
                                <strong>{item.name}</strong> · {item.type}
                                {item.canonical && item.canonical !== item.name
                                  ? ` → ${item.canonical}`
                                  : ""}
                                {item.description && (
                                  <small>{item.description}</small>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="graph-note">
                            本片抽取成功，没有抽出实体。
                          </p>
                        )}
                        <h4>关系（{graph.relations.length}）</h4>
                        {graph.relations.length ? (
                          <ul>
                            {graph.relations.map((item, index) => (
                              <li key={index}>
                                <strong>
                                  {item.source} → {item.target}
                                </strong>{" "}
                                · {item.category}
                                <small>{item.description}</small>
                                {item.evidence && (
                                  <blockquote>{item.evidence}</blockquote>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="graph-note">没有抽出关系。</p>
                        )}
                      </>
                    ) : (
                      <p className="graph-note">
                        尚未返回结果，不能判断成功或失败。
                      </p>
                    )}
                    {graph && (
                      <p className="graph-note">
                        {graph.status === "reused"
                          ? "复用已有结果"
                          : `Token：输入 ${graph.input_tokens ?? "—"} · 输出 ${graph.output_tokens ?? "—"}`}
                        {graph.duration_ms != null
                          ? ` · 耗时 ${(graph.duration_ms / 1000).toFixed(1)} 秒`
                          : ""}
                      </p>
                    )}
                    <div className="graph-chunk-source-actions">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          setSourceDetail({
                            title: `第 ${chunk.position + 1} 片 · 分片原文`,
                            text: chunk.content,
                            original: true,
                          })
                        }
                      >
                        分片原文
                      </button>
                      {graph?.prompt && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            setSourceDetail({
                              title: `第 ${chunk.position + 1} 片 · 完整提示词`,
                              text: graph
                                .prompt!.map(
                                  (message) =>
                                    `【${message.role}】\n${message.content}`,
                                )
                                .join("\n\n"),
                              original: false,
                            })
                          }
                        >
                          发给模型的完整提示词
                        </button>
                      )}
                      {graph?.raw_output != null && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            setSourceDetail({
                              title: `第 ${chunk.position + 1} 片 · 模型原始输出`,
                              text: graph.raw_output!,
                              original: false,
                            })
                          }
                        >
                          模型原始输出
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        onClose();
                        onOpenChunk(chunk.chunk_id, chunk.position);
                      }}
                    >
                      在分块列表中查看
                    </button>
                  </div>
                </details>
              );
            })}
          </div>
          {data.chunks.length === 0 && (
            <p className="graph-note">没有符合当前状态的分片。</p>
          )}
          <div className="graph-pager">
            <span>
              共 {data.total} 片 · 第 {page} / {Math.max(1, data.total_pages)}{" "}
              页
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={loading || page <= 1}
              onClick={() => {
                setPage(page - 1);
                setData(null);
              }}
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={loading || page >= data.total_pages}
              onClick={() => {
                setPage(page + 1);
                setData(null);
              }}
            >
              下一页
            </button>
          </div>
        </>
      )}
      {sourceDetail && (
        <DetailDialog
          open
          title={sourceDetail.title}
          onClose={() => setSourceDetail(null)}
        >
          {sourceDetail.original ? (
            <p className="graph-chunk-text">{sourceDetail.text}</p>
          ) : (
            <pre className="graph-prompt">{sourceDetail.text}</pre>
          )}
        </DetailDialog>
      )}
    </DetailDialog>
  );
}
