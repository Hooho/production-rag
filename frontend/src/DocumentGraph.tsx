import { GraphRelationPanel } from "./GraphRelationPanel";
import type { GraphEdge } from "./api";
import { useEffect, useState, type ReactNode } from "react";
import {
  getDocumentGraph,
  retryDocumentGraph,
  type DocumentGraphData,
  type DocumentStatus,
  type GraphBuild,
  type GraphView as GraphViewName,
} from "./api";
import { formatShortTime } from "./format";
import { GraphBuildDialog } from "./GraphBuildDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";
import { GraphView, typeColor } from "./GraphView";
import { Tag } from "./Tag";
import type { Tone } from "./tags";

type ShowToast = (kind: "success" | "error", message: string) => void;

export const BUILD_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "排队中", tone: "info" },
  running: { label: "建图中", tone: "info" },
  completed: { label: "完成", tone: "success" },
  partial: { label: "部分失败", tone: "warning" },
  failed: { label: "失败", tone: "danger" },
  outdated: { label: "已过期", tone: "warning" },
  none: { label: "未建", tone: "neutral" },
};
export const TRIGGER_LABELS: Record<string, string> = {
  upload: "上传时开启",
  manual: "手动建图",
  batch: "批量建图",
  version: "新版本自动重建",
};
const VIEWS: [GraphViewName, string][] = [
  ["network", "图"],
  ["entities", "实体表"],
  ["relations", "关系表"],
  ["merges", "合并记录"],
];

export function isBuildBusy(build: GraphBuild | null | undefined) {
  return build?.status === "queued" || build?.status === "running";
}

