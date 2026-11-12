import Table from "./Table";
import { useEffect, useId, useState } from "react";
import {
  listDocumentChunks,
  type ChunkGraph,
  type ChunkGraphStatus,
  type DocumentChunkPage,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { HighlightedText } from "./HighlightedText";
import { Tag } from "./Tag";

const FILTERS: [ChunkGraphStatus | null, string][] = [
  [null, "全部"],
  ["extracted", "成功"],
  ["reused", "复用"],
  ["failed", "失败"],
  ["pending", "未处理"],
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
    evidence?: string;
    // 关系原文里要高亮的起点、终点名字
    names?: string[];
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
        <span role="status">{loading && data ? " · 正在更新…" : ""}</span>
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
            }}
          >
            {value === "pending" && busy ? "处理中" : label}
            {value && data?.graph_counts ? ` ${data.graph_counts[value]}` : ""}
          </button>
        ))}
      </div>
      {busy && (
        <p className="graph-note">
          建图中，结果自动刷新；处理中包括排队等待和正在抽取的分片。每片完成后更新结果。
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
              const processing = !graph && busy;
              const label = !graph
                ? processing
                  ? "处理中"
                  : "未处理"
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
                      tone={
                        failed
                          ? "danger"
                          : graph
                            ? "success"
                            : processing
                              ? "info"
                              : "neutral"
                      }
                    >
                      {processing && (
                        <span
                          className="graph-chunk-spinner"
                          aria-hidden="true"
                        />
                      )}
                      {label}
                    </Tag>
                    <span>
                      {failed
                        ? graph.error || "未记录失败原因"
                        : graph
                          ? `${graph.mentions.length} 个实体 · ${graph.relations.length} 条关系`
                          : processing
                            ? "正在抽取或排队等待…"
                            : "尚未记录抽取结果"}
                    </span>
                  </summary>
                  <div className="graph-chunk-result-body">
                    {failed ? (
                      <p className="field-error">
                        失败原因：{graph.error || "未记录失败原因"}
                      </p>
                    ) : graph ? (
                      <ExtractionTables
                        graph={graph}
                        onViewOriginal={(relation) =>
                          setSourceDetail({
                            title: `第 ${chunk.position + 1} 片 · 关系原文`,
                            text: chunk.content,
                            original: true,
                            evidence: relation.evidence,
                            names: [relation.source, relation.target],
                          })
                        }
                      />
                    ) : (
                      <p className="graph-note" role="status">
                        {processing
                          ? "分片处理中，完成后自动显示抽取结果。"
                          : "本片尚未完成抽取。"}
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
                        onOpenChunk(chunk.chunk_id, chunk.position);
                      }}
                    >
                      查看分片详情
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
              共 {data.total} 片 · 第 {data.page} /{" "}
              {Math.max(1, data.total_pages)} 页
            </span>
            <button
              type="button"
              className="secondary-button button-sm"
              disabled={loading || page <= 1}
              onClick={() => {
                setPage(page - 1);
              }}
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary-button button-sm"
              disabled={loading || page >= data.total_pages}
              onClick={() => {
                setPage(page + 1);
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
            <>
              <HighlightedText
                text={sourceDetail.text}
                groups={[
                  { kind: "entity", texts: sourceDetail.names ?? [] },
                  { kind: "evidence", texts: [sourceDetail.evidence] },
                ]}
              />
            </>
          ) : (
            <pre className="graph-prompt">{sourceDetail.text}</pre>
          )}
        </DetailDialog>
      )}
    </DetailDialog>
  );
}

function ExtractionTables({
  graph,
  onViewOriginal,
}: {
  graph: ChunkGraph;
  onViewOriginal: (relation: {
    source: string;
    target: string;
    evidence: string;
  }) => void;
}) {
  const [tab, setTab] = useState<"entities" | "relations">("entities");
  const id = useId();
  return (
    <>
      <div
        className="graph-extraction-tabs"
        role="tablist"
        aria-label="分片抽取内容"
      >
        {(["entities", "relations"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${id}-${value}`}
            aria-controls={`${id}-panel`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "entities"
                    : event.key === "End"
                      ? "relations"
                      : tab === "entities"
                        ? "relations"
                        : "entities";
                setTab(next);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`[id="${id}-${next}"]`)
                  ?.focus();
              }
            }}
          >
            {value === "entities"
              ? `实体（${graph.mentions.length}）`
              : `关系（${graph.relations.length}）`}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === "entities" ? (
          graph.mentions.length ? (
            <div
              className="graph-chunk-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="实体表"
            >
              <Table className="graph-table graph-chunk-entity-table">
                <thead>
                  <tr>
                    <th scope="col" className="graph-row-number">
                      序号
                    </th>
                    <th scope="col">原文名字</th>
                    <th scope="col">标准名</th>
                    <th scope="col">类型</th>
                    <th scope="col">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.mentions.map((item, index) => (
                    <tr key={index}>
                      <td className="graph-row-number">{index + 1}</td>
                      <td>
                        <strong>{item.name}</strong>
                      </td>
                      <td>{item.canonical || item.name}</td>
                      <td>
                        <Tag size="sm" plain hue>
                          {item.type}
                        </Tag>
                      </td>
                      <td>{item.description || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="graph-note">本片抽取成功，没有抽出实体。</p>
          )
        ) : graph.relations.length ? (
          <div
            className="graph-chunk-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="关系表"
          >
            <Table className="graph-table graph-chunk-relation-table">
              <thead>
                <tr>
                  <th scope="col" className="graph-row-number">
                    序号
                  </th>
                  <th scope="col">起点</th>
                  <th scope="col">终点</th>
                  <th scope="col">分类</th>
                  <th scope="col">AI 基于原文的总结</th>
                  <th scope="col">原文引用（原样摘抄）</th>
                </tr>
              </thead>
              <tbody>
                {graph.relations.map((item, index) => (
                  <tr key={index}>
                    <td className="graph-row-number">{index + 1}</td>
                    <td>
                      <strong>{item.source}</strong>
                    </td>
                    <td>
                      <strong>{item.target}</strong>
                    </td>
                    <td>
                      <Tag size="sm" plain hue>
                        {item.category}
                      </Tag>
                    </td>
                    <td>{item.description || "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onViewOriginal(item)}
                      >
                        查看原文
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="graph-note">没有抽出关系。</p>
        )}
      </div>
    </>
  );
}
