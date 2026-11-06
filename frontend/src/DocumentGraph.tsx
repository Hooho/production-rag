import { graphHops } from "./graphHops";
import { GraphReviewPanel, type ReviewStep } from "./GraphReviewPanel";
import { errorText } from "./Toast";
import { GraphHistoryControls, useGraphHistory } from "./GraphHistory";
import { DocumentChunkDialog, type ChunkTarget } from "./DocumentChunkDialog";
import { GraphBuildTimer } from "./GraphBuildTimer";
import { GraphChunkDetails } from "./GraphChunkDetails";
import { GraphRelationPanel } from "./GraphRelationPanel";
import type { GraphEdge, GraphRelationRow } from "./api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  decideGraphReview,
  getDocumentGraph,
  getGraphReview,
  retryDocumentGraph,
  stopDocumentGraph,
  type DocumentGraphData,
  type DocumentStatus,
  type GraphBuild,
  type GraphMergeRow,
  type GraphReviewReport,
  type GraphView as GraphViewName,
} from "./api";
import { formatShortTime } from "./format";
import { GraphBuildDialog } from "./GraphBuildDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";
import { GraphWorkspace } from "./GraphWorkspace";
import { GraphExplorerControls, useGraphExplorer } from "./GraphExplorer";
import { GraphView, typeColor } from "./GraphView";
import { Tag } from "./Tag";
import type { Tone } from "./tags";

type ShowToast = (kind: "success" | "error", message: string) => void;

export const BUILD_STATUS: Record<string, { label: string; tone: Tone }> = {
  awaiting_review: { label: "等待人工确认", tone: "warning" },
  stopped: { label: "已停止", tone: "neutral" },
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
  return (
    build?.status === "queued" ||
    build?.status === "running" ||
    build?.status === "awaiting_review"
  );
}

