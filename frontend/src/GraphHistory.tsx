import { useLayoutEffect, useRef, useState } from "react";
import type { GraphEdge, GraphRelationRow } from "./api";

export type GraphCanvasState = {
  zoom: number;
  pan: { x: number; y: number };
  positions: Record<string, { x: number; y: number }>;
  edges: string[];
};
export type GraphSelection = {
  selected: string | null;
  category: { entityId: string; category: string | null } | null;
  relation: GraphRelationRow | null;
  edge: GraphEdge | null;
  scope: "visible" | "all";
};
export type GraphExploration = {
  query: string;
  search: string;
  center: string | null;
  focus: string[];
  limit: number;
};
type Entry = {
  selection: GraphSelection;
  exploration: GraphExploration;
  canvas?: GraphCanvasState;
};

export function useGraphHistory(
  context: string,
  selection: GraphSelection,
  exploration: GraphExploration,
  restore: (selection: GraphSelection, exploration: GraphExploration) => void,
) {
  const entries = useRef<Entry[]>([]);
  const cursor = useRef(-1);
  const previousContext = useRef(context);
  const [revision, setRevision] = useState(0);
  const [canvasRestore, setCanvasRestore] = useState<{
    token: number;
    state: GraphCanvasState;
  } | null>(null);
  const signature = JSON.stringify(selection);
  useLayoutEffect(() => {
    if (previousContext.current !== context) {
      previousContext.current = context;
      entries.current = [];
      cursor.current = -1;
      setCanvasRestore(null);
    }
    const current = entries.current[cursor.current];
    if (!current || JSON.stringify(current.selection) !== signature) {
      setCanvasRestore(null);
      entries.current = entries.current.slice(0, cursor.current + 1);
      entries.current.push({ selection, exploration });
      cursor.current = entries.current.length - 1;
      setRevision((value) => value + 1);
    } else {
      // Expanding and moving the canvas update this visit instead of adding history.
      current.exploration = exploration;
    }
  }, [context, signature, JSON.stringify(exploration)]);
  function go(offset: number) {
    const next = cursor.current + offset;
    const entry = entries.current[next];
    if (!entry) return;
    cursor.current = next;
    entries.current = entries.current.slice(0, next + 1);
    restore(entry.selection, entry.exploration);
    setCanvasRestore(
      entry.canvas ? { token: Date.now(), state: entry.canvas } : null,
    );
    setRevision((value) => value + 1);
  }
  function saveCanvas(state: GraphCanvasState) {
    const current = entries.current[cursor.current];
    if (current) current.canvas = state;
  }
  return {
    back: entries.current[cursor.current - 1],
    go,
    saveCanvas,
    canvasRestore,
    revision,
  };
}

export function GraphHistoryControls({
  history,
  name,
}: {
  history: ReturnType<typeof useGraphHistory>;
  name: (id: string) => string;
}) {
  function label(entry: Entry) {
    const value = entry.selection;
    if (value.edge)
      return `${name(value.edge.source)} → ${name(value.edge.target)} · ${value.edge.categories.join("、")}`;
    if (value.relation)
      return `${value.relation.source_entity} → ${value.relation.target_entity} · ${value.relation.category}`;
    if (!value.selected) return "图谱概览";
    const category =
      value.category?.entityId === value.selected
        ? value.category.category
        : null;
    return `${name(value.selected)} · ${category ?? "全部关系"}`;
  }
  return (
    <nav className="graph-history-controls" aria-label="图谱浏览历史">
      <button
        type="button"
        className="secondary-button"
        disabled={!history.back}
        onClick={() => history.go(-1)}
        title={
          history.back ? `后退到：${label(history.back)}` : "没有更早的浏览记录"
        }
      >
        {history.back ? `← 后退到：${label(history.back)}` : "← 后退"}
      </button>
    </nav>
  );
}