function duration(build: GraphBuild) {
  if (!build.finished) return "";
  const ms =
    new Date(build.finished).getTime() - new Date(build.created).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

// 文档详情的「实体关系」页签：这个版本最近一次建图的概览、图、实体表、关系表、合并记录（第 1 期只能查看）。
export function DocumentGraph({
  document,
  onToast,
  onOpenChunk,
}: {
  document: DocumentStatus;
  onToast: ShowToast;
  onOpenChunk: (chunkId: string, position: number) => void;
}) {
  const [view, setView] = useState<GraphViewName>("network");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entityType, setEntityType] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [data, setData] = useState<DocumentGraphData | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(false);
  const [tick, setTick] = useState(0);
  const documentId = document.document_id;
  useEffect(() => {
    let cancelled = false;
    getDocumentGraph(documentId, {
      view,
      page,
      q: search,
      type: entityType,
      category,
      focus,
    })
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError("");
        }
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [documentId, view, page, search, entityType, category, focus, tick]);
  const busy = isBuildBusy(data?.build);
  // 建图进行中每 3 秒刷新一次进度。
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function retry() {
    try {
      await retryDocumentGraph(documentId);
      onToast("success", "已开始补跑失败的分片");
      setTick((value) => value + 1);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  if (error) return <div className="document-panel-empty">{error}</div>;
  if (!data) return <div className="document-panel-empty">正在读取图谱…</div>;
  const build = data.build;
  const stats = data.stats;
  const canStart = data.can_build && data.processed && !busy;
  const dialogNode = dialog && (
    <GraphBuildDialog
      documentIds={[documentId]}
      title={`《${document.title}》v${document.version ?? 1}`}
      onClose={() => setDialog(false)}
      onStarted={() => {
        setDialog(false);
        setTick((value) => value + 1);
      }}
      onToast={onToast}
    />
  );
  if (!build) {
    return (
      <div className="graph-panel">
        <div className="document-panel-empty">
          <p>这个版本还没有建过图。</p>
          <p className="graph-note">
            建图会让模型逐片抽出实体和关系，再和其他文档里的同一个实体合并。只影响「实体关系」和「知识图谱」页面，不影响问答和评测。
            {data.settings?.enabled
              ? "这份文档上传时开启了图检索，处理完会自动建图。"
              : ""}
          </p>
          {canStart ? (
            <button className="primary-button" onClick={() => setDialog(true)}>
              建图
            </button>
          ) : !data.processed ? (
            <p className="graph-note">文档处理完成后才能建图。</p>
          ) : !data.can_build ? (
            <p className="graph-note">只有上传者和管理员可以建图。</p>
          ) : null}
        </div>
        {dialogNode}
      </div>
    );
  }
  const status = BUILD_STATUS[build.status] ?? BUILD_STATUS.none;
  const counts = stats?.status_counts;
  const processedCount = build.extracted + build.reused + build.failed;
  return (
    <div className="graph-panel">
      <div className="graph-summary">
        <div className="graph-summary-main">
          <div>
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>{" "}
            <span className="graph-note">
              {build.schema_name} · {build.provider} · {build.model} ·{" "}
              {build.prompt_tag} ·{" "}
              {TRIGGER_LABELS[build.trigger] ?? build.trigger} ·{" "}
              {formatShortTime(build.created)}
              {duration(build) ? ` · 用时 ${duration(build)}` : ""}
            </span>
          </div>
          {busy ? (
            <>
              <p>
                已处理 {processedCount} / {build.total} 个分片：新抽取{" "}
                {build.extracted}，复用 {build.reused}，失败 {build.failed}
              </p>
              <div className="graph-progress">
                <span
                  style={{
                    width: `${build.total ? (processedCount / build.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="graph-summary-stats">
              <span>
                <strong>{stats?.entity_count ?? 0}</strong>个实体
              </span>
              <span>
                <strong>{stats?.relation_count ?? 0}</strong>条关系
              </span>
              <span>
                分片：新抽取 {counts?.extracted ?? 0} · 复用{" "}
                {counts?.reused ?? 0} · 失败 {counts?.failed ?? 0} · 没抽出实体{" "}
                {counts?.empty ?? 0}
              </span>
              <span>
                token：输入 {build.input_tokens.toLocaleString()} · 输出{" "}
                {build.output_tokens.toLocaleString()}
              </span>
            </div>
          )}
          {stats && Object.keys(stats.type_counts).length > 0 && (
            <div className="graph-legend">
              {Object.entries(stats.type_counts)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => {
                  const color = typeColor(type);
                  return (
                    <span key={type}>
                      <i
                        style={{
                          background: color.fill,
                          borderColor: color.stroke,
                        }}
                      />
                      {type} {count}
                    </span>
                  );
                })}
            </div>
          )}
          {build.note && <p className="graph-note">{build.note}</p>}
          {build.error && <p className="field-error">{build.error}</p>}
          {!build.active && !busy && build.status !== "failed" && (
            <p className="graph-note">
              这次建图没有生效（同一份文档后来又建过图）。
            </p>
          )}
        </div>
        {data.can_build && (
          <div className="graph-actions">
            {!busy && build.failed > 0 && (
              <button className="secondary-button" onClick={() => void retry()}>
                补跑失败的 {build.failed} 个分片
              </button>
            )}
            <button
              className="secondary-button"
              disabled={!canStart}
              onClick={() => setDialog(true)}
            >
              重新建图
            </button>
          </div>
        )}
      </div>
      {data.history.length > 1 && (
        <details className="graph-history">
          <summary>建图记录（{data.history.length} 次，只有一次生效）</summary>
          <table className="graph-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>状态</th>
                <th>清单 · 模型 · 提示词</th>
                <th>分片</th>
                <th>实体 / 关系</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((item) => (
                <tr key={item.id}>
                  <td>
                    {formatShortTime(item.created)}
                    <small>
                      {TRIGGER_LABELS[item.trigger] ?? item.trigger}
                    </small>
                  </td>
                  <td>
                    {(BUILD_STATUS[item.status] ?? BUILD_STATUS.none).label}
                    {item.active ? <small>生效中</small> : null}
                  </td>
                  <td>
                    {item.schema_name} · {item.model}
                    <small>{item.prompt_tag}</small>
                  </td>
                  <td>
                    新抽取 {item.extracted} · 复用 {item.reused} · 失败{" "}
                    {item.failed}
                  </td>
                  <td>
                    {item.entity_count} / {item.relation_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="graph-filters">
        <div className="chunk-source-filter">
          {VIEWS.map(([value, label]) => (
            <button
              key={value}
              className={view === value ? "active" : ""}
              onClick={() => {
                setView(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {(view === "network" || view === "entities") && stats && (
          <select
            value={entityType ?? ""}
            onChange={(event) => {
              setEntityType(event.target.value || null);
              setPage(1);
            }}
          >
            <option value="">全部类型</option>
            {Object.keys(stats.type_counts).map((type) => (
              <option key={type} value={type}>
                {type}（{stats.type_counts[type]}）
              </option>
            ))}
          </select>
        )}
        {(view === "network" || view === "relations") && stats && (
          <select
            value={category ?? ""}
            onChange={(event) => {
              setCategory(event.target.value || null);
              setPage(1);
            }}
          >
            <option value="">全部关系</option>
            {Object.keys(stats.category_counts).map((item) => (
              <option key={item} value={item}>
                {item}（{stats.category_counts[item]}）
              </option>
            ))}
          </select>
        )}
        {view !== "network" && (
          <input
            value={query}
            placeholder="搜索名字或描述"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setSearch(query.trim());
                setPage(1);
              }
            }}
            onBlur={() => {
              setSearch(query.trim());
              setPage(1);
            }}
          />
        )}
        {view === "network" && focus.length > 0 && (
          <button className="link-button" onClick={() => setFocus([])}>
            收起展开的 {focus.length} 个实体
          </button>
        )}
      </div>
      <div className={selected || selectedEdge ? "graph-body" : ""}>
        <div>
          {view === "network" && data.network && (
            <>
              <GraphView
                nodes={data.network.nodes}
                edges={data.network.edges}
                selected={selected}
                selectedEdge={selectedEdge?.id}
                onSelect={(id) => {
                  setSelected(id);
                  setSelectedEdge(null);
                }}
                onSelectEdge={(edge) => {
                  setSelectedEdge(edge);
                  setSelected(null);
                }}
                onExpand={(id) =>
                  setFocus((items) =>
                    items.includes(id) ? items : [...items, id],
                  )
                }
                emptyText={busy ? "建图完成后显示" : "没有抽出实体"}
              />
              <p className="graph-note">
                显示 {data.network.nodes.length} / {data.network.total_entities}{" "}
                个实体、{data.network.edges.length} 条边（
                {data.network.total_relations}{" "}
                条关系，同一对实体之间的多条关系合成一条边）。默认只显示关系最多的{" "}
                {data.network.limit} 个。
              </p>
            </>
          )}
          {view === "entities" && data.entities && (
            <Paged
              page={data.entities.page}
              total={data.entities.total}
              size={data.entities.page_size}
              onPage={setPage}
            >
              <table className="graph-table">
                <thead>
                  <tr>
                    <th>实体</th>
                    <th>类型</th>
                    <th>名字数</th>
                    <th>关系数</th>
                    <th>出现在几片</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entities.items.map((row) => (
                    <tr
                      key={row.id}
                      className="is-clickable"
                      onClick={() => setSelected(row.id)}
                    >
                      <td>
                        {row.name}
                        {row.description && <small>{row.description}</small>}
                      </td>
                      <td>{row.type}</td>
                      <td>{row.name_count}</td>
                      <td>{row.relation_count}</td>
                      <td>{row.chunk_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          )}
          {view === "relations" && data.relations && (
            <Paged
              page={data.relations.page}
              total={data.relations.total}
              size={data.relations.page_size}
              onPage={setPage}
            >
              <table className="graph-table">
                <thead>
                  <tr>
                    <th>起点</th>
                    <th>关系</th>
                    <th>终点</th>
                    <th>描述</th>
                    <th>出处</th>
                  </tr>
                </thead>
                <tbody>
                  {data.relations.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => setSelected(row.source_id)}
                        >
                          {row.source_entity}
                        </button>
                        {row.source_name !== row.source_entity && (
                          <small>原文：{row.source_name}</small>
                        )}
                      </td>
                      <td>{row.category}</td>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => setSelected(row.target_id)}
                        >
                          {row.target_entity}
                        </button>
                        {row.target_name !== row.target_entity && (
                          <small>原文：{row.target_name}</small>
                        )}
                      </td>
                      <td>
                        {row.description}
                        {row.evidence && <small>「{row.evidence}」</small>}
                      </td>
                      <td>
                        <button
                          className="link-button"
                          onClick={() =>
                            onOpenChunk(row.chunk_id, row.position)
                          }
                        >
                          第 {row.position + 1} 片
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          )}
          {view === "merges" && data.merges && (
            <Paged
              page={data.merges.page}
              total={data.merges.total}
              size={data.merges.page_size}
              onPage={setPage}
            >
              <p className="graph-note">
                每个名字归到了哪个实体、用的什么方法。第 1
                期只按规则合并：名字相同、规范化后相同、模型给的标准名相同；没合上或合错的要等第
                3 期手动处理。
              </p>
              <table className="graph-table">
                <thead>
                  <tr>
                    <th>原文里的名字</th>
                    <th>归到</th>
                    <th>方法</th>
                    <th>出现在</th>
                  </tr>
                </thead>
                <tbody>
                  {data.merges.items.map((row) => (
                    <tr key={`${row.name}-${row.entity_id}-${row.method}`}>
                      <td>
                        {row.name}
                        <small>
                          {row.type}
                          {row.canonical !== row.name
                            ? ` · 模型给的标准名：${row.canonical}`
                            : ""}
                        </small>
                      </td>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => setSelected(row.entity_id)}
                        >
                          {row.entity_name}
                        </button>
                      </td>
                      <td>
                        <Tag
                          size="sm"
                          plain
                          tone={row.method === "new" ? "neutral" : "info"}
                        >
                          {row.method_label}
                        </Tag>
                      </td>
                      <td>
                        {row.positions.slice(0, 6).map((position, index) => (
                          <button
                            key={`${row.chunk_ids[index]}-${index}`}
                            className="link-button"
                            onClick={() =>
                              onOpenChunk(row.chunk_ids[index], position)
                            }
                          >
                            第 {position + 1} 片
                          </button>
                        ))}
                        {row.positions.length > 6
                          ? ` 等 ${row.positions.length} 处`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          )}
        </div>
        {selectedEdge && (
          <GraphRelationPanel
            edge={selectedEdge}
            documentId={documentId}
            category={category}
            onClose={() => setSelectedEdge(null)}
            onOpenChunk={(chunkId, position) => onOpenChunk(chunkId, position)}
          />
        )}
        {selected && (
          <GraphEntityPanel
            entityId={selected}
            documentId={documentId}
            onClose={() => setSelected(null)}
            onOpenChunk={(chunkId, position) => onOpenChunk(chunkId, position)}
            onFocus={(id) => {
              setView("network");
              setFocus((items) =>
                items.includes(id) ? items : [...items, id],
              );
            }}
          />
        )}
      </div>
      {dialogNode}
    </div>
  );
}

function Paged({
  page,
  total,
  size,
  onPage,
  children,
}: {
  page: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
  children: ReactNode;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <>
      {children}
      {total === 0 && <div className="graph-empty">没有符合条件的记录</div>}
      <div className="graph-pager">
        共 {total} 条 · 第 {page} / {pages} 页
        <button
          className="secondary-button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <button
          className="secondary-button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
      </div>
    </>
  );
}
