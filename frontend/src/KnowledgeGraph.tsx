import Table from "./Table";
import { graphHops } from "./graphHops";
import { GraphHistoryControls, useGraphHistory } from "./GraphHistory";
import { DocumentChunkDialog, type ChunkTarget } from "./DocumentChunkDialog";
import { GraphRelationPanel } from "./GraphRelationPanel";
import type { GraphEdge, GraphRelationRow } from "./api";
import { useEffect, useRef, useState } from "react";
import {
  backfillGraphVectors,
  getGraphOverview,
  getGraphTasks,
  getGraphVectors,
  queueGraphVersionVectors,
  type GraphOverview,
  type GraphTask,
  type GraphVectorStatus,
} from "./api";
import { BUILD_STATUS, TRIGGER_LABELS } from "./DocumentGraph";
import { formatShortTime } from "./format";
import { GraphBuildDialog } from "./GraphBuildDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";
import { GraphWorkspace } from "./GraphWorkspace";
import { GraphExplorerControls, useGraphExplorer } from "./GraphExplorer";
import { GraphView } from "./GraphView";
import {
  GraphVectorDialog,
  GraphVectorTag,
  vectorsBusy,
} from "./GraphVectorProgress";
import { Tag } from "./Tag";
import { errorText } from "./Toast";

type ShowToast = (kind: "success" | "error", message: string) => void;
export type KnowledgeGraphTab = "overview" | "tasks";

// 全局「知识图谱」（只有管理员能看）：所有文档当前版本的图合在一起看，以及每份文档的建图状态。
// 第 1 期只能查看和建图；跨文档合并、拆分、别名表等维护功能在第 3 期。
export default function KnowledgeGraph({
  tab,
  onNavigate,
  onToast,
}: {
  tab: KnowledgeGraphTab;
  onNavigate: (path: string) => void;
  onToast: ShowToast;
}) {
  return (
    <div className="knowledge-graph-page">
      <header className="topbar">
        <div>
          <h1>知识图谱</h1>
          <p className="graph-note">
            所有文档当前版本的实体和关系合在一起：同一个实体在所有文档里共用一个点。只影响这里和文档的「实体关系」页签，不影响问答和评测。
          </p>
        </div>
      </header>
      <div
        className="document-detail-tabs"
        role="tablist"
        aria-label="知识图谱"
      >
        <button
          className={tab === "overview" ? "active" : ""}
          onClick={() => onNavigate("/graph")}
        >
          总图
        </button>
        <button
          className={tab === "tasks" ? "active" : ""}
          onClick={() => onNavigate("/graph/tasks")}
        >
          建图任务
        </button>
      </div>
      {tab === "overview" ? (
        <Overview onNavigate={onNavigate} />
      ) : (
        <Tasks onNavigate={onNavigate} onToast={onToast} />
      )}
    </div>
  );
}

