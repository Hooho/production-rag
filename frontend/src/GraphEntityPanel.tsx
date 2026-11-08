import type { GraphHopInfo } from "./graphHops";
import { filterRelatedEntities } from "./graphEntitySearch";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { labelHue } from "./hues";
import {
  getGraphEntity,
  type GraphEntityDetail,
  type GraphRelationRow,
  type GraphEdge,
} from "./api";
import { Tag } from "./Tag";
import { typeColor } from "./GraphView";

// 实体详情：标准名、类型；由哪些名字合并而来（各自出自第几片、用什么方法合并）；出现在哪些文档；全部关系和出处。
// documentId 给了只看这份文档里的，不给看全局（管理员）。
// embedded = true 时放进弹窗里用：关掉的按钮由弹窗自己带，面板不再自己收边距。
// summaryOnly = true 时只说实体本身：不列关系，也不列每个名字出自第几片。
export function GraphEntityPanel({
  hopInfo,
  entityId,
  documentId,
  version,
  onClose,
  onOpenChunk,
  onFocus,
  onOpenDocument,
  visibleEdges,
  highlightedRelationId,
  onHighlightRelation,
  onHighlightCategory,
  selectedCategory,
  selectedScope,
  onScopeChange,
  entityQuery,
  onEntityQueryChange,
  onShowMatches,
  matchingLimitReached = false,
  embedded = false,
  summaryOnly = false,
}: {
  hopInfo?: GraphHopInfo | null;
  onOpenDocument?: (documentId: string) => void;
  entityId: string;
  documentId?: string | null;
  // 文档页签正在查看的图谱版本（不传就是生效版本）。
  version?: string | null;
  onClose: () => void;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
  onFocus?: (entityId: string) => void;
  visibleEdges?: GraphEdge[];
  highlightedRelationId?: string;
  onHighlightRelation?: (row: GraphRelationRow) => void;
  onHighlightCategory?: (category: string | null) => void;
  selectedCategory?: string | null;
  selectedScope?: "visible" | "all";
  onScopeChange?: (scope: "visible" | "all") => void;
  entityQuery?: string;
  onEntityQueryChange?: (query: string) => void;
  onShowMatches?: (query: string, category: string | null) => void;
  matchingLimitReached?: boolean;
  embedded?: boolean;
  summaryOnly?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<GraphEntityDetail | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<"visible" | "all">("visible");
  const [category, setCategory] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const nameQuery = entityQuery ?? localQuery;
  const [draftQuery, setDraftQuery] = useState(entityQuery ?? "");
  const searchId = useId();
  useEffect(() => {
    setDraftQuery(entityQuery ?? "");
  }, [entityQuery, entityId]);
  useEffect(() => {
    setCategory(selectedCategory ?? null);
  }, [selectedCategory]);
  useEffect(() => {
    setScope(selectedScope ?? "visible");
  }, [selectedScope]);
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLocalQuery("");
    setError("");
    setCategory(selectedCategory ?? null);
    setScope(selectedScope ?? "visible");
    getGraphEntity(entityId, documentId, version)
      .then((value) => !cancelled && setDetail(value))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [entityId, documentId, version]);
  useLayoutEffect(() => {
    const element = header.current;
    const container = panel.current;
    if (!detail || !element || !container) return;
    const measure = () =>
      container.style.setProperty(
        "--entity-header-height",
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      container.style.removeProperty("--entity-header-height");
    };
  }, [detail]);
  if (error)
    return (
      <aside className="graph-side">
        <p className="field-error">{error}</p>
      </aside>
    );
  if (!detail)
    return (
      <aside className="graph-side">
        <p className="graph-note">正在读取实体详情…</p>
      </aside>
    );
  const color = typeColor(detail.entity.type);
  const visibleKeys = new Set(
    visibleEdges?.flatMap((edge) =>
      edge.categories.map((name) => `${edge.source}>${edge.target}|${name}`),
    ),
  );
  const isVisible = (row: GraphRelationRow) =>
    visibleKeys.has(`${row.source_id}>${row.target_id}|${row.category}`);
  const visibleRelations = detail.relations.filter(isVisible);
  const scopedRelations =
    visibleEdges !== undefined && scope === "visible"
      ? visibleRelations
      : detail.relations;
  const categoryCounts = new Map<string, number>();
  for (const row of scopedRelations) {
    categoryCounts.set(
      row.category,
      (categoryCounts.get(row.category) ?? 0) + 1,
    );
  }
  const categoryRelations =
    category === null
      ? scopedRelations
      : scopedRelations.filter((row) => row.category === category);
  const relations = filterRelatedEntities(
    categoryRelations,
    entityId,
    nameQuery,
  );
  const matchingEntities = new Set(
    relations.map((row) =>
      row.source_id === entityId ? row.target_id : row.source_id,
    ),
  );
  const hiddenMatches = new Set(
    relations
      .filter((row) => !isVisible(row))
      .map((row) =>
        row.source_id === entityId ? row.target_id : row.source_id,
      ),
  );
  return (
    <aside ref={panel} className="graph-side graph-entity-panel">
      <div ref={header} className="graph-entity-header">
        <div className="graph-side-heading">
          <h3>
            {detail.entity.name}{" "}
            <span
              className="tag is-sm"
              style={{
                background: color.fill,
                color: color.text,
                borderColor: color.stroke,
              }}
            >
              {detail.entity.type}
            </span>
          </h3>
          {!embedded && (
            <button type="button" className="link-button" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
        {hopInfo && (
          <p className="graph-note">
            距起点「{hopInfo.rootName}」：
            {hopInfo.distances.has(entityId)
              ? `${hopInfo.distances.get(entityId)}跳`
              : "未连通"}
          </p>
        )}
        {detail.entity.description && (
          <p className="graph-note">{detail.entity.description}</p>
        )}
        {onFocus && (
          <button
            type="button"
            className="link-button"
            onClick={() => onFocus(detail.entity.id)}
          >
            在图里展开关系（每次最多 15 个邻居）
          </button>
        )}
      </div>
      <h4>由这些名字合并而来（{detail.names.length}）</h4>
      <ul>
        {detail.names.map((item, index) => (
          <li key={`${item.name}-${item.method}`}>
            <span className="graph-item-number">{index + 1}.</span>{" "}
            <strong>{item.name}</strong>{" "}
            <Tag size="sm" plain hue>
              {item.method_label}
            </Tag>
            <small>
              出现 {item.count} 次
              {summaryOnly
                ? ""
                : `：${item.positions.slice(0, 8).map((position, index) => (
                    <button
                      key={`${item.chunk_ids[index]}-${index}`}
                      type="button"
                      className="link-button"
                      disabled={!onOpenChunk || !documentId}
                      onClick={() =>
                        documentId &&
                        onOpenChunk?.(
                          item.chunk_ids[index],
                          position,
                          documentId,
                        )
                      }
                    >
                      第 {position + 1} 片
                    </button>
                  ))}
                  {item.positions.length > 8 ? " …" : ""}`}
            </small>
            {item.descriptions.length > 0 && (
              <small>{item.descriptions.join("；")}</small>
            )}
          </li>
        ))}
      </ul>
      {!documentId && (
        <>
          <h4>出现在 {detail.documents.length} 份文档</h4>
          <ul>
            {detail.documents.map((item) => (
              <li key={item.document_id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenDocument?.(item.document_id)}
                >
                  {item.title ?? item.document_id}
                </button>
                <small>
                  名字出现 {item.mention_count} 次 · 关系 {item.relation_count}{" "}
                  条
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* 只要实体本身时不列关系：检索诊断里看关系有专门的表，这里再列一遍是重复。 */}
      {!summaryOnly && (
        <section className="graph-entity-relations" aria-label="实体关系">
          <div className="graph-relations-header">
            <h4>
              关系（{relations.length} / {detail.relations.length}）
            </h4>
            {visibleEdges !== undefined && (
              <div
                className="graph-relation-scope"
                role="group"
                aria-label="关系显示范围"
              >
                <button
                  type="button"
                  aria-pressed={scope === "visible"}
                  onClick={() => {
                    setScope("visible");
                    onScopeChange?.("visible");
                    setCategory(null);
                    onHighlightCategory?.(null);
                  }}
                >
                  图中关系 {visibleRelations.length}
                </button>
                <button
                  type="button"
                  aria-pressed={scope === "all"}
                  onClick={() => {
                    setScope("all");
                    onScopeChange?.("all");
                    setCategory(null);
                    onHighlightCategory?.(null);
                  }}
                >
                  全部关系 {detail.relations.length}
                </button>
              </div>
            )}
            <div
              className="graph-relation-categories"
              role="group"
              aria-label="筛选关系分类"
            >
              <button
                type="button"
                aria-pressed={category === null}
                onClick={() => {
                  setCategory(null);
                  onHighlightCategory?.(null);
                }}
              >
                全部 {scopedRelations.length}
              </button>
              {[...categoryCounts].map(([name, count]) => (
                <button
                  type="button"
                  key={name}
                  className="tag is-hue"
                  style={{ "--tag-h": labelHue(name) } as CSSProperties}
                  aria-pressed={category === name}
                  onClick={() => {
                    setCategory(name);
                    onHighlightCategory?.(name);
                  }}
                >
                  {name} {count}
                </button>
              ))}
            </div>
            <form
              className="graph-entity-search"
              onSubmit={(event) => {
                event.preventDefault();
                const query = draftQuery.trim();
                setLocalQuery(query);
                onEntityQueryChange?.(query);
              }}
            >
              <label htmlFor={searchId}>在当前关系中查找实体</label>
              <div className="graph-entity-search-row">
                <input
                  id={searchId}
                  type="search"
                  value={draftQuery}
                  placeholder="输入实体名称，例如腾讯"
                  onChange={(event) => setDraftQuery(event.target.value)}
                />
                <button type="submit" className="secondary-button">
                  搜索
                </button>
                {(draftQuery || nameQuery) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setDraftQuery("");
                      setLocalQuery("");
                      onEntityQueryChange?.("");
                    }}
                  >
                    清空
                  </button>
                )}
              </div>
              {nameQuery.trim() && (
                <small role="status">
                  匹配 {matchingEntities.size} 个实体、{relations.length} 条关系
                </small>
              )}
              {nameQuery.trim() &&
                scope === "all" &&
                hiddenMatches.size > 0 &&
                onShowMatches && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={matchingLimitReached}
                    title="遵循顶部类型筛选，图中最多显示300个实体"
                    onClick={() => onShowMatches(nameQuery.trim(), category)}
                  >
                    {matchingLimitReached
                      ? "已达300个实体上限，请先收起部分展开"
                      : "显示匹配实体"}
                    （{hiddenMatches.size} 个未显示）
                  </button>
                )}
            </form>
          </div>
          <ul>
            {relations.map((row, index) => (
              <RelationItem
                key={row.id}
                row={row}
                number={index + 1}
                entityId={detail.entity.id}
                onOpenChunk={onOpenChunk}
                showDocument={!documentId}
                highlighted={highlightedRelationId === row.id && isVisible(row)}
                onHighlight={
                  isVisible(row) && onHighlightRelation
                    ? () => onHighlightRelation(row)
                    : undefined
                }
              />
            ))}
          </ul>
          {relations.length === 0 && (
            <p className="graph-note">
              {nameQuery.trim()
                ? "当前范围没有名称匹配的实体，可清空查找或切换到全部关系。"
                : "当前范围没有关系，可切换显示范围或展开邻居。"}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}

function RelationItem({
  row,
  number,
  entityId,
  onOpenChunk,
  showDocument,
  onHighlight,
  highlighted,
}: {
  row: GraphRelationRow;
  number: number;
  entityId: string;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
  showDocument: boolean;
  onHighlight?: () => void;
  highlighted: boolean;
}) {
  const outgoing = row.source_id === entityId;
  return (
    <li className={highlighted ? "graph-relation-is-highlighted" : ""}>
      <span>
        <span className="graph-item-number">{number}.</span>{" "}
        {outgoing ? "→" : "←"}{" "}
        {onHighlight ? (
          <button
            type="button"
            className="graph-relation-highlight-button"
            title="高亮并放大定位图中的对应关系"
            aria-pressed={highlighted}
            onClick={onHighlight}
          >
            <strong>{outgoing ? row.target_entity : row.source_entity}</strong>
          </button>
        ) : (
          <strong>{outgoing ? row.target_entity : row.source_entity}</strong>
        )}{" "}
        <Tag size="sm" plain hue={true}>
          {row.category}
        </Tag>
      </span>
      {row.description && <small>{row.description}</small>}
      <small>
        原文写的是「{row.source_name}」→「{row.target_name}」 ·{" "}
        {showDocument && row.document_title ? `《${row.document_title}》` : ""}
        {onOpenChunk ? (
          <button
            type="button"
            className="link-button"
            onClick={() =>
              onOpenChunk(row.chunk_id, row.position, row.document_id)
            }
          >
            第 {row.position + 1} 片
          </button>
        ) : (
          `第 ${row.position + 1} 片`
        )}
      </small>
      {row.evidence && <small>出处：「{row.evidence}」</small>}
    </li>
  );
}
