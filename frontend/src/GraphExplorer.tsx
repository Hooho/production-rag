import type { GraphExploration } from "./GraphHistory";
import { useState } from "react";
import type { GraphNetwork } from "./api";
import { GraphFocusButton } from "./GraphWorkspace";

type Match = { id: string; name: string; type: string };

export function useGraphExplorer(
  expansionCategory?: { entityId: string; category: string | null } | null,
) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [center, setCenter] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [limit, setLimit] = useState(20);
  const [entitySearch, setEntitySearch] =
    useState<GraphExploration["entitySearch"]>(null);
  function find() {
    setSearch(query.trim());
    setCenter(null);
    setFocus([]);
  }
  function choose(id: string) {
    setCenter(id);
    setFocus([]);
  }
  function reset() {
    setQuery("");
    setSearch("");
    setCenter(null);
    setFocus([]);
    setLimit(20);
    setEntitySearch(null);
  }
  return {
    snapshot: { query, search, center, focus, limit, entitySearch },
    restore: (value: GraphExploration) => {
      setEntitySearch(value.entitySearch ?? null);
      setQuery(value.query);
      setSearch(value.search);
      setCenter(value.center);
      setFocus(value.focus);
      setLimit(value.limit);
    },
    entitySearch,
    setEntitySearch,
    showMatches: (id: string, query: string, category: string | null) =>
      setFocus((items) =>
        items.length < 300
          ? [
              ...items,
              `${id}|${encodeURIComponent(category ?? "")}|${encodeURIComponent(query)}`,
            ]
          : items,
      ),
    expansionCategory,
    query,
    setQuery,
    search,
    center,
    focus,
    setFocus,
    limit,
    setLimit,
    find,
    choose,
    reset,
    expand: (id: string) =>
      setFocus((items) =>
        items.length < 300
          ? [
              ...items,
              expansionCategory?.entityId === id && expansionCategory.category
                ? `${id}|${encodeURIComponent(expansionCategory.category)}`
                : id,
            ]
          : items,
      ),
    collapse: (id: string) =>
      setFocus((items) => items.filter((item) => item.split("|")[0] !== id)),
  };
}

export function GraphExplorerControls({
  explorer,
  network,
  matches = [],
  selected,
  onClearSelection,
}: {
  explorer: ReturnType<typeof useGraphExplorer>;
  network?: GraphNetwork;
  matches?: Match[];
  selected: string | null;
  onClearSelection: () => void;
}) {
  const center = network?.center_id;
  const node = network?.nodes.find((item) => item.id === selected);
  const centerNode = network?.nodes.find((item) => item.id === center);
  function remaining(id: string) {
    const item = network?.nodes.find((node) => node.id === id);
    const category =
      explorer.expansionCategory?.entityId === id
        ? explorer.expansionCategory.category
        : null;
    return category && item?.hidden_neighbors_by_category
      ? (item.hidden_neighbors_by_category[category] ?? 0)
      : (item?.hidden_neighbors ?? 0);
  }
  function expandLabel(id: string) {
    const category =
      explorer.expansionCategory?.entityId === id
        ? explorer.expansionCategory.category
        : null;
    const count = remaining(id);
    return count > 0
      ? `展开${category ? `「${category}」` : "关系"}（再显示最多 ${Math.min(15, count)} 个邻居）`
      : `${category ? `「${category}」` : "当前"}关系的邻居已全部显示`;
  }
  return (
    <div className="graph-explorer">
      <form
        className="graph-filters"
        onSubmit={(event) => {
          event.preventDefault();
          explorer.find();
          onClearSelection();
        }}
      >
        <input
          aria-label="搜索中心实体"
          value={explorer.query}
          placeholder="搜索实体，查看一跳关系"
          onChange={(event) => explorer.setQuery(event.target.value)}
        />
        <button className="secondary-button" type="submit">
          搜索
        </button>
        {!center && (
          <button
            className="secondary-button"
            type="button"
            disabled={
              explorer.limit >= 300 ||
              (network?.nodes.length ?? 0) >= (network?.total_entities ?? 0)
            }
            onClick={() =>
              explorer.setLimit((value) => Math.min(300, value + 20))
            }
          >
            显示更多实体
          </button>
        )}
        {(center || explorer.focus.length > 0 || explorer.search) && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              explorer.reset();
              onClearSelection();
            }}
          >
            返回概览
          </button>
        )}
        <GraphFocusButton />
      </form>
      {explorer.search && (
        <div className="graph-filters">
          <span className="graph-note">
            {matches.length ? "选择中心实体：" : "没有找到匹配的实体"}
          </span>
          {matches.map((item) => (
            <button
              type="button"
              key={item.id}
              className="link-button"
              onClick={() => {
                explorer.choose(item.id);
                onClearSelection();
              }}
            >
              {item.name}（{item.type}）
            </button>
          ))}
        </div>
      )}
      {centerNode && (
        <div className="graph-explorer-row">
          <span className="graph-note">中心：{centerNode.name}</span>
          {(centerNode.hidden_neighbors > 0 ||
            explorer.expansionCategory?.entityId === centerNode.id) && (
            <button
              type="button"
              className="link-button"
              disabled={
                remaining(centerNode.id) === 0 ||
                (network?.nodes.length ?? 0) >= 300
              }
              onClick={() => explorer.expand(centerNode.id)}
            >
              {expandLabel(centerNode.id)}
            </button>
          )}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              explorer.choose(centerNode.id);
              onClearSelection();
            }}
          >
            重置展开
          </button>
        </div>
      )}
      {node && node.id !== center && (
        <div className="graph-explorer-row">
          <span className="graph-note">{node.name}</span>
          {(node.hidden_neighbors > 0 ||
            explorer.expansionCategory?.entityId === node.id) && (
            <button
              type="button"
              className="link-button"
              disabled={
                remaining(node.id) === 0 || (network?.nodes.length ?? 0) >= 300
              }
              onClick={() => explorer.expand(node.id)}
            >
              {expandLabel(node.id)}
            </button>
          )}
          {explorer.focus.some((item) => item.split("|")[0] === node.id) && (
            <button
              type="button"
              className="link-button"
              onClick={() => explorer.collapse(node.id)}
            >
              收起此实体的展开
            </button>
          )}
        </div>
      )}
      {[...new Set(explorer.focus.map((item) => item.split("|")[0]))]
        .filter((id) => id !== center && id !== node?.id)
        .map((id) => (
          <div key={id} className="graph-explorer-row">
            <span className="graph-note">
              已展开：
              {network?.nodes.find((item) => item.id === id)?.name ?? "实体"}
            </span>
            <button
              type="button"
              className="link-button"
              onClick={() => explorer.expand(id)}
              disabled={
                !network?.nodes.find((item) => item.id === id)?.hidden_neighbors
              }
            >
              显示更多邻居（最多 15 个）
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => explorer.collapse(id)}
            >
              收起展开
            </button>
          </div>
        ))}
      {network && network.nodes.length >= 300 && (
        <p className="graph-note">
          已达到 300 个实体上限，请收起部分展开或选择新的中心实体。
        </p>
      )}
    </div>
  );
}
