import { useState } from "react";
import type { GraphNetwork } from "./api";

type Match = { id: string; name: string; type: string };

export function useGraphExplorer() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [center, setCenter] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [limit, setLimit] = useState(20);
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
  }
  return {
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
      setFocus((items) => (items.length < 300 ? [...items, id] : items)),
    collapse: (id: string) =>
      setFocus((items) => items.filter((item) => item !== id)),
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
        {centerNode && (
          <>
            <span className="graph-note">中心：{centerNode.name}</span>
            {centerNode.hidden_neighbors > 0 && (
              <button
                type="button"
                className="link-button"
                onClick={() => explorer.expand(centerNode.id)}
              >
                显示更多邻居（最多 15 个）
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
              回到中心
            </button>
          </>
        )}
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
      {node && (
        <div className="graph-filters">
          <span className="graph-note">{node.name}</span>
          {node.hidden_neighbors > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => explorer.expand(node.id)}
            >
              展开关系（再显示最多 15 个邻居）
            </button>
          )}
          {explorer.focus.includes(node.id) && (
            <button
              type="button"
              className="link-button"
              onClick={() => explorer.collapse(node.id)}
            >
              收起此实体的展开
            </button>
          )}
          {node.id !== center && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                explorer.choose(node.id);
                onClearSelection();
              }}
            >
              以它为中心
            </button>
          )}
        </div>
      )}
      {explorer.focus.length > 0 && (
        <div className="graph-filters">
          {[...new Set(explorer.focus)].map((id) => (
            <button
              type="button"
              key={id}
              className="link-button"
              onClick={() => explorer.collapse(id)}
            >
              收起{" "}
              {network?.nodes.find((item) => item.id === id)?.name ?? "实体"}{" "}
              的展开
            </button>
          ))}
        </div>
      )}
      {network && network.nodes.length >= 300 && (
        <p className="graph-note">
          已达到 300 个实体上限，请收起部分展开或选择新的中心实体。
        </p>
      )}
    </div>
  );
}
