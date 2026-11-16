import { Tag } from "./Tag";
import Table, { TablePagination } from "./Table";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type {
  GraphRetrievalRelation,
  GraphRetrievalTable,
  GraphRetrievalTrace as GraphTrace,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { GraphEntityDialog } from "./GraphEntityDialog";
import { typeColor } from "./GraphView";
import { ChunkOriginalText } from "./ChunkOriginalText";
import { InfoPopover } from "./Popover";
import { labelHue } from "./hues";
import { buildHaystack, normalizeSearch, SearchText } from "./searchText";
import "./GraphRetrieval.css";

// 检索过程「混合检索」里的图检索模块（docs：claude/graph-retrieval-phase2-plan.md 第一部分第四节）：
// ① 提关键词 → ② 找实体 → ③ 实体过滤 → ④ 实体的关系 → ⑤ 找关系 → ⑥ 候选重排 → ⑦ 取分片 → ⑧ 关系图。
// 页面上每一步只列数量和类型，明细在「详情」抽屉里（分页、按实体 / 关系类型 / 关键词分类，可带上去掉的项和原因）。
// 权限、生效版本在查询条件里，没有「权限过滤掉多少条」。

const SOURCE_LABELS: Record<string, string> = {
  agent: "调用方提供",
  model: "模型提取（graph_keywords）",
  fallback: "没有提取",
};

function score(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

function ms(value: number | null | undefined) {
  if (value === null || value === undefined) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

// 分片序号：分片 id 末尾是这一片的位置（从 0 开始），页面上从第 1 片数（和评测里的一致）。
function chunkNumber(chunkId?: string | null) {
  const index = chunkId?.match(/:(\d+)$/)?.[1];
  return index === undefined ? null : Number(index) + 1;
}

type ChunkInfo = Pick<
  GraphRetrievalTable,
  "chunk_id" | "title" | "text" | "heading" | "version"
>;

// 分片原文是三段拼起来的：上下文说明、标题路径、正文。
// 拆开各给一个底色，一眼能看出哪段是什么（结构与后端 app/storage.py 的 chunk_body 一致）。
// 原文：整片原文，高亮这条关系的原文引用和起点、终点的名字。
function OriginalButton({
  relation,
  chunk,
}: {
  relation: GraphRetrievalRelation;
  chunk?: ChunkInfo;
}) {
  return (
    <InfoPopover
      title={chunk?.title ?? relation.title ?? "原文"}
      content={() => {
        if (!chunk?.text) {
          return (
            <div className="grt-original-missing">
              <p>此记录未保存完整分片，以下为抽取时记录的原文引用：</p>
              <blockquote>{relation.evidence || "（没有原文引用）"}</blockquote>
            </div>
          );
        }
        return (
          <ChunkOriginalText
            text={chunk.text}
            groups={[
              {
                kind: "evidence",
                texts: (relation.evidence ?? "")
                  .split("||")
                  .filter((item) => item.trim()),
              },
              { kind: "entity", texts: [relation.source, relation.target] },
            ]}
          />
        );
      }}
    >
      <button type="button" className="link-button button-sm">
        原文
      </button>
    </InfoPopover>
  );
}

// 关系类型的颜色和图谱里一致：同一个类型在图谱侧栏和这里是一个颜色（hues.ts 的 labelHue）。
function categoryStyle(category: string) {
  return { "--tag-h": labelHue(category) } as CSSProperties;
}

// 关系按三行显示：先是谁和谁之间有什么关系（起点 → 关系类型 → 终点），
// 再是这条关系自己的描述，最后是原文引用。实体名字可以点开看详情。
function RelationText({
  relation,
  onEntity,
  query,
}: {
  relation: GraphRetrievalRelation;
  onEntity?: (entityId: string, documentId: string) => void;
  query?: string;
}) {
  const renamed = (name: string, entity: string | null) =>
    entity && entity !== name ? (
      <small className="grt-entity-of" title={`归到实体「${entity}」`}>
        （<SearchText text={entity} query={query ?? ""} />）
      </small>
    ) : null;
  const entityName = (text: string, entityId: string, entity: string | null) =>
    onEntity && entityId ? (
      <button
        type="button"
        className="link-button button-sm grt-entity-name"
        title={`看实体「${entity ?? text}」的详情`}
        onClick={() => onEntity(entityId, relation.document_id)}
      >
        <SearchText text={text} query={query ?? ""} />
      </button>
    ) : (
      <b>
        <SearchText text={text} query={query ?? ""} />
      </b>
    );
  return (
    <span className="grt-rel">
      <span className="grt-rel-line">
        {entityName(
          relation.source,
          relation.source_entity_id,
          relation.source_entity,
        )}
        {renamed(relation.source, relation.source_entity)}
        <span className="grt-arrow">→</span>
        <small
          className="grt-category is-hue"
          style={categoryStyle(relation.category)}
        >
          <SearchText text={relation.category} query={query ?? ""} />
        </small>
        <span className="grt-arrow">→</span>
        {entityName(
          relation.target,
          relation.target_entity_id,
          relation.target_entity,
        )}
        {renamed(relation.target, relation.target_entity)}
      </span>
      {relation.description && (
        <small className="grt-rel-desc">
          <SearchText text={relation.description} query={query ?? ""} />
        </small>
      )}
      {relation.evidence && (
        <small className="grt-evidence" title="原文引用">
          「<SearchText text={relation.evidence} query={query ?? ""} />」
        </small>
      )}
    </span>
  );
}

function Result({
  kept,
  reason,
  extra,
  row,
  trace,
  query,
}: {
  row?: GraphRetrievalRelation;
  trace?: GraphTrace;
  kept: boolean;
  reason?: string | null;
  extra?: string;
  query?: string;
}) {
  const settings = trace?.settings;
  const minimum = settings?.graph_relation_rerank_min_score;
  const limit = settings?.graph_relation_return_limit;
  const capacity = settings?.graph_relation_rerank_candidates;
  const details: string[] = [];
  if (row && row.fusion_rank !== undefined) {
    if (
      row.rerank_score != null &&
      minimum != null &&
      !trace?.relation_rerank_error
    ) {
      details.push(
        `重排得分 ${score(row.rerank_score)} ${row.rerank_score >= minimum ? "≥" : "<"} ${score(minimum)}，${row.rerank_score >= minimum ? "已达标" : "未达标"}`,
      );
    }
    if (
      (kept || reason === "超过关系保留上限") &&
      row.rerank_rank != null &&
      limit != null &&
      row.group_round == null
    ) {
      details.push(
        `重排名次第 ${row.rerank_rank} 名，${kept ? "在保留的" : "超出保留的"}前 ${limit} 条${kept ? "内" : "上限"}`,
      );
    }
    if (reason === "超过关系重排候选上限") {
      details.push(`未被保底选入，融合排名第 ${row.fusion_rank} 名`);
      details.push(
        `重排候选池${capacity != null ? `最多 ${capacity} 条，` : "："}未参与重排`,
      );
    }
    if (row.group_round != null) {
      details.push(
        `组内第 ${row.group_round} 条 · 第 ${row.group_round} 轮 · 选择顺序第 ${row.selection_rank} 名`,
      );
      if (limit != null) details.push(`分轮选取最多保留 ${limit} 条`);
    }
    if (trace?.relation_rerank_error && kept) {
      details.push("重排未成功，按融合排名保留");
      if (limit != null)
        details.push(`融合排名第 ${row.fusion_rank} 名，最多保留 ${limit} 条`);
    }
  }
  if (row && row.fusion_rank !== undefined) {
    // 历史记录缺少 in_pool 时，只使用已有排名或最终结果判断，不推测步骤。
    const entered =
      row.in_pool ??
      (row.rerank_rank != null || kept
        ? true
        : reason === "超过关系重排候选上限"
          ? false
          : undefined);
    const detailLines = (
      <>
        {!kept && reason && reason !== "超过关系重排候选上限" && (
          <small className="grt-result-detail">
            <SearchText text={reason} query={query ?? ""} />
          </small>
        )}
        {details.map((text, index) => (
          <small className="grt-result-detail" key={index}>
            <SearchText text={text} query={query ?? ""} />
          </small>
        ))}
      </>
    );
    return (
      <div className="grt-result grt-result-steps">
        {extra && <small className="grt-result-source">{extra}</small>}
        <div>
          <span className="grt-kept">✓ 进入候选</span>
        </div>
        <div>
          <span
            className={
              entered === true
                ? "grt-kept"
                : entered === false
                  ? "grt-pool-dropped"
                  : "grt-step-muted"
            }
          >
            {entered === true
              ? "✓ 进入重排"
              : entered === false
                ? "✕ 未进入重排"
                : "— 重排状态未记录"}
          </span>
          {entered === false && detailLines}
        </div>
        <div>
          <span
            className={
              entered === false
                ? "grt-step-muted"
                : kept
                  ? "grt-kept"
                  : "grt-dropped"
            }
          >
            {entered === false
              ? "— 最终留下（未进入）"
              : kept
                ? "✓ 最终留下"
                : "✕ 最终未留下"}
          </span>
          {entered !== false && detailLines}
        </div>
      </div>
    );
  }
  return (
    <div className="grt-result">
      <span
        className={
          kept
            ? "grt-kept"
            : reason === "超过关系重排候选上限"
              ? "grt-pool-dropped"
              : "grt-dropped"
        }
      >
        {kept ? (
          `✓ 留下${extra ? ` · ${extra}` : ""}`
        ) : (
          <>
            ✕{" "}
            <SearchText
              text={
                reason === "超过关系重排候选上限"
                  ? "未进入重排候选池"
                  : reason || "去掉"
              }
              query={query ?? ""}
            />
          </>
        )}
      </span>
      {details.map((text, index) => (
        <small className="grt-result-detail" key={index}>
          <SearchText text={text} query={query ?? ""} />
        </small>
      ))}
    </div>
  );
}

function Origin({
  relation,
  query,
}: {
  relation: GraphRetrievalRelation;
  query?: string;
}) {
  return (
    <span className="grt-origin">
      {relation.title ? (
        <SearchText text={relation.title} query={query ?? ""} />
      ) : (
        "—"
      )}
      {relation.version_number ? <em>图 v{relation.version_number}</em> : null}
    </span>
  );
}

// 页面上每一步只列数量和类型；明细（名字、关系、分片列表）点「详情」在抽屉里分页看，可以按实体、关系类型、关键词分类。
type Detail =
  | {
      kind:
        | "names"
        | "entityFilter"
        | "entityRelations"
        | "relationMatches"
        | "relationCandidates"
        | "relationGrouping";
      dim?: string;
      value?: string;
      stage?: "candidates" | "pool" | "kept";
    }
  | { kind: "chunks"; table: "entity" | "relation" }
  | { kind: "chunksAll" };

const CHUNK_TABLES = {
  entity: "图 · 实体（来自 ④）",
  relation: "图 · 关系（来自 ⑤）",
};
const PAGE_SIZE = 6;

// 两张表的分片合并去重：同一片在两张表里都出现过，取更高的分、合并两条表里的关系，
// 名次按分重排（和后端 chunk_table 一样，分取这一片对应关系里最高的那条）。
function mergeChunkTables(tables: GraphTrace["tables"]) {
  if (tables.unified)
    return tables.unified
      .filter((row) => row.kept !== false)
      .sort((a, b) => b.score - a.score);
  const merged = new Map<string, GraphRetrievalTable>();
  for (const table of [tables.entity ?? [], tables.relation ?? []]) {
    for (const row of table) {
      // 不在当前文档版本的分片没有进过来源，不算进合计。
      if (row.kept === false) continue;
      const previous = merged.get(row.chunk_id);
      if (!previous) {
        merged.set(row.chunk_id, {
          ...row,
          relation_ids: [...row.relation_ids],
        });
        continue;
      }
      previous.score = Math.max(previous.score, row.score);
      for (const id of row.relation_ids)
        if (!previous.relation_ids.includes(id)) previous.relation_ids.push(id);
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

type CountGroup = {
  key: string;
  total: number;
  kept: number;
  score: number;
  // 留下的项里，按第二个维度（实体、关系类型）各有几条
  distinct: Map<string, number>;
};

// 按第一个维度分组计数（保持第一次出现的顺序）。
function groupCounts<
  T extends { kept: boolean; score?: number | null; rerank_score?: number },
>(
  items: T[],
  key: (item: T) => string,
  distinct: (item: T) => string,
): CountGroup[] {
  const groups = new Map<string, CountGroup>();
  for (const item of items) {
    const name = key(item) || "—";
    const group = groups.get(name) ?? {
      key: name,
      total: 0,
      kept: 0,
      score: -Infinity,
      distinct: new Map(),
    };
    group.total += 1;
    group.score = Math.max(
      group.score,
      item.rerank_score ?? item.score ?? -Infinity,
    );
    if (item.kept) {
      group.kept += 1;
      const value = distinct(item) || "—";
      group.distinct.set(value, (group.distinct.get(value) ?? 0) + 1);
    }
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

function DetailButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="link-button button-sm grt-detail-button"
      onClick={onClick}
    >
      详情
    </button>
  );
}

// 一步的数量表：每组一行，匹配多少、留下多少，第二个维度只给类型和数量（或个数），每行一个「详情」。
function CountTable({
  first,
  groups,
  unit,
  distinctLabel,
  distinctUnit,
  renderDistinct,
  onDetail,
}: {
  first: string;
  groups: CountGroup[];
  unit: string;
  distinctLabel: string;
  // 给了单位就只显示有几种（例如「3 个」实体）；不给就列出每种各几条（例如「投资 5 · 创办 2」）。
  distinctUnit?: string;
  // 自定义第二个维度的显示（例如直接列出留下的实体名字）；给了就不用上面两种。
  renderDistinct?: (group: CountGroup) => ReactNode;
  onDetail: (key: string) => void;
}) {
  const [page, setPage] = useState(1);
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(groups.length / PAGE_SIZE)),
  );
  return (
    <>
      <Table className="diag-table grt-table grt-count-table">
        <thead>
          <tr>
            <th>{first}</th>
            <th>匹配到</th>
            <th>留下</th>
            <th>{distinctLabel}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups
            .slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
            .map((group) => (
              <tr key={group.key}>
                <td>{group.key}</td>
                <td className="num">
                  {group.total} {unit}
                </td>
                <td className="num">{group.kept}</td>
                <td>
                  {group.distinct.size === 0
                    ? "—"
                    : renderDistinct
                      ? renderDistinct(group)
                      : distinctUnit
                        ? `${group.distinct.size} ${distinctUnit}`
                        : [...group.distinct.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .map(([name, count]) => `${name} ${count}`)
                            .join(" · ")}
                </td>
                <td className="grt-count-action">
                  <button
                    type="button"
                    className="link-button button-sm"
                    onClick={() => onDetail(group.key)}
                  >
                    详情
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
      {groups.length > PAGE_SIZE && (
        <Pager page={current} total={groups.length} onPage={setPage} />
      )}
    </>
  );
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <TablePagination
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPage}
    />
  );
}

type NameMatch = GraphTrace["name_matches"][number];
// hue：这个维度的值是关系类型，按 hues.ts 的 labelHue 上色，和图谱里的关系类型一个颜色。
type Dim<T> = {
  key: string;
  label: string;
  value: (item: T) => string;
  hue?: boolean;
};

const MATCH_LABELS = {
  exact: "字面相同",
  contains: "字面包含",
  vector: "向量",
};
// 结果这一维：留下的算一类，去掉的按原因分开（原因里带具体数字，但同一次检索里是稳定的）。
const resultLabel = (item: { kept: boolean; reason?: string | null }) =>
  item.kept ? "留下" : item.reason || "去掉";
const NAME_DIMS: Dim<NameMatch>[] = [
  { key: "keyword", label: "按关键词", value: (item) => item.keyword },
  {
    key: "match",
    label: "按匹配方式",
    value: (item) => MATCH_LABELS[item.match ?? "vector"],
  },
  {
    key: "entity",
    label: "按实体",
    value: (item) => item.entity_name ?? "—",
  },
  {
    key: "result",
    label: "按结果",
    value: resultLabel,
  },
];
const ENTITY_RELATION_DIMS: Dim<RelationRow>[] = [
  {
    key: "entity",
    label: "按实体",
    value: (item) => item.entity_name ?? "—",
  },
  {
    key: "category",
    label: "按关系类型",
    value: (item) => item.category,
    hue: true,
  },
  {
    key: "result",
    label: "按结果",
    value: resultLabel,
  },
];
const RELATION_MATCH_DIMS: Dim<RelationRow>[] = [
  { key: "keyword", label: "按关键词", value: (item) => item.keyword ?? "—" },
  {
    key: "category",
    label: "按关系类型",
    value: (item) => item.category,
    hue: true,
  },
  {
    key: "result",
    label: "按结果",
    value: resultLabel,
  },
];

// 搜索只看这一行看得见的文字：把每个单元格的内容拼起来，任何一处命中就显示这一行。
function nameHaystack(match: NameMatch) {
  return buildHaystack([
    match.keyword,
    match.name,
    match.entity_name,
    match.entity_type,
    match.vector_text,
    match.title,
    match.version_number ? `图 v${match.version_number}` : "",
    MATCH_LABELS[match.match ?? "vector"],
    match.score,
    match.gap,
    match.kept ? "留下" : match.reason || "去掉",
  ]);
}

function relationHaystack(row: RelationRow, first: string) {
  return buildHaystack([
    first,
    row.source,
    row.source_entity,
    row.source_type,
    row.target,
    row.target_entity,
    row.target_type,
    row.category,
    row.description,
    row.evidence,
    row.title,
    row.version_number ? `图 v${row.version_number}` : "",
    row.kept ? "留下" : row.reason || "去掉",
    row.score,
    row.vector_score,
    row.keyword_score,
    row.fusion_score,
    row.rerank_score,
    row.vector_rank,
    row.keyword_rank,
    row.fusion_rank,
    row.rerank_rank,
  ]);
}

function chunkHaystack(
  row: GraphRetrievalTable,
  relations: Map<string, GraphRetrievalRelation>,
) {
  const linked = row.relation_ids
    .map((id) => relations.get(id))
    .filter((item): item is GraphRetrievalRelation => !!item);
  return buildHaystack([
    row.title,
    row.heading,
    row.text,
    row.chunk_id,
    row.relation_ids.join(" "),
    row.rank,
    row.score,
    row.version,
    row.reason,
    // 「来自哪些关系」这一列里看得见的名字和关系类型，也算这一行的内容。
    ...linked.flatMap((item) => [
      item.source,
      item.target,
      item.category,
      item.description,
      item.evidence,
    ]),
  ]);
}

// 明细列表：上面选分类方式和分类值，可以带上去掉的项，右上角可以按内容搜索，下面分页。
// 搜索、分类、「包括去掉的」三个条件取交集；搜索只看这一行可见的文字，不看没显示的字段。
function useDetailList<
  T extends { kept: boolean; score?: number | null; sort_score?: number },
>(
  items: T[],
  dims: Dim<T>[],
  initialDim?: string,
  initialValue?: string,
  searchOf?: (item: T) => string,
) {
  const [dimKey, setDimKey] = useState(initialDim ?? dims[0]?.key ?? "");
  const [value, setValue] = useState<string | null>(initialValue ?? null);
  // 默认列出全部（包括去掉的，按分数降序），能看到匹配到的每一项和去掉的原因；可以取消勾选只看留下的。
  const [dropped, setDropped] = useState(true);
  const [page, setPage] = useState(1);
  const [query, setQueryState] = useState("");
  const dim = dims.find((item) => item.key === dimKey);
  const pool = dropped ? items : items.filter((item) => item.kept);
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    if (dim)
      for (const item of pool)
        counts.set(dim.value(item), (counts.get(dim.value(item)) ?? 0) + 1);
    return [...counts.entries()];
  }, [pool, dim]);
  const needle = normalizeSearch(query);
  const byDim =
    dim && value !== null
      ? pool.filter((item) => dim.value(item) === value)
      : pool;
  const filtered = needle
    ? byDim.filter((item) => (searchOf?.(item) ?? "").includes(needle))
    : byDim;
  const ordered = [...filtered].sort(
    (a, b) =>
      (b.sort_score ?? b.score ?? -Infinity) -
      (a.sort_score ?? a.score ?? -Infinity),
  );
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  return {
    dims,
    dimKey,
    setDim: (key: string) => {
      setDimKey(key);
      setValue(null);
      setPage(1);
    },
    options,
    value,
    setValue: (next: string | null) => {
      setValue(next);
      setPage(1);
    },
    dropped,
    droppedCount: items.filter((item) => !item.kept).length,
    setDropped: (next: boolean) => {
      setDropped(next);
      setPage(1);
    },
    query,
    setQuery: (next: string) => {
      setQueryState(next);
      setPage(1);
    },
    total: ordered.length,
    poolTotal: pool.length,
    page: current,
    setPage,
    rows: ordered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
  };
}

function DetailFilters<T extends { kept: boolean }>({
  list,
  more,
  placeholder,
}: {
  list: ReturnType<typeof useDetailList<T>>;
  more?: number;
  placeholder?: string;
}) {
  // 关系类型这一维按 hues.ts 的 labelHue 上色，和图谱里的关系类型一个颜色。
  const hueDim = list.dims.find((item) => item.key === list.dimKey)?.hue;
  return (
    <div className="grt-filters">
      <div className="grt-filter-top">
        {list.dims.length > 1 && (
          <div className="grt-chips" role="tablist">
            {list.dims.map((dim) => (
              <button
                key={dim.key}
                type="button"
                role="tab"
                aria-selected={list.dimKey === dim.key}
                className={`grt-chip is-dim${list.dimKey === dim.key ? " is-active" : ""}`}
                onClick={() => list.setDim(dim.key)}
              >
                {dim.label}
              </button>
            ))}
          </div>
        )}
        {/* 搜索框在右上角：按这一行看得见的文字过滤，和分类、「包括去掉的」取交集。 */}
        <div className="grt-search">
          <input
            type="search"
            className="input-sm"
            value={list.query}
            placeholder={placeholder ?? "搜索"}
            aria-label={placeholder ?? "搜索"}
            onChange={(event) => list.setQuery(event.target.value)}
          />
          {list.query && (
            <button
              type="button"
              className="link-button button-sm"
              onClick={() => list.setQuery("")}
            >
              清空
            </button>
          )}
        </div>
      </div>
      {list.dims.length > 0 && (
        <div className="grt-chips">
          <button
            type="button"
            className={`grt-chip${list.value === null ? " is-active" : ""}`}
            onClick={() => list.setValue(null)}
          >
            全部 <em>{list.poolTotal}</em>
          </button>
          {list.options.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={`grt-chip${list.value === name ? " is-active" : ""}${hueDim ? " is-hue" : ""}`}
              style={
                hueDim
                  ? ({ "--tag-h": labelHue(name) } as CSSProperties)
                  : undefined
              }
              onClick={() => list.setValue(name)}
            >
              {name} <em>{count}</em>
            </button>
          ))}
        </div>
      )}
      {list.droppedCount > 0 && (
        <label className="grt-dropped-toggle">
          <input
            type="checkbox"
            checked={list.dropped}
            onChange={(event) => list.setDropped(event.target.checked)}
          />
          包括去掉的 {list.droppedCount} 条
          {more ? `（另有 ${more} 条只记了数量）` : ""}
        </label>
      )}
    </div>
  );
}

const DETAIL_TITLES = {
  relationGrouping: "⑦ 关系分组",
  relationCandidates: "⑥ 候选合并与关系重排",
  names: "② 找实体 · 匹配到的名字",
  entityFilter: "③ 实体过滤 · 分数与差距",
  entityRelations: "④ 实体的关系",
  relationMatches: "⑤ 找关系",
};

function TraceDetail({
  graph,
  detail,
  chunks,
  relations,
  onClose,
}: {
  graph: GraphTrace;
  detail: Detail;
  chunks: Map<string, ChunkInfo>;
  relations: Map<string, GraphRetrievalRelation>;
  onClose: () => void;
}) {
  const title =
    detail.kind === "chunks"
      ? `${graph.relation_grouping?.enabled ? "⑧" : graph.pipeline ? "⑦" : "⑥"} 取分片 · ${CHUNK_TABLES[detail.table]}`
      : detail.kind === "chunksAll"
        ? `${graph.relation_grouping?.enabled ? "⑧" : graph.pipeline ? "⑦" : "⑥"} 取分片 · 合计 ${graph.counts?.chunks ?? 0} 个分片`
        : detail.kind === "relationCandidates" && detail.stage
          ? `⑥ ${detail.stage === "candidates" ? "全部候选" : detail.stage === "pool" ? "进入重排" : "最终留下"} · 关系与原文`
          : DETAIL_TITLES[detail.kind];
  // 实体详情：点匹配到的名字或关系里的实体打开，内容和图谱里点实体一样。
  const [entity, setEntity] = useState<{
    id: string;
    documentId: string;
  } | null>(null);
  const openEntity = (entityId: string, documentId: string) =>
    setEntity({ id: entityId, documentId });
  // 两张关系表里的「关系相似度」是不同东西在比：③ 是「问题 × 关系」，④ 是「概括关键词 × 关系」。
  // 表头说不清，表格上方补一句，写明是哪两个在算。
  const relationVectorText = "起点 → 终点（分类）：描述";
  const question = graph.keywords?.question;
  const entityScoreHint = graph.pipeline
    ? "完整问题在每个实体的一跳关系内做向量和关键词检索，融合后参与统一关系重排。"
    : question
      ? `关系相似度 = 这次的问题「${question}」和这条关系的文字（${relationVectorText}）的相似度`
      : `关系相似度 = 这次的问题和这条关系的文字（${relationVectorText}）的相似度`;
  const relationScoreHint = graph.pipeline
    ? "完整问题在可见关系库中检索；向量和关键词排名融合后参与统一重排。"
    : `关系相似度 = 这一行的概括关键词和这条关系的文字（${relationVectorText}）的相似度`;
  return (
    <DetailDialog
      open
      title={title}
      className="grt-dialog"
      size="table"
      onClose={onClose}
    >
      {/* 抽屉可能挂在别的弹窗里，不在 .diag 下面：自己带上 .diag，表格颜色变量才对。 */}
      <div className="diag grt">
        {(detail.kind === "names" || detail.kind === "entityFilter") && (
          <NamesDetail graph={graph} detail={detail} onEntity={openEntity} />
        )}
        {detail.kind === "entityRelations" && (
          <RelationsDetail
            trace={graph}
            rows={graph.entity_relations}
            dims={ENTITY_RELATION_DIMS}
            detail={detail}
            more={graph.dropped_more?.entity_relations}
            first="实体"
            firstValue={(row) => row.entity_name ?? ""}
            chunks={chunks}
            scoreHint={entityScoreHint}
            onEntity={openEntity}
          />
        )}
        {detail.kind === "relationMatches" && (
          <RelationsDetail
            trace={graph}
            rows={graph.relation_matches}
            dims={RELATION_MATCH_DIMS}
            detail={detail}
            more={graph.dropped_more?.relation_matches}
            first={graph.pipeline ? "完整问题" : "概括关键词"}
            firstValue={(row) => row.keyword ?? ""}
            chunks={chunks}
            extra={(row) => (row.also_entity ? "和 ④ 重复" : undefined)}
            scoreHint={relationScoreHint}
            onEntity={openEntity}
          />
        )}
        {detail.kind === "relationCandidates" && (
          <RelationsDetail
            trace={graph}
            scoreMode={
              detail.stage === "kept" && !graph.relation_rerank_error
                ? "rerank"
                : "fusion"
            }
            rows={(graph.relation_candidates ?? [])
              .filter((row) =>
                detail.stage === "pool"
                  ? row.in_pool
                  : detail.stage === "kept"
                    ? row.kept
                    : true,
              )
              .map((row) => ({
                ...row,
                sort_score:
                  detail.stage === "kept"
                    ? (row.rerank_score ?? row.score ?? 0)
                    : (row.fusion_score ?? 1 / (row.fusion_rank ?? 1)),
              }))}
            more={
              detail.stage === "candidates" || !detail.stage
                ? graph.dropped_more?.relation_candidates
                : 0
            }
            dims={RELATION_MATCH_DIMS}
            detail={detail}
            first="召回来源"
            firstValue={(row) =>
              row.origins
                ?.map((id) =>
                  id === "global"
                    ? "全局"
                    : (graph.entities.find((item) => item.entity_id === id)
                        ?.name ?? id),
                )
                .join("、") ?? "—"
            }
            chunks={chunks}
            scoreHint={
              graph.relation_rerank_error
                ? `重排失败，按融合排名回退：${graph.relation_rerank_error}`
                : `${detail.stage === "kept" ? "按重排分数从高到低排列" : "按融合分数从高到低排列"}，每页 6 条；原文按钮查看对应完整分片。${graph.dropped_more?.relation_candidates ? "该历史记录未保存全部候选明细，以下只展示已保存记录。" : ""}`
            }
            onEntity={openEntity}
          />
        )}
        {detail.kind === "relationGrouping" && (
          <RelationGroupsDetail graph={graph} chunks={chunks} />
        )}
        {detail.kind === "chunks" && (
          <ChunksDetail
            rows={graph.tables[detail.table]}
            relations={relations}
          />
        )}
        {detail.kind === "chunksAll" && (
          <ChunksDetail
            rows={mergeChunkTables(graph.tables)}
            relations={relations}
          />
        )}
        {entity && (
          <GraphEntityDialog
            entityId={entity.id}
            documentId={entity.documentId}
            onClose={() => setEntity(null)}
          />
        )}
      </div>
    </DetailDialog>
  );
}

function NamesDetail({
  graph,
  detail,
  onEntity,
}: {
  graph: GraphTrace;
  detail: { dim?: string; value?: string };
  onEntity?: (entityId: string, documentId: string) => void;
}) {
  const list = useDetailList(
    graph.name_matches,
    NAME_DIMS,
    detail.dim,
    detail.value,
    nameHaystack,
  );
  return (
    <>
      <DetailFilters
        list={list}
        more={graph.dropped_more?.names}
        placeholder="搜关键词、名字或出处"
      />
      <Table
        containerProps={{ className: "diag-table-wrap" }}
        className="diag-table grt-table"
      >
        <thead>
          <tr>
            <th>具体关键词</th>
            <th>匹配到的名字</th>
            <th>算向量用的文字</th>
            <th>出自</th>
            <th>匹配方式</th>
            <th>归到实体</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {list.rows.map((match, index) => (
            <tr
              key={`${match.keyword}-${match.entity_id}-${match.name}-${index}`}
              className={match.kept ? "" : "is-dropped"}
            >
              <td>
                <SearchText text={match.keyword} query={list.query} />
              </td>
              <td>
                {/* 匹配到的名字点开看实体详情，和图谱里点实体一样。 */}
                {onEntity && match.entity_id ? (
                  <button
                    type="button"
                    className="link-button button-sm"
                    title={`看实体「${match.entity_name ?? match.name}」的详情`}
                    onClick={() => onEntity(match.entity_id, match.document_id)}
                  >
                    <SearchText text={match.name} query={list.query} />
                  </button>
                ) : (
                  <SearchText text={match.name} query={list.query} />
                )}
              </td>
              <td>
                {/* 名字向量是用这段文字算的：名字（类型）：描述1；描述2 */}
                <span
                  className="grt-vector-text"
                  title={match.vector_text ?? ""}
                >
                  {match.vector_text ? (
                    <SearchText text={match.vector_text} query={list.query} />
                  ) : (
                    "—"
                  )}
                </span>
              </td>
              <td>
                {match.title ? (
                  <SearchText text={match.title} query={list.query} />
                ) : (
                  "—"
                )}
                {match.version_number ? (
                  <em className="grt-v">
                    图 v
                    <SearchText
                      text={String(match.version_number)}
                      query={list.query}
                    />
                  </em>
                ) : null}
              </td>
              <td className="num">
                <Tag size="sm" hue={match.match === "vector" ? 220 : 30}>
                  {match.match === "vector" ? "向量匹配" : "字面匹配"}
                </Tag>
                <small>
                  {match.match === "exact"
                    ? "字面相同 · "
                    : match.match === "contains"
                      ? "字面包含 · "
                      : ""}
                  {graph.name_score_query ? "完整问题相似度 " : "向量相似度 "}
                  {match.score == null ? (
                    "未记录"
                  ) : (
                    <SearchText text={score(match.score)} query={list.query} />
                  )}
                </small>
                {graph.name_score_query && (
                  <small>
                    {match.baseline
                      ? "基准"
                      : match.gap == null
                        ? "无分数，未参与消歧"
                        : match.gap < 0
                          ? `比基准高 ${Math.abs(match.gap).toFixed(2)}`
                          : `比基准低 ${match.gap.toFixed(2)}`}
                  </small>
                )}
              </td>
              <td>
                {match.entity_name ? (
                  <SearchText text={match.entity_name} query={list.query} />
                ) : (
                  "—"
                )}
                {match.entity_type ? (
                  <small>（{match.entity_type}）</small>
                ) : null}
              </td>
              <td>
                <Result
                  kept={match.kept}
                  reason={match.reason}
                  query={list.query}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pager page={list.page} total={list.total} onPage={list.setPage} />
    </>
  );
}

function RelationGroupsDetail({
  graph,
  chunks,
}: {
  graph: GraphTrace;
  chunks: Map<string, ChunkInfo>;
}) {
  const [page, setPage] = useState(1);
  const groups = new Map<string, GraphRetrievalRelation[]>();
  for (const row of [...(graph.relation_candidates ?? [])].sort(
    (a, b) => (a.selection_rank ?? Infinity) - (b.selection_rank ?? Infinity),
  )) {
    if (!row.group_key) continue;
    const key = JSON.stringify(row.group_key);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const rows = [...groups.entries()];
  return (
    <>
      <p>共 {rows.length} 组，每组一行；组内列出全部关系及入选结果。</p>
      <Table className="grt-groups-table">
        <thead>
          <tr>
            <th>实体关系组</th>
            <th>入选 / 总数</th>
            <th>关系明细</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
            .map(([key, group]) => (
              <tr key={key}>
                <td>
                  {group[0].source_entity ?? group[0].source} →{" "}
                  {group[0].category} →{" "}
                  {group[0].target_entity ?? group[0].target}
                </td>
                <td>
                  {group.filter((row) => row.kept).length} / {group.length}
                </td>
                <td>
                  <Table
                    className="diag-table grt-table grt-group-inner"
                    size="compact"
                  >
                    <thead>
                      <tr>
                        <th>关系</th>
                        <th>重排分数</th>
                        <th>出处</th>
                        <th>结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((row) => (
                        <tr
                          key={row.relation_id}
                          className={row.kept ? "" : "is-dropped"}
                        >
                          <td>
                            <RelationText relation={row} />
                          </td>
                          <td>{score(row.rerank_score)}</td>
                          <td>
                            <Origin relation={row} />
                            <OriginalButton
                              relation={row}
                              chunk={chunks.get(row.chunk_id)}
                            />
                          </td>
                          <td>
                            <Result
                              row={row}
                              trace={graph}
                              kept={row.kept}
                              reason={row.reason}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
      <Pager page={page} total={rows.length} onPage={setPage} />
    </>
  );
}

function RelationsDetail({
  trace,
  rows,
  dims,
  detail,
  more,
  first,
  firstValue,
  chunks,
  extra,
  scoreHint,
  scoreMode,
  onEntity,
}: {
  trace?: GraphTrace;
  rows: RelationRow[];
  dims: Dim<RelationRow>[];
  detail: { dim?: string; value?: string };
  more?: number;
  first: string;
  firstValue: (row: RelationRow) => string;
  chunks: Map<string, ChunkInfo>;
  extra?: (row: RelationRow) => string | undefined;
  scoreHint?: string;
  scoreMode?: "fusion" | "rerank";
  onEntity?: (entityId: string, documentId: string) => void;
}) {
  const list = useDetailList(
    rows.map((row) => ({
      ...row,
      sort_score: row.sort_score ?? row.rerank_score ?? row.score ?? 0,
    })),
    dims,
    detail.dim,
    detail.value,
    (row) => relationHaystack(row, firstValue(row)),
  );
  return (
    <>
      <DetailFilters
        list={list}
        more={more}
        placeholder="搜实体、关系描述或原文"
      />
      <RelationTable
        startIndex={(list.page - 1) * PAGE_SIZE}
        trace={trace}
        rows={list.rows}
        first={first}
        firstValue={firstValue}
        chunks={chunks}
        extra={extra}
        scoreHint={scoreHint}
        scoreMode={scoreMode}
        query={list.query}
        onEntity={onEntity}
      />
      <Pager page={list.page} total={list.total} onPage={list.setPage} />
    </>
  );
}

function ChunksDetail({
  rows,
  relations,
}: {
  rows: GraphRetrievalTable[];
  relations: Map<string, GraphRetrievalRelation>;
}) {
  const [result, setResult] = useState("all");
  const items = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            result === "all" || (row.delivery_status ?? "unknown") === result,
        )
        .map((row) => ({ ...row, kept: row.kept !== false })),
    [rows, result],
  );
  const list = useDetailList(items, [], undefined, undefined, (row) =>
    chunkHaystack(row, relations),
  );
  return (
    <>
      <p className="grt-hint">
        共 {rows.length} 片 · 已交给模型{" "}
        {rows.filter((row) => row.delivery_status === "returned").length} 片 ·
        已过滤 {rows.filter((row) => row.delivery_status === "filtered").length}{" "}
        片 · 未记录 {rows.filter((row) => !row.delivery_status).length} 片
      </p>
      <select
        aria-label="分片交付结果"
        value={result}
        onChange={(event) => setResult(event.target.value)}
      >
        <option value="all">全部</option>
        <option value="returned">已交给模型</option>
        <option value="filtered">已过滤</option>
        <option value="unknown">未记录</option>
      </select>
      <DetailFilters list={list} placeholder="搜标题或分片正文" />
      <ChunkTable rows={list.rows} relations={relations} query={list.query} />
      <Pager page={list.page} total={list.total} onPage={list.setPage} />
    </>
  );
}

export function GraphRetrievalTrace({ graph }: { graph: GraphTrace }) {
  const chunks = useMemo(() => {
    const map = new Map<string, ChunkInfo>();
    for (const row of [
      ...(graph.candidate_chunks ?? []),
      ...(graph.tables.unified ?? []),
      ...graph.tables.entity,
      ...graph.tables.relation,
    ])
      if (row.text) map.set(row.chunk_id, row);
    return map;
  }, [graph]);
  const relations = useMemo(() => {
    const map = new Map<string, GraphRetrievalRelation>();
    for (const row of [...graph.entity_relations, ...graph.relation_matches])
      if (!map.has(row.relation_id)) map.set(row.relation_id, row);
    return map;
  }, [graph]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  // 字面命中（名字相同或互相包含）的实体，按「关键词|实体名」记，数量表里给它们标「字面」。
  const literalEntities = useMemo(
    () =>
      new Set(
        graph.name_matches
          .filter((item) => item.kept && item.match && item.match !== "vector")
          .map(
            (item) => `${item.keyword}|${item.entity_name ?? item.entity_id}`,
          ),
      ),
    [graph],
  );
  const words = graph.keywords;
  const settings = graph.settings ?? {};
  if (graph.status !== "ok")
    return (
      <div className="grt">
        <p className={`grt-status is-${graph.status}`}>
          {graph.status === "failed" ? "图检索失败" : "没有走图检索"}：
          {graph.reason}
        </p>
      </div>
    );
  return (
    <div className="grt">
      <section className="grt-step">
        <h5>
          ① 提关键词
          <small>
            来源：{SOURCE_LABELS[words?.source ?? "model"]}
            {words?.source === "model" && words.duration_ms !== undefined
              ? ` · ${ms(words.duration_ms)}`
              : ""}
            {words?.input_tokens
              ? ` · ${(words.input_tokens ?? 0) + (words.output_tokens ?? 0)} token`
              : ""}
            {words?.prompt_tag ? ` · ${words.prompt_tag}` : ""}
          </small>
        </h5>
        {words?.question && words.source === "model" && (
          <p className="grt-question">
            根据问题「{words.question}」提取关键词
            {words.question_source ? ` · ${words.question_source}` : ""}
          </p>
        )}
        {words?.question && words.source !== "model" && (
          <p className="grt-question">
            这次检索用的问题「{words.question}」
            {words.question_source ? ` · ${words.question_source}` : ""}
          </p>
        )}
        {words?.reason && <p className="grt-note">{words.reason}</p>}
        <Table className="diag-table grt-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>关键词</th>
              <th>用途</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>具体</td>
              <td>{words?.entities.join("、") || "—"}</td>
              <td>找实体（名字向量）</td>
            </tr>
            {!graph.pipeline && (
              <tr>
                <td>概括</td>
                <td>{words?.themes.join("、") || "—"}</td>
                <td>找关系（关系向量）</td>
              </tr>
            )}
          </tbody>
        </Table>
        {words?.prompt && (
          <button
            type="button"
            className="link-button"
            onClick={() => setPromptOpen(true)}
          >
            发给模型的提示词和原始输出
          </button>
        )}
      </section>

      <section className="grt-step">
        <h5>
          ② 找实体
          <small>
            {graph.name_score_query
              ? `关键词召回候选：字面匹配＋名字向量前 ${settings.graph_name_top_k ?? 10} 个`
              : "关键词字面匹配＋名字向量召回"}
          </small>
          <DetailButton
            count={graph.name_matches.length}
            onClick={() => setDetail({ kind: "names" })}
          />
        </h5>
        <Table className="diag-table grt-table">
          <thead>
            <tr>
              <th>关键词</th>
              <th>召回名字</th>
              <th>归属实体</th>
            </tr>
          </thead>
          <tbody>
            {[...new Set(graph.name_matches.map((item) => item.keyword))].map(
              (keyword) => {
                const matches = graph.name_matches.filter(
                  (item) => item.keyword === keyword,
                );
                return (
                  <tr key={keyword}>
                    <td>{keyword}</td>
                    <td>{matches.length}</td>
                    <td>
                      {new Set(matches.map((item) => item.entity_id)).size}
                    </td>
                  </tr>
                );
              },
            )}
          </tbody>
        </Table>
      </section>
      <section className="grt-step">
        <h5>
          ③ 实体过滤
          <small>
            完整问题消歧 → 按归属合并 → 每个关键词最多{" "}
            {settings.graph_entity_top_k ?? 6} 个实体
          </small>
          <DetailButton
            count={graph.name_matches.length}
            onClick={() => setDetail({ kind: "entityFilter" })}
          />
        </h5>
        {graph.name_score_query && (
          <p className="grt-note">
            <button
              type="button"
              className="secondary-button button-sm"
              onClick={() => setDetail({ kind: "entityFilter" })}
            >
              完整问题消歧过滤 · 查看分数与差距
            </button>{" "}
            消歧过滤：用完整问题「{graph.name_score_query}
            」与候选的名字、类型、描述计算相似度；
            每个关键词以字面命中最高分为基准，无字面命中则取向量候选最高分，
            比基准低超过 {settings.graph_entity_score_gap ?? 0.03}{" "}
            的去掉，再限制实体数量。
          </p>
        )}
        {!graph.name_score_query && (
          <p className="grt-note">
            历史记录未保存完整问题消歧信息，以下展示当时的实体筛选结果。
          </p>
        )}
        {graph.name_matches.length === 0 ? (
          <p className="grt-empty">没有匹配到名字</p>
        ) : (
          <CountTable
            first="具体关键词"
            groups={groupCounts(
              graph.name_matches,
              (item) => item.keyword,
              (item) => item.entity_name ?? item.entity_id,
            )}
            unit="个名字"
            distinctLabel="留下的实体"
            renderDistinct={(group) => (
              <span className="grt-entity-list">
                {[...group.distinct.keys()].map((name) => (
                  <span key={name}>
                    {name}
                    {literalEntities.has(`${group.key}|${name}`) && (
                      <small className="grt-literal">字面</small>
                    )}
                  </span>
                ))}
              </span>
            )}
            onDetail={(key) =>
              setDetail({ kind: "entityFilter", dim: "keyword", value: key })
            }
          />
        )}
        <p className="grt-summary">
          {graph.entities.length
            ? `合计找到 ${graph.entities.length} 个实体`
            : "没有找到实体"}
        </p>
      </section>

      <section className="grt-step">
        <h5>
          ④ 实体的关系
          <small>
            {graph.pipeline ? (
              `完整问题 → 每个实体一跳关系内的向量＋关键词检索，每路最多 ${settings.graph_entity_relation_limit ?? 100} 条 → 融合排名`
            ) : (
              <>
                一跳：找到的实体直接相连的关系，按和问题的相似度排序（相似度 ≥{" "}
                {settings.graph_entity_min_score ?? 0.5}
                ），每个实体最多 {settings.graph_entity_relation_limit ??
                  30}{" "}
                条，连到同一个实体的只留一条
              </>
            )}
          </small>
          <DetailButton
            count={graph.entity_relations.length}
            onClick={() => setDetail({ kind: "entityRelations" })}
          />
        </h5>
        {graph.entity_relations.length === 0 ? (
          <p className="grt-empty">没有找到关系</p>
        ) : (
          <CountTable
            first="实体"
            groups={groupCounts(
              graph.entity_relations,
              (item) => item.entity_name ?? item.entity_id,
              (item) => item.category,
            )}
            unit="条关系"
            distinctLabel="关系类型"
            onDetail={(key) =>
              setDetail({ kind: "entityRelations", dim: "entity", value: key })
            }
          />
        )}
      </section>

      <section className="grt-step">
        <h5>
          ⑤ 找关系
          <small>
            {graph.pipeline ? (
              `完整问题 → 可见关系库向量＋关键词检索，每路最多 ${settings.graph_relation_top_k ?? 100} 条 → 融合排名`
            ) : (
              <>
                概括关键词 → 关系向量（相似度 ≥{" "}
                {settings.graph_relation_min_score ?? 0.5}
                ，每个关键词前 {settings.graph_relation_top_k ?? 20} 条）
              </>
            )}
          </small>
          <DetailButton
            count={graph.relation_matches.length}
            onClick={() => setDetail({ kind: "relationMatches" })}
          />
        </h5>
        {graph.relation_matches.length === 0 ? (
          <p className="grt-empty">没有找到关系</p>
        ) : (
          <CountTable
            first={graph.pipeline ? "完整问题" : "概括关键词"}
            groups={groupCounts(
              graph.relation_matches,
              (item) => item.keyword,
              (item) => item.category,
            )}
            unit="条关系"
            distinctLabel="关系类型"
            onDetail={(key) =>
              setDetail({ kind: "relationMatches", dim: "keyword", value: key })
            }
          />
        )}
      </section>

      {graph.pipeline && (
        <section className="grt-step">
          <h5>
            ⑥ 候选合并与关系重排
            <DetailButton
              count={
                graph.relation_candidate_counts?.total ??
                graph.relation_candidates?.length ??
                0
              }
              onClick={() => setDetail({ kind: "relationCandidates" })}
            />
          </h5>
          <p>
            每实体保底 {settings.graph_entity_relation_quota ?? 5} 条，全局保底{" "}
            {settings.graph_global_relation_quota ?? 10}{" "}
            条；去重后公共竞争，最多{" "}
            {settings.graph_relation_rerank_candidates ?? 100}{" "}
            条进入重排，最多保留 {settings.graph_relation_return_limit ?? 30}{" "}
            条。
            {graph.relation_grouping?.enabled
              ? "达标关系交给下一步分组选择。"
              : "按重排分数选择。"}
          </p>
          <ol className="grt-stages" aria-label="关系候选筛选步骤">
            {(
              [
                {
                  stage: "candidates",
                  label: "候选",
                  count:
                    graph.relation_candidate_counts?.total ??
                    graph.relation_candidates?.length ??
                    0,
                },
                {
                  stage: "pool",
                  label: "进入重排",
                  count:
                    graph.relation_candidate_counts?.in_pool ??
                    graph.relation_candidates?.filter((row) => row.in_pool)
                      .length ??
                    0,
                },
                {
                  stage: "kept",
                  label: "留下",
                  count:
                    graph.relation_candidate_counts?.kept ??
                    graph.relation_candidates?.filter((row) => row.kept)
                      .length ??
                    0,
                },
              ] as const
            ).map((item, index) => (
              <li key={item.stage}>
                <button
                  type="button"
                  className="secondary-button"
                  title={`查看${item.label}的 ${item.count} 条关系及对应分片`}
                  onClick={() =>
                    setDetail({ kind: "relationCandidates", stage: item.stage })
                  }
                >
                  <span className="grt-stage-number">{index + 1}</span>
                  {item.label} {item.count} 条
                </button>
                {index < 2 && (
                  <span className="grt-stage-arrow" aria-hidden="true">
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
          {graph.relation_rerank_error && (
            <p>
              关系重排未完成，已回退到融合排名：{graph.relation_rerank_error}
            </p>
          )}
          <p className="grt-summary">
            留下的关系不进 RRF
            融合，也不进分片重排：一边用来取出处分片，一边按预算直接放进回答上下文。
          </p>
        </section>
      )}
      {graph.relation_grouping?.enabled && (
        <section className="grt-step">
          <h5>
            ⑦ 关系分组
            {graph.relation_grouping.applied && (
              <DetailButton
                count={graph.relation_grouping.eligible}
                onClick={() =>
                  setDetail({ kind: "relationGrouping", dim: "group" })
                }
              />
            )}
          </h5>
          {graph.relation_grouping.applied ? (
            <p>
              {graph.relation_grouping.eligible} 条达标关系，分为{" "}
              {graph.relation_grouping.groups} 组； 分轮选入{" "}
              {graph.relation_grouping.selected} 条，覆盖{" "}
              {graph.relation_grouping.selected_groups} 组。
              每组先选一条，再选第二条，每轮按重排分数排序；最多保留{" "}
              {settings.graph_relation_return_limit ?? 30} 条。
            </p>
          ) : (
            <p>关系重排未成功，本次未应用分组，按融合排名选择。</p>
          )}
        </section>
      )}
      <section className="grt-step">
        <h5>
          {graph.relation_grouping?.enabled
            ? "⑧ 取分片"
            : graph.pipeline
              ? "⑦ 取分片"
              : "⑥ 取分片"}
          <small>
            {graph.pipeline
              ? "保留关系的出处分片，同一片去重并保留关系 ID；按关系选择顺序排列。其他路也找到的分片参加 RRF 融合；只被图找到的按这个顺序单独进重排（有上限）。"
              : "关系的出处分片，同一片去重，名次按这一片对应的关系里相似度最高的那条"}
          </small>
        </h5>
        {graph.pipeline ? (
          <button
            type="button"
            className="secondary-button"
            title="查看去重后的分片、对应关系和原文"
            onClick={() => setDetail({ kind: "chunksAll" })}
          >
            留下{" "}
            {graph.relation_candidate_counts?.kept ??
              new Set(
                [...graph.entity_relations, ...graph.relation_matches]
                  .filter((row) => row.kept)
                  .map((row) => row.relation_id),
              ).size}{" "}
            条关系 → 去重得到{" "}
            {graph.counts?.chunks ?? mergeChunkTables(graph.tables).length}{" "}
            个分片　›
          </button>
        ) : (
          <>
            <Table className="diag-table grt-table grt-count-table">
              <thead>
                <tr>
                  <th>排名表</th>
                  <th>分片</th>
                  <th>来自关系</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(["entity", "relation"] as const).map((name) => {
                  const rows = graph.tables[name];
                  const kept = rows.filter((row) => row.kept !== false).length;
                  const linked = new Set(
                    rows.flatMap((row) => row.relation_ids),
                  ).size;
                  return (
                    <tr key={name}>
                      <td>{CHUNK_TABLES[name]}</td>
                      <td className="num">
                        {kept} 个
                        {rows.length > kept ? (
                          <small>
                            另有 {rows.length - kept} 个不在当前版本
                          </small>
                        ) : null}
                      </td>
                      <td className="num">{linked} 条</td>
                      <td className="grt-count-action">
                        {rows.length > 0 && (
                          <button
                            type="button"
                            className="link-button button-sm"
                            onClick={() =>
                              setDetail({ kind: "chunks", table: name })
                            }
                          >
                            详情
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="grt-summary">
              {/* 合计这行点开看这批分片：两张表的分片合并去重后的完整清单。 */}
              <button
                type="button"
                className="link-button"
                title="点开看这批分片的完整清单"
                onClick={() => setDetail({ kind: "chunksAll" })}
              >
                合计 {graph.counts?.chunks ?? 0} 个分片
              </button>
              {graph.counts &&
              graph.counts.entity_chunks + graph.counts.relation_chunks >
                graph.counts.chunks
                ? `（两张表有 ${graph.counts.entity_chunks + graph.counts.relation_chunks - graph.counts.chunks} 个重复）`
                : ""}
            </p>
          </>
        )}
      </section>

      <section className="grt-step">
        <h5>
          {graph.relation_grouping?.enabled
            ? "⑨ 关系图"
            : graph.pipeline
              ? "⑧ 关系图"
              : "⑦ 关系图"}
          <small>只画这道题用到的部分</small>
        </h5>
        <GraphRetrievalMap graph={graph} chunks={chunks} />
      </section>
      {detail && (
        <TraceDetail
          graph={graph}
          detail={detail}
          chunks={chunks}
          relations={relations}
          onClose={() => setDetail(null)}
        />
      )}
      {promptOpen && words?.prompt && (
        <DetailDialog
          open
          title="发给模型的提示词和原始输出"
          onClose={() => setPromptOpen(false)}
        >
          {words.prompt.map((message, index) => (
            <pre className="grt-pre" key={index}>
              {message.role === "system" ? "系统：" : "用户："}
              {message.content}
            </pre>
          ))}
          <pre className="grt-pre">
            输出：{words.raw_output || words.error || "（空）"}
          </pre>
        </DetailDialog>
      )}
    </div>
  );
}

type RelationRow = GraphRetrievalRelation &
  Partial<{
    entity_name: string | null;
    keyword: string;
    also_entity: boolean;
  }>;

function RelationTable({
  trace,
  startIndex = 0,
  rows,
  first,
  firstValue,
  chunks,
  extra,
  scoreHint,
  scoreMode,
  query,
  onEntity,
}: {
  trace?: GraphTrace;
  startIndex?: number;
  rows: RelationRow[];
  first: string;
  firstValue: (row: RelationRow) => string;
  chunks: Map<string, ChunkInfo>;
  extra?: (row: RelationRow) => string | undefined;
  // 这一列的分数是哪两个东西算出来的（问题 × 关系 / 关键词 × 关系），说清楚免得看不懂。
  scoreHint?: string;
  scoreMode?: "fusion" | "rerank";
  query?: string;
  onEntity?: (entityId: string, documentId: string) => void;
}) {
  if (rows.length === 0)
    return (
      <p className="grt-empty">
        {query ? `没有匹配「${query}」的关系` : "没有找到关系"}
      </p>
    );
  return (
    <>
      {scoreHint && <p className="grt-hint">{scoreHint}</p>}
      <Table
        containerProps={{ className: "diag-table-wrap" }}
        className="diag-table grt-table"
      >
        <thead>
          <tr>
            <th>序号</th>
            <th>{first}</th>
            <th>关系</th>
            <th>
              {scoreMode
                ? scoreMode === "fusion"
                  ? "融合分数"
                  : "重排分数"
                : rows.some((row) => row.fusion_rank !== undefined)
                  ? "检索与重排名次"
                  : "关系相似度"}
            </th>
            <th>出处</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.relation_id}-${index}`}
              className={row.kept ? "" : "is-dropped"}
            >
              <td className="num">{startIndex + index + 1}</td>
              <td>
                <SearchText text={firstValue(row)} query={query ?? ""} />
              </td>
              <td>
                <RelationText
                  relation={row}
                  onEntity={onEntity}
                  query={query}
                />
              </td>
              <td className="num">
                {scoreMode === "fusion" ? (
                  <>
                    {row.fusion_score?.toFixed(6) ?? "—"}
                    <small className="grt-score-ranks">
                      向量排名 {row.vector_rank ?? "—"}
                    </small>
                    <small className="grt-score-ranks">
                      关键词排名 {row.keyword_rank ?? "—"}
                    </small>
                  </>
                ) : scoreMode === "rerank" ? (
                  <>
                    {row.rerank_score?.toFixed(4) ?? "—"}
                    <small className="grt-score-ranks">
                      融合排名 {row.fusion_rank ?? "—"}
                    </small>
                  </>
                ) : row.fusion_rank !== undefined ? (
                  <>
                    <div className="grt-score-vector">
                      向量 {row.vector_rank ?? "—"} / {score(row.vector_score)}
                    </div>
                    <div className="grt-score-keyword">
                      关键词 {row.keyword_rank ?? "—"} /{" "}
                      {score(row.keyword_score)}
                    </div>
                    <div className="grt-score-fusion">
                      融合 {row.fusion_rank} /{" "}
                      {row.fusion_score?.toFixed(6) ?? "—"}{" "}
                      {row.selection ? (
                        <span
                          className="grt-category is-hue"
                          style={
                            {
                              "--tag-h": row.selection.includes("保底")
                                ? 145
                                : 275,
                            } as CSSProperties
                          }
                        >
                          {row.selection}
                        </span>
                      ) : null}
                    </div>
                    <div className="grt-score-rerank">
                      重排 {row.rerank_rank ?? "—"} / {score(row.rerank_score)}
                    </div>
                  </>
                ) : (
                  score(row.score)
                )}
              </td>
              <td>
                <Origin relation={row} query={query} />
                <OriginalButton
                  relation={row}
                  chunk={chunks.get(row.chunk_id)}
                />
              </td>
              <td>
                <Result
                  kept={row.kept}
                  reason={row.reason}
                  extra={extra?.(row)}
                  row={row}
                  trace={trace}
                  query={query}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function ChunkTable({
  rows,
  relations,
  query,
}: {
  rows: GraphRetrievalTable[];
  relations: Map<string, GraphRetrievalRelation>;
  query?: string;
}) {
  return (
    <div className="diag-table-wrap">
      {rows.length === 0 ? (
        <p className="grt-empty">
          {query ? `没有匹配「${query}」的分片` : "没有分片"}
        </p>
      ) : (
        <Table className="diag-table grt-table">
          <thead>
            <tr>
              <th>名次</th>
              <th>分片</th>
              <th>来自哪些关系</th>
              <th title="关联关系排名的倒数，取最高值；不是原文相关度评分">
                关系优先级
              </th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const piece = chunkNumber(row.chunk_id);
              return (
                <tr
                  key={row.chunk_id}
                  className={row.kept === false ? "is-dropped" : ""}
                >
                  <td className="num">{row.kept === false ? "—" : row.rank}</td>
                  <td>
                    {piece && (
                      <small className="grt-secondary">第 {piece} 片</small>
                    )}
                    <span className="diag-title">
                      {row.title ? (
                        <SearchText text={row.title} query={query ?? ""} />
                      ) : (
                        <SearchText text={row.chunk_id} query={query ?? ""} />
                      )}
                    </span>
                    {row.heading ? (
                      <small>
                        <SearchText text={row.heading} query={query ?? ""} />
                      </small>
                    ) : null}
                    {row.kept === false ? (
                      <span className="grt-dropped">
                        ✕ <SearchText text={row.reason} query={query ?? ""} />
                      </span>
                    ) : row.text ? (
                      <InfoPopover
                        title={row.title}
                        content={() => {
                          const linked = row.relation_ids
                            .map((id) => relations.get(id))
                            .filter(
                              (item): item is GraphRetrievalRelation => !!item,
                            );
                          return (
                            <ChunkOriginalText
                              text={row.text ?? ""}
                              groups={[
                                {
                                  kind: "evidence",
                                  texts: linked.flatMap((item) =>
                                    (item.evidence ?? "").split("||"),
                                  ),
                                },
                                {
                                  kind: "entity",
                                  texts: linked.flatMap((item) => [
                                    item.source,
                                    item.target,
                                  ]),
                                },
                              ]}
                            />
                          );
                        }}
                      >
                        <button type="button" className="link-button button-sm">
                          原文
                        </button>
                      </InfoPopover>
                    ) : null}
                  </td>
                  <td>
                    <ul className="grt-linked">
                      {row.relation_ids.map((id) => {
                        const relation = relations.get(id);
                        return (
                          <li key={id}>
                            {relation ? (
                              <span className="grt-rel-line">
                                <SearchText
                                  text={relation.source}
                                  query={query ?? ""}
                                />
                                <span className="grt-arrow">→</span>
                                <small
                                  className="grt-category is-hue"
                                  style={categoryStyle(relation.category)}
                                >
                                  <SearchText
                                    text={relation.category}
                                    query={query ?? ""}
                                  />
                                </small>
                                <span className="grt-arrow">→</span>
                                <SearchText
                                  text={relation.target}
                                  query={query ?? ""}
                                />
                                {relation.origins?.length ? (
                                  <small className="grt-secondary">
                                    来源：
                                    <SearchText
                                      text={relation.origins
                                        .map((origin) =>
                                          origin === "global"
                                            ? "全局关系"
                                            : origin ===
                                                relation.source_entity_id
                                              ? (relation.source_entity ??
                                                relation.source)
                                              : origin ===
                                                  relation.target_entity_id
                                                ? (relation.target_entity ??
                                                  relation.target)
                                                : "实体一跳",
                                        )
                                        .join("、")}
                                      query={query ?? ""}
                                    />
                                  </small>
                                ) : null}
                              </span>
                            ) : (
                              id
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                  <td className="num">{score(row.score)}</td>
                  <td>
                    <Tag
                      tone={
                        row.delivery_status === "returned"
                          ? "success"
                          : "neutral"
                      }
                    >
                      {row.delivery_status === "returned"
                        ? "已交给模型"
                        : row.delivery_status === "filtered"
                          ? "已过滤"
                          : "未记录"}
                    </Tag>
                    {row.delivery_reason && (
                      <small className="grt-secondary">
                        {row.delivery_reason}
                      </small>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}

// ⑦ 关系图：② 找到的实体粗蓝边框；④ 实体路线的边蓝色，⑤ 关系路线的边绿色，两条都找到的紫色粗线；
// 去掉的边灰色虚线（最多画 8 条，其余只在表格里）。边只写关系类别（和知识图谱一样），默认不画标签；
// 鼠标停在边上才显示这条边的类别，提示框里给完整描述；点一条边在弹窗里看它的详情。
const ROUTE_COLORS = {
  entity: "#2563eb",
  relation: "#16a34a",
  both: "#7c3aed",
  dropped: "#cbd5e1",
};
const DROPPED_EDGES = 8;

// 图上的一个实体：② 找到的实体（关键词匹配上的）。
type MapEntity = {
  id: string;
  name: string;
  type: string | null;
  degree: number;
};

// 画布是宽的（宽 > 高），布局算完按画布比例把节点横向撑开，
// 否则 cose 排出来是一团圆，挤在中间，宽度全浪费了。
// 只撑开窄的那一维，不压缩另一边，节点间距不会被挤在一起。
function stretchToCanvas(instance: Core, box: HTMLElement) {
  const nodes = instance.nodes();
  if (nodes.length === 0) return;
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (width < 80 || height < 80) return;
  const bb = nodes.boundingBox({ includeLabels: true });
  if (!bb.w || !bb.h) return;
  const layoutAspect = bb.w / bb.h;
  const canvasAspect = width / height;
  const scaleX =
    layoutAspect < canvasAspect
      ? Math.min(canvasAspect / layoutAspect, 2.4)
      : 1;
  const scaleY =
    layoutAspect > canvasAspect
      ? Math.min(layoutAspect / canvasAspect, 2.4)
      : 1;
  if (scaleX !== 1 || scaleY !== 1) {
    const cx = (bb.x1 + bb.x2) / 2;
    const cy = (bb.y1 + bb.y2) / 2;
    nodes.forEach((item) => {
      const pos = item.position();
      item.position({
        x: cx + (pos.x - cx) * scaleX,
        y: cy + (pos.y - cy) * scaleY,
      });
    });
  }
  // 顺带把图整个收进画布：布局算完不 fit 的话，上面的节点会被画布顶边切掉。
  instance.fit(undefined, 20);
}

function GraphRetrievalMap({
  graph,
  chunks,
}: {
  graph: GraphTrace;
  chunks: Map<string, ChunkInfo>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  // 点开的关系：详情在弹窗里看，图上只留一条边的标签。
  const [openRelation, setOpenRelation] =
    useState<GraphRetrievalRelation | null>(null);
  // 聚焦的实体：只看和它相连的关系，其他部分淡掉。
  const [focus, setFocus] = useState<string | null>(null);
  // 关系类型筛选：空 = 全部。
  const [category, setCategory] = useState("");
  // 筛选框收不收图，看当前有没有聚焦着实体。
  const focusRef = useRef<string | null>(null);
  focusRef.current = focus;
  const { elements, relations, entities, categories, edgeCount } =
    useMemo(() => {
      const routes = new Map<
        string,
        {
          relation: GraphRetrievalRelation;
          entity: boolean;
          theme: boolean;
          reason?: string | null;
        }
      >();
      const add = (
        relation: GraphRetrievalRelation,
        kind: "entity" | "theme",
      ) => {
        const item = routes.get(relation.relation_id) ?? {
          relation,
          entity: false,
          theme: false,
          reason: relation.reason,
        };
        if (relation.kept) item[kind] = true;
        else if (!item.entity && !item.theme) item.reason = relation.reason;
        routes.set(relation.relation_id, item);
      };
      for (const row of graph.entity_relations) add(row, "entity");
      for (const row of graph.relation_matches) add(row, "theme");
      let droppedCount = 0;
      const kept = [...routes.values()].filter(
        (item) => item.entity || item.theme,
      );
      const dropped = [...routes.values()]
        .filter((item) => !item.entity && !item.theme)
        .filter(() => droppedCount++ < DROPPED_EDGES);
      const found = new Set(graph.entities.map((entity) => entity.entity_id));
      const nodes = new Map<string, ElementDefinition>();
      const node = (
        id: string,
        name: string | null,
        type: string | null,
        faded: boolean,
      ) => {
        if (nodes.has(id)) {
          if (!faded) nodes.get(id)!.data.faded = 0;
          return;
        }
        const color = typeColor(type ?? "其他");
        nodes.set(id, {
          group: "nodes",
          data: {
            id,
            label: name ?? id,
            fill: color.fill,
            stroke: found.has(id) ? "#1d4ed8" : color.stroke,
            border: found.has(id) ? 4 : 1.5,
            text: color.text,
            faded: faded ? 1 : 0,
          },
        });
      };
      const edges: ElementDefinition[] = [];
      const groupedEdges = new Map<string, ElementDefinition>();
      for (const item of [...kept, ...dropped]) {
        const relation = item.relation;
        const faded = !item.entity && !item.theme;
        node(
          relation.source_entity_id,
          relation.source_entity ?? relation.source,
          relation.source_type,
          faded,
        );
        node(
          relation.target_entity_id,
          relation.target_entity ?? relation.target,
          relation.target_type,
          faded,
        );
        const route = faded
          ? "dropped"
          : item.entity && item.theme
            ? "both"
            : item.entity
              ? "entity"
              : "relation";
        const text = relation.description || relation.category;
        const key = JSON.stringify([
          relation.source_entity_id,
          relation.target_entity_id,
          relation.category,
        ]);
        const existing = groupedEdges.get(key);
        if (existing) {
          existing.data.count = Number(existing.data.count) + 1;
          existing.data.label = `${relation.category || "关系"} ×${existing.data.count}`;
          existing.data.title += `\n${text}`;
          if (!faded) {
            existing.data.dashed = 0;
            existing.data.color = ROUTE_COLORS[route];
          }
          continue;
        }
        const edge: ElementDefinition = {
          group: "edges",
          data: {
            id: relation.relation_id,
            source: relation.source_entity_id,
            target: relation.target_entity_id,
            color: ROUTE_COLORS[route],
            width: route === "both" ? 4 : faded ? 1.5 : 2.5,
            dashed: faded ? 1 : 0,
            // 合并相同方向和类别，线上显示关系与数量。
            count: 1,
            label: `${relation.category || "关系"} ×1`,
            category: relation.category || "关系",
            title: faded
              ? `${relation.category}：${text}（${item.reason ?? "去掉"}）`
              : `${relation.category}：${text}`,
          },
        };
        groupedEdges.set(key, edge);
        edges.push(edge);
      }
      // 列表只列 ② 找到的实体（关键词匹配上的），图里其他实体不占位置。
      // 每个实体连了几条边标在后面，点之前先看得到规模。
      const degree = new Map<string, number>();
      const categoryCount = new Map<string, number>();
      for (const edge of edges) {
        const source = String(edge.data.source);
        const target = String(edge.data.target);
        degree.set(source, (degree.get(source) ?? 0) + 1);
        degree.set(target, (degree.get(target) ?? 0) + 1);
        const name = String(edge.data.category);
        categoryCount.set(name, (categoryCount.get(name) ?? 0) + 1);
      }
      const entities: MapEntity[] = graph.entities
        .map((entity) => ({
          id: entity.entity_id,
          name: entity.name ?? entity.entity_id,
          type: entity.type,
          degree: degree.get(entity.entity_id) ?? 0,
        }))
        .filter((entity) => entity.degree > 0);
      // 关系类型：筛选框里的选项，按条数从多到少。
      const categories = [...categoryCount.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort(
          (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"),
        );
      return {
        elements: [...nodes.values(), ...edges],
        relations: new Map(
          [...routes.values()].map((item) => [
            item.relation.relation_id,
            item.relation,
          ]),
        ),
        entities,
        categories,
        edgeCount: edges.length,
      };
    }, [graph]);

  useEffect(() => {
    if (!container.current) return;
    const instance = cytoscape({
      container: container.current,
      elements,
      wheelSensitivity: 0.2,
      layout: {
        name: "cose",
        animate: false,
        randomize: false,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 120,
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(fill)",
            "border-color": "data(stroke)",
            "border-width": "data(border)",
            color: "data(text)",
            "font-size": 11,
            "text-valign": "center",
            "text-halign": "center",
            width: "label",
            height: 26,
            padding: "8px",
            shape: "round-rectangle",
          },
        },
        { selector: "node[faded = 1]", style: { opacity: 0.55 } },
        {
          selector: "edge",
          style: {
            "line-color": "data(color)",
            "target-arrow-color": "data(color)",
            "target-arrow-shape": "triangle",
            width: "data(width)",
            "curve-style": "bezier",
            label: "data(label)",
            color: "#475569",
            "font-size": 9,
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
            "text-rotation": "none",
          },
        },
        {
          // 鼠标停在边上、聚焦的实体相邻的边、点中的边，才显示这条边的关系类别。
          selector: "edge.is-hover, edge:selected, edge.is-focus-edge",
          style: {
            label: "data(label)",
            "font-weight": "bold",
            "text-background-opacity": 1,
            "z-index": 10,
          },
        },
        {
          // 聚焦一个实体时，和它无关的部分淡到几乎看不见。
          selector: "node.is-dim",
          style: { opacity: 0.12 },
        },
        {
          selector: "edge.is-dim",
          style: { opacity: 0.07 },
        },
        {
          selector: "node.is-focus",
          style: { "border-width": 5, "border-color": "#1d4ed8", opacity: 1 },
        },
        {
          selector: "edge.is-focus-edge",
          style: { "z-index": 20, opacity: 1 },
        },
        {
          // 关系类型筛选：不是选中类型的边直接不画。
          selector: ".is-hidden",
          style: { display: "none" },
        },
        {
          selector: "edge[dashed = 1]",
          style: { "line-style": "dashed", color: "#94a3b8" },
        },
        {
          selector: "edge:selected",
          style: { "overlay-opacity": 0.12, "overlay-color": "#2563eb" },
        },
      ],
    });
    instance.on("tap", "edge", (event) => {
      const relation = relations.get(event.target.id());
      if (relation) setOpenRelation(relation);
    });
    // 鼠标停在边上：显示这条边的关系类别，提示框里给完整描述。
    instance.on("mouseover", "edge", (event) => {
      event.target.addClass("is-hover");
      if (container.current)
        container.current.title = event.target.data("title") ?? "";
    });
    instance.on("mouseout", "edge", (event) => {
      event.target.removeClass("is-hover");
      if (container.current) container.current.title = "";
    });
    instance.on("tap", "node", (event) => {
      // 点实体：只看和它相连的关系（进来的、出去的），再点一次恢复全部。
      const id = event.target.id();
      instance.edges().unselect();
      setFocus((current) => (current === id ? null : id));
    });
    // 点空白处：取消聚焦。
    instance.on("tap", (event) => {
      if (event.target === instance) {
        instance.edges().unselect();
        setFocus(null);
      }
    });
    cy.current = instance;
    // 布局算完按画布比例横向铺开，再整个收进画布。
    stretchToCanvas(instance, container.current);
    return () => {
      instance.destroy();
      cy.current = null;
    };
  }, [elements]);

  // 聚焦的实体：它相邻的边留着并显示关系类别，其余淡掉。
  // 关系类型筛选 + 聚焦实体，一起算，图上只留要看的部分。
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass("is-dim is-focus is-focus-edge is-hidden");
    // 不是选中类型的边不画。
    if (category) {
      instance.edges().forEach((edge) => {
        if (edge.data("category") !== category) edge.addClass("is-hidden");
      });
    }
    // 聚焦的实体：它相邻的边留着并显示关系类别，其余淡掉。
    const node = focus ? instance.getElementById(focus) : null;
    const hasFocus = Boolean(node && !node.empty());
    if (hasFocus && node) {
      const edgeIds = new Set<string>();
      const nodeIds = new Set<string>([focus as string]);
      node.connectedEdges().forEach((edge) => {
        edgeIds.add(edge.id());
      });
      node.connectedNodes().forEach((item) => {
        nodeIds.add(item.id());
      });
      instance.nodes().forEach((item) => {
        if (!nodeIds.has(item.id())) item.addClass("is-dim");
      });
      instance.edges().forEach((edge) => {
        if (!edgeIds.has(edge.id())) edge.addClass("is-dim");
      });
      node.addClass("is-focus");
      node.connectedEdges().addClass("is-focus-edge");
    }
    // 边被藏掉之后，两头都不剩边的点也一起藏，不然会剩一堆孤零零的点。
    let changed = true;
    while (changed) {
      changed = false;
      instance.nodes().forEach((item) => {
        if (item.hasClass("is-hidden") || item.hasClass("is-focus")) return;
        const visible = item
          .connectedEdges()
          .filter(
            (edge) =>
              !edge.hasClass("is-hidden") &&
              !edge.source().hasClass("is-hidden") &&
              !edge.target().hasClass("is-hidden"),
          );
        if (!visible.length) {
          item.addClass("is-hidden");
          changed = true;
        }
      });
    }
    // 选中的实体移到画布中间：它可能在边上，缩着图看不清楚。
    if (hasFocus && node) {
      instance.animate({
        center: { eles: node },
        zoom: instance.zoom(),
        duration: 220,
        easing: "ease-out",
      });
    }
  }, [focus, category, elements]);

  // 换了关系类型：把剩下的关系收进画布（聚焦实体时以它为中心，不重新收）。
  useEffect(() => {
    const instance = cy.current;
    if (!instance || focusRef.current) return;
    // 只收还画着的部分：藏起来的边和它们两头的点不算。
    const visible = instance.elements().filter((ele) => {
      if (ele.hasClass("is-hidden")) return false;
      if (ele.isEdge())
        return (
          !ele.source().hasClass("is-hidden") &&
          !ele.target().hasClass("is-hidden")
        );
      return true;
    });
    if (visible.length) instance.fit(visible, 20);
  }, [category, elements]);

  // 面板展开/收起、窗口变宽变窄时重新按画布比例铺一次。
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    let last = "";
    const observer = new ResizeObserver(() => {
      const size = `${box.clientWidth}x${box.clientHeight}`;
      if (size === last) return;
      last = size;
      if (cy.current) stretchToCanvas(cy.current, box);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  if (elements.length === 0) return <p className="grt-empty">没有可画的关系</p>;
  return (
    <div className="grt-map">
      <div className="grt-map-entities">
        <span className="grt-map-entities-label">找到的实体</span>
        <div className="grt-chips">
          <button
            type="button"
            className={`grt-chip${focus ? "" : " is-active"}`}
            onClick={() => setFocus(null)}
          >
            全部 <em>{entities.length}</em>
          </button>
          {entities.map((entity) => (
            <button
              key={entity.id}
              type="button"
              className={`grt-chip grt-entity-chip${focus === entity.id ? " is-active" : ""}`}
              title={`② 找到的实体 · ${entity.degree} 条关系`}
              onClick={() =>
                setFocus((current) =>
                  current === entity.id ? null : entity.id,
                )
              }
            >
              <i
                className="grt-entity-dot"
                style={{ background: typeColor(entity.type ?? "其他").stroke }}
              />
              {entity.name}
              <em>{entity.degree}</em>
            </button>
          ))}
        </div>
        <label className="grt-map-filter">
          <span>关系类型</span>
          <select
            className="input-sm"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">全部（{edgeCount}）</option>
            {categories.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}（{item.count}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grt-map-legend">
        <span>
          <i className="grt-node-found" />
          找到的实体
        </span>
        <span>
          <i style={{ background: ROUTE_COLORS.entity }} />
          实体路线（④）
        </span>
        <span>
          <i style={{ background: ROUTE_COLORS.relation }} />
          关系路线（⑤）
        </span>
        <span>
          <i style={{ background: ROUTE_COLORS.both }} />
          两条路线都找到
        </span>
        <span>
          <i className="grt-edge-dropped" />
          去掉的
        </span>
      </div>
      <div className="grt-map-canvas" ref={container} />
      <p className="grt-hint">
        点上面的实体只看和它相连的关系，再点一次或点空白处恢复；右边的下拉框按关系类型筛选；鼠标停在边上显示关系类别，点一条边在弹窗里看详情；滚轮缩放，可以拖动
      </p>
      {openRelation && (
        <DetailDialog
          open
          title={`关系 · ${openRelation.source} → ${openRelation.target}`}
          onClose={() => setOpenRelation(null)}
        >
          {[...relations.values()]
            .filter(
              (member) =>
                member.source_entity_id === openRelation.source_entity_id &&
                member.target_entity_id === openRelation.target_entity_id &&
                member.category === openRelation.category,
            )
            .map((member) => (
              <div className="grt grt-map-detail" key={member.relation_id}>
                <RelationText relation={member} />
                <span>
                  {graph.pipeline
                    ? `关系优先级 ${score(member.score)} · 重排分数 ${score(member.rerank_score)}`
                    : `相似度 ${score(member.score)}`}{" "}
                  · <Origin relation={member} />
                </span>
                {!member.kept && member.reason && (
                  <p className="grt-dropped">没被留下：{member.reason}</p>
                )}
                <OriginalButton
                  relation={member}
                  chunk={chunks.get(member.chunk_id)}
                />
              </div>
            ))}
        </DetailDialog>
      )}
    </div>
  );
}
