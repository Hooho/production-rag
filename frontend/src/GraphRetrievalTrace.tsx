import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type {
  GraphRetrievalRelation,
  GraphRetrievalTable,
  GraphRetrievalTrace as GraphTrace,
} from "./api";
import { typeColor } from "./GraphView";
import { HighlightedText } from "./HighlightedText";
import { InfoPopover } from "./Popover";
import "./GraphRetrieval.css";

// 检索过程「混合检索」里的图检索模块（docs：claude/graph-retrieval-phase2-plan.md 第一部分第四节）：
// ① 提关键词 → ② 找实体 → ③ 实体的关系 → ④ 找关系 → ⑤ 取分片 → ⑥ 关系图。
// 每一步都列出留下的和去掉的（附原因）。权限、生效版本在查询条件里，没有「权限过滤掉多少条」。

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

type ChunkInfo = Pick<
  GraphRetrievalTable,
  "chunk_id" | "title" | "text" | "heading" | "version"
>;

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
      content={() =>
        chunk?.text ? (
          <HighlightedText
            text={chunk.text}
            groups={[
              {
                kind: "evidence",
                texts: (relation.evidence ?? "").split("||"),
              },
              { kind: "entity", texts: [relation.source, relation.target] },
            ]}
          />
        ) : (
          <div className="grt-original-missing">
            <p>这一片没有交给检索（关系没留下），只显示原文引用：</p>
            <blockquote>{relation.evidence || "（没有原文引用）"}</blockquote>
          </div>
        )
      }
    >
      <button type="button" className="link-button button-sm">
        原文
      </button>
    </InfoPopover>
  );
}

function RelationText({ relation }: { relation: GraphRetrievalRelation }) {
  const renamed = (name: string, entity: string | null) =>
    entity && entity !== name ? (
      <small className="grt-entity-of" title={`归到实体「${entity}」`}>
        （{entity}）
      </small>
    ) : null;
  return (
    <span className="grt-rel">
      <b>{relation.source}</b>
      {renamed(relation.source, relation.source_entity)}
      <span className="grt-arrow">→</span>
      <span className="grt-rel-desc">
        {relation.description || relation.category}
      </span>
      <span className="grt-arrow">→</span>
      <b>{relation.target}</b>
      {renamed(relation.target, relation.target_entity)}
      <small className="grt-category">{relation.category}</small>
    </span>
  );
}

function Result({
  kept,
  reason,
  extra,
}: {
  kept: boolean;
  reason?: string | null;
  extra?: string;
}) {
  return kept ? (
    <span className="grt-kept">✓ 留下{extra ? ` · ${extra}` : ""}</span>
  ) : (
    <span className="grt-dropped">✕ {reason || "去掉"}</span>
  );
}

function Origin({ relation }: { relation: GraphRetrievalRelation }) {
  return (
    <span className="grt-origin">
      {relation.title ?? "—"}
      {relation.version_number ? <em>图 v{relation.version_number}</em> : null}
    </span>
  );
}

// 去掉的项默认收起，只显示留下的；点开看去掉了哪些、为什么。
function useFold<T extends { kept: boolean }>(items: T[]) {
  const [open, setOpen] = useState(false);
  const kept = items.filter((item) => item.kept);
  const dropped = items.filter((item) => !item.kept);
  return {
    visible: open ? [...kept, ...dropped] : kept,
    dropped: dropped.length,
    open,
    toggle: () => setOpen((value) => !value),
  };
}

function FoldButton({
  count,
  more,
  open,
  onClick,
}: {
  count: number;
  more?: number;
  open: boolean;
  onClick: () => void;
}) {
  if (count === 0 && !more) return null;
  return (
    <button
      type="button"
      className="link-button button-sm grt-fold"
      onClick={onClick}
    >
      {open
        ? "收起去掉的"
        : `查看去掉的 ${count} 条${more ? `（另有 ${more} 条只记了数量）` : ""}`}
    </button>
  );
}