// 文档详情的「实体关系」页签：这个版本最近一次建图的概览、图、实体表、关系表、合并记录（第 1 期只能查看）。
export function DocumentGraph({
  document,
  onToast,
}: {
  document: DocumentStatus;
  onToast: ShowToast;
}) {
  const [chunkTarget, setChunkTarget] = useState<ChunkTarget | null>(null);
  const onOpenChunk = (chunkId: string, position: number) =>
    setChunkTarget({ documentId: document.document_id, chunkId, position });
  const [view, setView] = useState<GraphViewName>("network");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entityType, setEntityType] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [highlightedCategory, setHighlightedCategory] = useState<{
    entityId: string;
    category: string | null;
  } | null>(null);
  const explorer = useGraphExplorer(highlightedCategory);
  const { focus, center, limit } = explorer;
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
    JSON.stringify([document.document_id, entityType, category]),
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
  const [data, setData] = useState<DocumentGraphData | null>(null);
  const hopInfo = graphHops(data?.network, hopRoot);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(false);
  const [chunkDetails, setChunkDetails] = useState(false);
  const [tick, setTick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const documentId = document.document_id;
  // 合并记录里标记撤销：只改二次检查的决定，攒起来到第 4 步一起确认、写入图谱。
  const [review, setReview] = useState<GraphReviewReport | null>(null);
  const [canDecide, setCanDecide] = useState(false);
  const [reviewOpenAt, setReviewOpenAt] = useState<{
    step: ReviewStep;
    key: number;
  } | null>(null);
  // 正在提交撤销 / 取消撤销的那一行：只给它的按钮显示加载图标。
  const [undoing, setUndoing] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getGraphReview(documentId)
      .then((value) => {
        if (cancelled) return;
        setReview(value.report);
        setCanDecide(value.can_confirm);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId, tick]);
  const reviewDecisions = review?.decisions ?? {};
  const appliedIds = new Set(review?.applied?.approved_ids ?? []);
  const reviewProposals = new Set(
    (review?.judgments ?? []).flatMap((item) =>
      (item.decision?.groups ?? []).map(
        (_, index) => `${item.candidate_id}:${index}`,
      ),
    ),
  );
  const isApproved = (id: string) =>
    reviewDecisions[id]?.decision === "approved";
  // 已写入图谱、但现在不再批准的合并结果：下次写入时会拆开。
  const undoCount = (review?.applied?.groups ?? []).filter((group) =>
    group.proposal_ids.some((id) => !isApproved(id)),
  ).length;
  function undoState(row: GraphMergeRow) {
    const ids = row.review?.proposal_ids ?? [];
    if (!ids.length) return null;
    if (ids.some((id) => appliedIds.has(id) && !isApproved(id)))
      return "marked" as const;
    if (
      review?.status === "ready" &&
      canDecide &&
      ids.every((id) => reviewProposals.has(id))
    )
      return "available" as const;
    return "unavailable" as const;
  }
  async function setUndo(row: GraphMergeRow, undo: boolean) {
    if (!review || undoing) return;
    setUndoing(`${row.review!.proposal_ids.join(",")}:${undo}`);
    try {
      await decideGraphReview(
        documentId,
        review.build_id,
        row.review!.proposal_ids,
        undo ? null : "approved",
      );
      onToast(
        "success",
        undo ? "已标记撤销，到确认页确认后写入图谱才生效" : "已取消撤销",
      );
      setTick((value) => value + 1);
    } catch (reason) {
      onToast("error", errorText(reason));
    } finally {
      setUndoing(null);
    }
  }
  useEffect(() => {
    let cancelled = false;
    getDocumentGraph(documentId, {
      view,
      page,
      q: view === "network" ? explorer.search : search,
      type: entityType,
      category,
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
  }, [
    documentId,
    view,
    page,
    search,
    entityType,
    category,
    focus,
    center,
    limit,
    explorer.search,
    tick,
  ]);
  for (const node of data?.network?.nodes ?? [])
    knownNames.current.set(node.id, node.name);
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

  async function stop() {
    if (!data?.build || stopping) return;
    setStopping(true);
    try {
      await stopDocumentGraph(documentId, data.build.id);
      onToast("success", "建图已停止，已保存的抽取结果保留，可以重新建图。");
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setStopping(false);
      setTick((value) => value + 1);
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
          <div className="graph-summary-heading">
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>{" "}
            <span className="graph-note">
              {build.schema_name} · {build.provider} · {build.model} ·{" "}
              {build.prompt_tag} ·{" "}
              {TRIGGER_LABELS[build.trigger] ?? build.trigger} ·{" "}
              {formatShortTime(build.created)}
              {" · "}
              <GraphBuildTimer
                key={build.id}
                started={build.created}
                finished={build.finished}
                running={busy}
              />
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
          {!build.active &&
            !busy &&
            build.status !== "failed" &&
            build.status !== "stopped" && (
              <p className="graph-note">
                这次建图没有生效（同一份文档后来又建过图）。
              </p>
            )}
        </div>
        <div className="graph-actions">
          <GraphReviewPanel
            documentId={documentId}
            buildId={build.id}
            tick={tick}
            canRetry={!busy && data.can_build}
            onChanged={() => setTick((value) => value + 1)}
            openAt={reviewOpenAt}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => setChunkDetails(true)}
          >
            分片详情
          </button>
          {data.can_build && (
            <>
              {busy && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  {stopping ? "正在停止…" : "停止建图"}
                </button>
              )}
              {!busy && build.status !== "stopped" && build.failed > 0 && (
                <button
                  className="secondary-button"
                  onClick={() => void retry()}
                >
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
            </>
          )}
        </div>
      </div>
      {chunkTarget && (
        <DocumentChunkDialog
          target={chunkTarget}
          onClose={() => setChunkTarget(null)}
        />
      )}
      {chunkDetails && (
        <GraphChunkDetails
          key={build.id}
          documentId={documentId}
          buildId={build.id}
          tick={tick}
          busy={busy}
          onClose={() => setChunkDetails(false)}
          onOpenChunk={onOpenChunk}
        />
      )}
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

      <GraphWorkspace enabled={view === "network"}>
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
        </div>
        {view === "network" && (
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
        )}
        <div
          className={`graph-workspace-body${selected || selectedEdge ? " graph-body" : ""}`}
        >
          <div>
            {view === "network" && data.network && (
              <>
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
                  emptyText={busy ? "建图完成后显示" : "没有抽出实体"}
                />
                <p className="graph-note">
                  显示 {data.network.nodes.length} /{" "}
                  {data.network.total_entities} 个实体、
                  {data.network.edges.length} 条边（
                  {data.network.total_relations}{" "}
                  条关系，同一对实体之间按分类分线，同分类关系合并计数）。
                  {data.network.center_id
                    ? "当前为中心实体的一跳关系及手动展开的邻居。"
                    : `当前概览最多显示 ${data.network.limit} 个核心实体。`}
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
                      <th className="graph-row-number">序号</th>
                      <th>实体</th>
                      <th>类型</th>
                      <th>名字数</th>
                      <th>关系数</th>
                      <th>出现在几片</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entities.items.map((row, index) => (
                      <tr
                        key={row.id}
                        className="is-clickable"
                        onClick={() => setSelected(row.id)}
                      >
                        <td className="graph-row-number">
                          {(data.entities!.page - 1) *
                            data.entities!.page_size +
                            index +
                            1}
                        </td>
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
                      <th className="graph-row-number">序号</th>
                      <th>起点</th>
                      <th className="graph-nowrap">关系</th>
                      <th>终点</th>
                      <th>描述</th>
                      <th className="graph-nowrap">出处</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.relations.items.map((row, index) => (
                      <tr key={row.id}>
                        <td className="graph-row-number">
                          {(data.relations!.page - 1) *
                            data.relations!.page_size +
                            index +
                            1}
                        </td>
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
                        <td className="graph-nowrap">
                          <Tag size="sm" plain hue>
                            {row.category}
                          </Tag>
                        </td>
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
                        <td className="graph-nowrap">
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
                  合并范围区分新建实体、文档内合并和跨文档合并。同一次建图中，首次关联其他文档的实体记为跨文档合并，后续重复归属记为文档内合并。历史记录未保存范围时显示「历史未记录」。
                  建图时按规则合并（名字相同、规范化后相同、模型给的标准名相同）；之后可以用「二次检查合并」补充，方法显示为「二次检查合并（人工确认）」，这类合并可以在这里标记撤销，到确认页一起确认后重新写入图谱。
                </p>
                {undoCount > 0 && (
                  <div className="graph-undo-bar">
                    <span>
                      已标记撤销 <strong>{undoCount}</strong>{" "}
                      个合并，还没写入图谱。
                    </span>
                    <button
                      type="button"
                      className="primary-button button-sm"
                      onClick={() =>
                        setReviewOpenAt({ step: 4, key: Date.now() })
                      }
                    >
                      去确认并写入
                    </button>
                  </div>
                )}
                <table className="graph-table graph-merge-table">
                  <colgroup>
                    <col />
                    <col />
                    <col className="graph-merge-scope-column" />
                    <col className="graph-merge-method-column" />
                    <col className="graph-merge-source-column" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>原文里的名字</th>
                      <th>归到</th>
                      <th>合并范围</th>
                      <th>方法</th>
                      <th>出现在</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.merges.items.map((row) => (
                      <tr
                        key={`${row.name}-${row.entity_id}-${row.method}-${row.scope}`}
                      >
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
                          <Tag size="sm" plain hue>
                            {row.scope_label}
                          </Tag>
                        </td>
                        <td>
                          <div className="graph-merge-method">
                            <Tag size="sm" plain hue>
                              {row.method_label}
                            </Tag>
                            {undoState(row) === "marked" && (
                              <span className="graph-undo-cell">
                                <Tag size="sm" tone="warning">
                                  已标记撤销
                                </Tag>
                                <button
                                  type="button"
                                  className={`link-button${undoing === `${row.review?.proposal_ids.join(",")}:false` ? " is-loading" : ""}`}
                                  disabled={!!undoing}
                                  onClick={() => void setUndo(row, false)}
                                >
                                  取消
                                </button>
                              </span>
                            )}
                            {undoState(row) === "available" && (
                              <button
                                type="button"
                                className={`link-button graph-undo-link${undoing === `${row.review?.proposal_ids.join(",")}:true` ? " is-loading" : ""}`}
                                disabled={!!undoing}
                                title={
                                  row.review?.reason
                                    ? `合并理由：${row.review.reason}`
                                    : undefined
                                }
                                onClick={() => void setUndo(row, true)}
                              >
                                撤销
                              </button>
                            )}
                            {undoState(row) === "unavailable" && (
                              <small title="二次检查已重新检查或正在进行，请在二次检查里处理">
                                （检查结果已更新）
                              </small>
                            )}
                          </div>
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
              category={selectedEdge.categories[0]}
              onClose={() => setSelectedEdge(null)}
              onOpenChunk={(chunkId, position) =>
                onOpenChunk(chunkId, position)
              }
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
              visibleEdges={
                view === "network" ? data.network?.edges : undefined
              }
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
              documentId={documentId}
              onClose={() => setSelected(null)}
              onOpenChunk={(chunkId, position) =>
                onOpenChunk(chunkId, position)
              }
              onFocus={(id) => {
                setView("network");
                if (view !== "network") explorer.choose(id);
                else explorer.expand(id);
              }}
            />
          )}
        </div>
      </GraphWorkspace>
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
          className="secondary-button button-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <button
          className="secondary-button button-sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
      </div>
    </>
  );
}