function Overview({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [chunkTarget, setChunkTarget] = useState<ChunkTarget | null>(null);
  const openChunk = (chunkId: string, position: number, documentId: string) =>
    setChunkTarget({ chunkId, position, documentId });
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [highlightedCategory, setHighlightedCategory] = useState<{
    entityId: string;
    category: string | null;
  } | null>(null);
  const explorer = useGraphExplorer(highlightedCategory);
  const { search, focus, limit, center } = explorer;
  const [hopRoot, setHopRoot] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [highlightedRelation, setHighlightedRelation] =
    useState<GraphRelationRow | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const knownNames = useRef(new Map<string, string>());
  const [relationScope, setRelationScope] = useState<"visible" | "all">(
    "visible",
  );
  const history = useGraphHistory(
    JSON.stringify([documentId, entityType, category]),
    {
      selected,
      category: highlightedCategory,
      relation: highlightedRelation,
      edge: selectedEdge,
      scope: relationScope,
    },
    explorer.snapshot,
    (entry, exploration) => {
      setSelected(entry.selected);
      setHighlightedCategory(entry.category);
      setHighlightedRelation(entry.relation);
      setSelectedEdge(entry.edge);
      setRelationScope(entry.scope);
      explorer.restore(exploration);
    },
  );
  const [data, setData] = useState<GraphOverview | null>(null);
  const hopInfo = graphHops(data?.network, hopRoot);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    getGraphOverview({
      document_id: documentId,
      type: entityType,
      category,
      q: search,
      focus,
      center,
      limit,
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
  }, [documentId, entityType, category, search, focus, center, limit]);
  for (const node of data?.network?.nodes ?? [])
    knownNames.current.set(node.id, node.name);
  if (error) return <div className="document-panel-empty">{error}</div>;
  if (!data) return <div className="document-panel-empty">正在读取图谱…</div>;
  if (data.documents.length === 0)
    return (
      <div className="document-panel-empty">
        还没有文档建过图。可以在「建图任务」里选文档建图，或者在文档详情的「实体关系」页签里建图。
      </div>
    );
  return (
    <div className="graph-panel">
      <GraphWorkspace>
        <div className="graph-filters">
          <select
            value={documentId ?? ""}
            onChange={(event) => {
              setDocumentId(event.target.value || null);
              explorer.reset();
              setSelected(null);
              setSelectedEdge(null);
            }}
          >
            <option value="">全部 {data.documents.length} 份文档</option>
            {data.documents.map((item) => (
              <option key={item.document_id} value={item.document_id}>
                {item.title}
              </option>
            ))}
          </select>
          <select
            value={entityType ?? ""}
            onChange={(event) => setEntityType(event.target.value || null)}
          >
            <option value="">全部类型</option>
            {Object.entries(data.type_counts).map(([type, count]) => (
              <option key={type} value={type}>
                {type}（{count}）
              </option>
            ))}
          </select>
          <select
            value={category ?? ""}
            onChange={(event) => setCategory(event.target.value || null)}
          >
            <option value="">全部关系</option>
            {Object.entries(data.category_counts).map(([item, count]) => (
              <option key={item} value={item}>
                {item}（{count}）
              </option>
            ))}
          </select>
        </div>
        <GraphExplorerControls
          hopInfo={hopInfo}
          onSetRoot={setHopRoot}
          explorer={explorer}
          network={data.network}
          matches={data.matches}
          selected={selected}
          onClearSelection={() => {
            setSelected(null);
            setSelectedEdge(null);
          }}
        />
        <div
          className={`graph-workspace-body${selected || selectedEdge ? " graph-body" : ""}`}
        >
          <div>
            <GraphView
              hopInfo={hopInfo}
              navigation={
                <GraphHistoryControls
                  history={history}
                  name={(id) => knownNames.current.get(id) ?? "实体"}
                />
              }
              canvasRestore={history.canvasRestore}
              onCanvasChange={history.saveCanvas}
              entityQuery={
                explorer.entitySearch?.entityId === selected
                  ? explorer.entitySearch.query
                  : ""
              }
              nodes={data.network.nodes}
              edges={data.network.edges}
              selected={selected}
              selectedEdge={selectedEdge?.id}
              highlightedCategory={
                highlightedCategory?.entityId === selected
                  ? highlightedCategory.category
                  : null
              }
              highlightedEdgeCategory={highlightedRelation?.category}
              highlightedEdge={
                highlightedRelation &&
                (highlightedRelation.source_id === selected ||
                  highlightedRelation.target_id === selected)
                  ? `${highlightedRelation.source_id}>${highlightedRelation.target_id}|${highlightedRelation.category}`
                  : undefined
              }
              onSelect={(id) => {
                setSelected(id);
                setHighlightedCategory(null);
                setHighlightedRelation(null);
                setSelectedEdge(null);
              }}
              onSelectEdge={(edge) => {
                setSelectedEdge(edge);
                setSelected(null);
              }}
              onExpand={explorer.expand}
            />
            <p className="graph-note">
              显示 {data.network.nodes.length} / {data.network.total_entities}{" "}
              个实体、{data.network.edges.length} 条边（
              {data.network.total_relations} 条关系）。
            </p>
          </div>
          {chunkTarget && (
            <DocumentChunkDialog
              target={chunkTarget}
              onClose={() => setChunkTarget(null)}
            />
          )}
          {selectedEdge && (
            <GraphRelationPanel
              edge={selectedEdge}
              documentId={documentId}
              category={selectedEdge.categories[0]}
              onClose={() => setSelectedEdge(null)}
              onOpenChunk={openChunk}
            />
          )}
          {selected && (
            <GraphEntityPanel
              entityId={selected}
              hopInfo={hopInfo}
              entityQuery={
                explorer.entitySearch?.entityId === selected
                  ? explorer.entitySearch.query
                  : ""
              }
              onEntityQueryChange={(query) => {
                explorer.setEntitySearch({ entityId: selected, query });
                setHighlightedRelation(null);
              }}
              onShowMatches={(query, category) =>
                explorer.showMatches(selected, query, category)
              }
              matchingLimitReached={(data.network?.nodes.length ?? 0) >= 300}
              selectedCategory={
                highlightedCategory?.entityId === selected
                  ? highlightedCategory.category
                  : null
              }
              selectedScope={relationScope}
              onScopeChange={setRelationScope}
              visibleEdges={data.network.edges}
              onHighlightCategory={(category) => {
                setHighlightedCategory({ entityId: selected, category });
                setHighlightedRelation(null);
              }}
              highlightedRelationId={highlightedRelation?.id}
              onHighlightRelation={(row) =>
                setHighlightedRelation((current) =>
                  current?.id === row.id ? null : row,
                )
              }
              onClose={() => setSelected(null)}
              onOpenDocument={(id) => onNavigate(`/knowledge/${id}`)}
              onOpenChunk={openChunk}
              onFocus={explorer.expand}
            />
          )}
        </div>
      </GraphWorkspace>
    </div>
  );
}

function Tasks({
  onNavigate,
  onToast,
}: {
  onNavigate: (path: string) => void;
  onToast: ShowToast;
}) {
  const [items, setItems] = useState<GraphTask[] | null>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ ids: string[]; title: string } | null>(
    null,
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getGraphTasks()
      .then((value) => !cancelled && setItems(value.items))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [tick]);
  // 图检索向量：生效版本里多少已经算好、多少还缺；还缺时可以补算（排进建图队列）。
  const [vectors, setVectors] = useState<GraphVectorStatus | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  // 打开了哪一行的向量进度抽屉（按 doc_key 记，轮询刷新后抽屉里的进度跟着变）。
  const [vectorKey, setVectorKey] = useState<string | null>(null);
  // 正在请求单独算向量的那一行（按 doc_key），按钮显示加载状态。
  const [queueing, setQueueing] = useState<string | null>(null);
  async function queueVectors(task: GraphTask) {
    if (!task.vectors) return;
    setQueueing(task.doc_key);
    try {
      const result = await queueGraphVersionVectors(task.vectors.version_id);
      setVectors(result);
      setTick((value) => value + 1);
      onToast("success", `已排队计算《${task.title}》的图检索向量`);
    } catch (reason) {
      onToast("error", errorText(reason));
    } finally {
      setQueueing(null);
    }
  }
  useEffect(() => {
    let cancelled = false;
    getGraphVectors()
      .then((value) => !cancelled && setVectors(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick]);
  async function backfill() {
    setBackfilling(true);
    try {
      const result = await backfillGraphVectors();
      setVectors(result);
      // 立刻刷新列表：补算的那几行马上显示「排队中」，之后自动轮询进度。
      setTick((value) => value + 1);
      onToast(
        "success",
        result.queued > 0
          ? `已排队补算 ${result.queued} 个图谱版本的向量`
          : "没有缺向量的图谱版本",
      );
    } catch (reason) {
      onToast("error", errorText(reason));
    } finally {
      setBackfilling(false);
    }
  }
  const busy = items?.some(
    (item) =>
      item.state === "queued" ||
      item.state === "running" ||
      vectorsBusy(item.vectors),
  );
  const vectorItem = vectorKey
    ? items?.find((item) => item.doc_key === vectorKey)
    : null;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [busy]);
  if (error) return <div className="document-panel-empty">{error}</div>;
  if (!items)
    return <div className="document-panel-empty">正在读取建图任务…</div>;
  const buildable = items.filter(
    (item) =>
      item.processed && item.state !== "queued" && item.state !== "running",
  );
  const notBuilt = buildable.filter(
    (item) => item.state === "none" || item.state === "outdated",
  );
  return (
    <div className="graph-panel">
      <div className="graph-tasks-actions">
        <span className="graph-note">
          共 {items.length} 份文档：已建{" "}
          {
            items.filter((item) =>
              ["completed", "partial"].includes(item.state),
            ).length
          }
          ，未建 {items.filter((item) => item.state === "none").length}，已过期{" "}
          {items.filter((item) => item.state === "outdated").length}
          {vectors && (
            <>
              ；图检索向量：{vectors.indexed} / {vectors.active} 个生效版本已算
              {vectors.failed > 0 ? `（${vectors.failed} 个失败）` : ""}
            </>
          )}
        </span>
        <div className="graph-actions">
          {vectors && vectors.missing > 0 && (
            <button
              className={`secondary-button ${backfilling ? "is-loading" : ""}`}
              disabled={backfilling || queueing !== null}
              onClick={() => void backfill()}
              title="以前建的图谱没有名字、关系向量，图检索查不到；补算后才能用"
            >
              补算向量（{vectors.missing}）
            </button>
          )}
          <button
            className="secondary-button"
            disabled={notBuilt.length === 0}
            onClick={() =>
              setChecked(new Set(notBuilt.map((item) => item.document_id)))
            }
          >
            选中未建和已过期的（{notBuilt.length}）
          </button>
          <button
            className="primary-button"
            disabled={checked.size === 0}
            onClick={() =>
              setDialog({
                ids: [...checked],
                title: `批量建图：${checked.size} 份文档`,
              })
            }
          >
            批量建图（{checked.size}）
          </button>
        </div>
      </div>
      <Table className="graph-table">
        <thead>
          <tr>
            <th />
            <th>文档</th>
            <th>状态</th>
            <th>清单 · 模型</th>
            <th>分片</th>
            <th>实体 / 关系</th>
            <th>检索向量</th>
            <th>时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const status = BUILD_STATUS[item.state] ?? BUILD_STATUS.none;
            const build = item.build;
            const canBuild = buildable.includes(item);
            const processed = build
              ? build.extracted + build.reused + build.failed
              : 0;
            return (
              <tr key={item.doc_key}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!canBuild}
                    checked={checked.has(item.document_id)}
                    onChange={(event) =>
                      setChecked((value) => {
                        const next = new Set(value);
                        if (event.target.checked) next.add(item.document_id);
                        else next.delete(item.document_id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    className="link-button"
                    onClick={() => onNavigate(`/knowledge/${item.document_id}`)}
                  >
                    {item.title}
                  </button>
                  <small>
                    v{item.version} · {item.owner}
                    {item.listed ? "" : " · 已下架"}
                    {item.auto ? " · 上传时开启了图检索" : ""}
                    {item.processed ? "" : " · 还没处理完"}
                  </small>
                </td>
                <td>
                  <Tag size="sm" tone={status.tone} dot>
                    {status.label}
                  </Tag>
                  {item.state === "outdated" && (
                    <small>最近的图是给旧版本建的</small>
                  )}
                </td>
                <td>
                  {build ? (
                    <>
                      {build.schema_name} · {build.model}
                      <small>
                        {TRIGGER_LABELS[build.trigger] ?? build.trigger}
                      </small>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {build
                    ? item.state === "running" || item.state === "queued"
                      ? `${processed} / ${build.total}`
                      : `${build.total} 片，失败 ${build.failed}`
                    : "—"}
                </td>
                <td>
                  {build && build.active
                    ? `${build.entity_count} / ${build.relation_count}`
                    : "—"}
                </td>
                <td>
                  {item.vectors ? (
                    <GraphVectorTag
                      value={item.vectors}
                      onClick={() => setVectorKey(item.doc_key)}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {build
                    ? formatShortTime(build.finished ?? build.created)
                    : "—"}
                </td>
                <td>
                  <div className="graph-row-actions">
                    {item.vectors && !vectorsBusy(item.vectors) && (
                      <button
                        className={`secondary-button ${queueing === item.doc_key ? "is-loading" : ""}`}
                        disabled={queueing !== null || backfilling}
                        title={
                          item.vectors.state === "done"
                            ? "重新计算这份图谱的名字、关系向量"
                            : "计算这份图谱的名字、关系向量，算好后图检索才能查到"
                        }
                        onClick={() => void queueVectors(item)}
                      >
                        {item.vectors.state === "done" ? "重算向量" : "算向量"}
                      </button>
                    )}
                    {canBuild && (
                      <button
                        className="secondary-button"
                        onClick={() =>
                          setDialog({
                            ids: [item.document_id],
                            title: `《${item.title}》v${item.version}`,
                          })
                        }
                      >
                        {item.state === "none" ? "建图" : "重建"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {vectorItem?.vectors && (
        <GraphVectorDialog
          title={`《${vectorItem.title}》`}
          value={vectorItem.vectors}
          onClose={() => setVectorKey(null)}
        />
      )}
      {dialog && (
        <GraphBuildDialog
          documentIds={dialog.ids}
          title={dialog.title}
          onClose={() => setDialog(null)}
          onStarted={() => {
            setDialog(null);
            setChecked(new Set());
            setTick((value) => value + 1);
          }}
          onToast={onToast}
        />
      )}
    </div>
  );
}