export function GraphRetrievalTrace({ graph }: { graph: GraphTrace }) {
  const chunks = useMemo(() => {
    const map = new Map<string, ChunkInfo>();
    for (const row of [...graph.tables.entity, ...graph.tables.relation])
      if (row.text) map.set(row.chunk_id, row);
    return map;
  }, [graph]);
  const relations = useMemo(() => {
    const map = new Map<string, GraphRetrievalRelation>();
    for (const row of [...graph.entity_relations, ...graph.relation_matches])
      if (!map.has(row.relation_id)) map.set(row.relation_id, row);
    return map;
  }, [graph]);
  const names = useFold(graph.name_matches);
  const entityRelations = useFold(graph.entity_relations);
  const relationMatches = useFold(graph.relation_matches);
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
        {words?.reason && <p className="grt-note">{words.reason}</p>}
        <table className="diag-table grt-table">
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
            <tr>
              <td>概括</td>
              <td>{words?.themes.join("、") || "—"}</td>
              <td>找关系（关系向量）</td>
            </tr>
          </tbody>
        </table>
        {words?.prompt && (
          <details className="mem-fold">
            <summary>发给模型的提示词和原始输出</summary>
            {words.prompt.map((message, index) => (
              <pre className="grt-pre" key={index}>
                {message.role === "system" ? "系统：" : "用户："}
                {message.content}
              </pre>
            ))}
            <pre className="grt-pre">
              输出：{words.raw_output || words.error || "（空）"}
            </pre>
          </details>
        )}
      </section>

      <section className="grt-step">
        <h5>
          ② 找实体
          <small>
            具体关键词 → 名字向量（相似度 ≥{" "}
            {settings.graph_name_min_score ?? 0.5}
            ，每个关键词前 {settings.graph_name_top_k ?? 10} 个）→
            按归属合并成实体
          </small>
        </h5>
        {graph.name_matches.length === 0 ? (
          <p className="grt-empty">没有匹配到名字</p>
        ) : (
          <div className="diag-table-wrap">
            <table className="diag-table grt-table">
              <thead>
                <tr>
                  <th>具体关键词</th>
                  <th>匹配到的名字</th>
                  <th>出自</th>
                  <th>相似度</th>
                  <th>归到实体</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {names.visible.map((match, index) => (
                  <tr
                    key={`${match.keyword}-${match.entity_id}-${match.name}-${index}`}
                  >
                    <td>{match.keyword}</td>
                    <td>{match.name}</td>
                    <td>
                      {match.title ?? "—"}
                      {match.version_number ? (
                        <em className="grt-v">图 v{match.version_number}</em>
                      ) : null}
                    </td>
                    <td className="num">{score(match.score)}</td>
                    <td>
                      {match.entity_name ?? "—"}
                      {match.entity_type ? (
                        <small>（{match.entity_type}）</small>
                      ) : null}
                    </td>
                    <td>
                      <Result kept={match.kept} reason={match.reason} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <FoldButton
          count={names.dropped}
          more={graph.dropped_more?.names}
          open={names.open}
          onClick={names.toggle}
        />
        <p className="grt-summary">
          {graph.entities.length
            ? `找到 ${graph.entities.length} 个实体：${graph.entities.map((entity) => entity.name).join("、")}`
            : "没有找到实体"}
        </p>
      </section>

      <section className="grt-step">
        <h5>
          ③ 实体的关系
          <small>
            一跳：找到的实体直接相连的关系，按和问题的相似度排序，每个实体最多{" "}
            {settings.graph_entity_relation_limit ?? 10} 条
          </small>
        </h5>
        <RelationTable
          rows={entityRelations.visible}
          first="实体"
          firstValue={(row) =>
            "entity_name" in row ? String(row.entity_name ?? "") : ""
          }
          chunks={chunks}
        />
        <FoldButton
          count={entityRelations.dropped}
          more={graph.dropped_more?.entity_relations}
          open={entityRelations.open}
          onClick={entityRelations.toggle}
        />
      </section>

      <section className="grt-step">
        <h5>
          ④ 找关系
          <small>
            概括关键词 → 关系向量（相似度 ≥{" "}
            {settings.graph_relation_min_score ?? 0.5}
            ，每个关键词前 {settings.graph_relation_top_k ?? 20} 条）
          </small>
        </h5>
        <RelationTable
          rows={relationMatches.visible}
          first="概括关键词"
          firstValue={(row) => ("keyword" in row ? String(row.keyword) : "")}
          chunks={chunks}
          extra={(row) =>
            "also_entity" in row && row.also_entity ? "和 ③ 重复" : undefined
          }
        />
        <FoldButton
          count={relationMatches.dropped}
          more={graph.dropped_more?.relation_matches}
          open={relationMatches.open}
          onClick={relationMatches.toggle}
        />
      </section>

      <section className="grt-step">
        <h5>
          ⑤ 取分片
          <small>
            关系的出处分片，同一片去重，名次按这一片对应的关系里相似度最高的那条
          </small>
        </h5>
        <div className="grt-tables">
          {(["entity", "relation"] as const).map((name) => (
            <ChunkTable
              key={name}
              title={
                name === "entity"
                  ? "图 · 实体（来自 ③）"
                  : "图 · 关系（来自 ④）"
              }
              rows={graph.tables[name]}
              relations={relations}
            />
          ))}
        </div>
        <p className="grt-summary">
          合计 {graph.counts?.chunks ?? 0} 个分片
          {graph.counts &&
          graph.counts.entity_chunks + graph.counts.relation_chunks >
            graph.counts.chunks
            ? `（两张表有 ${graph.counts.entity_chunks + graph.counts.relation_chunks - graph.counts.chunks} 个重复）`
            : ""}
        </p>
      </section>

      <section className="grt-step">
        <h5>
          ⑥ 关系图
          <small>只画这道题用到的部分</small>
        </h5>
        <GraphRetrievalMap graph={graph} chunks={chunks} />
      </section>
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
  rows,
  first,
  firstValue,
  chunks,
  extra,
}: {
  rows: RelationRow[];
  first: string;
  firstValue: (row: RelationRow) => string;
  chunks: Map<string, ChunkInfo>;
  extra?: (row: RelationRow) => string | undefined;
}) {
  if (rows.length === 0) return <p className="grt-empty">没有找到关系</p>;
  return (
    <div className="diag-table-wrap">
      <table className="diag-table grt-table">
        <thead>
          <tr>
            <th>{first}</th>
            <th>关系</th>
            <th>相似度</th>
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
              <td>{firstValue(row)}</td>
              <td>
                <RelationText relation={row} />
                {row.evidence && (
                  <small className="grt-evidence" title="原文引用">
                    「{row.evidence}」
                  </small>
                )}
              </td>
              <td className="num">{score(row.score)}</td>
              <td>
                <Origin relation={row} />
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
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChunkTable({
  title,
  rows,
  relations,
}: {
  title: string;
  rows: GraphRetrievalTable[];
  relations: Map<string, GraphRetrievalRelation>;
}) {
  return (
    <div className="grt-chunk-table">
      <strong>
        {title} · {rows.filter((row) => row.kept !== false).length} 个分片
      </strong>
      {rows.length === 0 ? (
        <p className="grt-empty">没有分片</p>
      ) : (
        <table className="diag-table grt-table">
          <thead>
            <tr>
              <th>名次</th>
              <th>分片</th>
              <th>来自哪些关系</th>
              <th>得分</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.chunk_id}
                className={row.kept === false ? "is-dropped" : ""}
              >
                <td className="num">{row.kept === false ? "—" : row.rank}</td>
                <td>
                  <span className="diag-title">
                    {row.title ?? row.chunk_id}
                  </span>
                  {row.heading ? <small>{row.heading}</small> : null}
                  {row.kept === false ? (
                    <span className="grt-dropped">✕ {row.reason}</span>
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
                          <HighlightedText
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
                            <>
                              {relation.source} → {relation.target}
                              <small>（{relation.category}）</small>
                            </>
                          ) : (
                            id
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </td>
                <td className="num">{score(row.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ⑥ 关系图：② 找到的实体粗蓝边框；③ 实体路线的边蓝色，④ 关系路线的边绿色，两条都找到的紫色粗线；
// 去掉的边灰色虚线（最多画 8 条，其余只在表格里）。点一条边在下面显示它的原文。
const ROUTE_COLORS = {
  entity: "#2563eb",
  relation: "#16a34a",
  both: "#7c3aed",
  dropped: "#cbd5e1",
};
const DROPPED_EDGES = 8;

function GraphRetrievalMap({
  graph,
  chunks,
}: {
  graph: GraphTrace;
  chunks: Map<string, ChunkInfo>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { elements, relations } = useMemo(() => {
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
      edges.push({
        group: "edges",
        data: {
          id: relation.relation_id,
          source: relation.source_entity_id,
          target: relation.target_entity_id,
          color: ROUTE_COLORS[route],
          width: route === "both" ? 4 : faded ? 1.5 : 2.5,
          dashed: faded ? 1 : 0,
          label: faded
            ? `${text.slice(0, 10)} · ${item.reason ?? "去掉"}`
            : text.slice(0, 14),
        },
      });
    }
    return {
      elements: [...nodes.values(), ...edges],
      relations: new Map(
        [...routes.values()].map((item) => [
          item.relation.relation_id,
          item.relation,
        ]),
      ),
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
            "font-size": 9,
            color: "#475569",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "text-rotation": "autorotate",
          },
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
    instance.on("tap", "edge", (event) => setSelected(event.target.id()));
    instance.on("tap", "node", (event) => {
      setSelected(null);
      event.target.connectedEdges().select();
    });
    cy.current = instance;
    return () => {
      instance.destroy();
      cy.current = null;
    };
  }, [elements]);

  const relation = selected ? relations.get(selected) : undefined;
  if (elements.length === 0) return <p className="grt-empty">没有可画的关系</p>;
  return (
    <div className="grt-map">
      <div className="grt-map-legend">
        <span>
          <i className="grt-node-found" />
          找到的实体
        </span>
        <span>
          <i style={{ background: ROUTE_COLORS.entity }} />
          实体路线（③）
        </span>
        <span>
          <i style={{ background: ROUTE_COLORS.relation }} />
          关系路线（④）
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
      {relation ? (
        <div className="grt-map-detail">
          <RelationText relation={relation} />
          <span>
            相似度 {score(relation.score)} · <Origin relation={relation} />
          </span>
          {relation.evidence && <blockquote>{relation.evidence}</blockquote>}
          <OriginalButton
            relation={relation}
            chunk={chunks.get(relation.chunk_id)}
          />
        </div>
      ) : (
        <p className="grt-hint">点一条边看它的原文；滚轮缩放，可以拖动</p>
      )}
    </div>
  );
}
