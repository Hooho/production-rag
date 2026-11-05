import type { GraphHopInfo } from "./graphHops";
import { matchesEntityName } from "./graphEntitySearch";
import type { GraphCanvasState } from "./GraphHistory";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { GraphEdge, GraphNode } from "./api";
import { labelHue } from "./hues";
import "./Graph.css";

// 知识图谱的图：用 Cytoscape.js 画。布局用它自带的 cose（力导向），节点可以拖动，滚轮缩放、拖动空白处平移。
// 文档「实体关系」页签、全局「知识图谱」共用，第 2 期检索过程里的遍历图也会复用。

// 颜色写成逗号分隔的 hsl(h, s%, l%)：Cytoscape 不认空格分隔的新写法。
// 默认清单里的实体类型用固定的颜色，文档页签和全局页面一致；其他类型按名字从分类色里取（避开红色）。
const TYPE_HUES: Record<string, number> = {
  人物: 28,
  组织: 215,
  产品: 145,
  作品: 270,
  地点: 185,
  事件: 50,
  概念: 300,
};

export function typeColor(type: string) {
  if (type === "其他")
    return {
      fill: "hsl(215, 15%, 92%)",
      stroke: "hsl(215, 12%, 50%)",
      text: "hsl(215, 15%, 30%)",
    };
  const hue = TYPE_HUES[type] ?? labelHue(type);
  return {
    fill: `hsl(${hue}, 75%, 90%)`,
    stroke: `hsl(${hue}, 45%, 42%)`,
    text: `hsl(${hue}, 55%, 26%)`,
  };
}

function size(neighbors: number) {
  if (neighbors <= 2) return 28;
  if (neighbors <= 5) return 38;
  if (neighbors <= 10) return 50;
  if (neighbors <= 20) return 66;
  return 84;
}

// 节点和边转成 Cytoscape 的元素。颜色、大小、标签都算好放进 data，样式表里直接取。
// 初始位置按顺序排在圆上，再用 cose 布局（randomize: false），同一组数据每次画出来都一样。
function elements(nodes: GraphNode[], edges: GraphEdge[]): ElementDefinition[] {
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!neighbors.has(edge.source) || !neighbors.has(edge.target)) continue;
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  const count = Math.max(1, nodes.length);
  const radius = 60 + count * 12;
  const result: ElementDefinition[] = nodes.map((node, index) => {
    const color = typeColor(node.type);
    const neighborCount = neighbors.get(node.id)!.size + node.hidden_neighbors;
    const name =
      node.name.length > 12 ? `${node.name.slice(0, 12)}…` : node.name;
    return {
      group: "nodes",
      data: {
        id: node.id,
        baseLabel:
          node.hidden_neighbors > 0
            ? `${name}  +${node.hidden_neighbors}`
            : name,
        label:
          node.hidden_neighbors > 0
            ? `${name}  +${node.hidden_neighbors}`
            : name,
        title: `${node.name}（${node.type}）：连接 ${neighborCount} 个实体，${node.relation_count} 条关系，出现 ${node.mention_count} 次`,
        fill: color.fill,
        stroke: color.stroke,
        text: color.text,
        size: size(neighborCount),
        focus: node.focus ? 1 : 0,
      },
      position: {
        x: radius * Math.cos((2 * Math.PI * index) / count),
        y: radius * Math.sin((2 * Math.PI * index) / count),
      },
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    result.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: `${edge.categories.join("、")}${edge.count > 1 ? ` ×${edge.count}` : ""}`,
        title: `${edge.categories.join("、")}（${edge.count} 条）\n${edge.descriptions.join("\n")}`,
        width: Math.min(5, 1 + Math.log2(edge.count + 1)),
        relationColor:
          edge.categories.length === 1
            ? `hsl(${labelHue(edge.categories[0])}, 62%, 30%)`
            : "#64748b",
      },
    });
  }
  return result;
}

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "data(fill)",
      "border-color": "data(stroke)",
      "border-width": 1.5,
      width: "data(size)",
      height: "data(size)",
      label: "data(label)",
      color: "data(text)",
      "font-size": 13,
      "text-valign": "bottom",
      "text-margin-y": 4,
      "text-outline-color": "#fbfcfe",
      "text-outline-width": 2,
    },
  },
  { selector: "node[focus = 1]", style: { "border-width": 2.5 } },
  {
    selector: "node.is-selected",
    style: { "border-width": 3, "font-weight": "bold" },
  },
  {
    selector: "edge",
    style: {
      width: "data(width)",
      "line-color": "data(relationColor)",
      "target-arrow-color": "data(relationColor)",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.9,
      "curve-style": "bezier",
      "control-point-step-size": 48,
      "edge-distances": "node-position",
    },
  },
  {
    selector: "edge:loop",
    style: {
      "curve-style": "bezier",
      "loop-direction": "-45deg",
      "loop-sweep": "70deg",
      "control-point-step-size": 60,
    },
  },
  {
    selector: "edge.is-near",
    style: {
      label: "data(label)",
      "font-size": 10,
      color: "data(relationColor)",
      "text-rotation": "none",
      "text-background-color": "#fbfcfe",
      "text-background-opacity": 0.95,
      "text-background-padding": "3px",
      "text-background-shape": "roundrectangle",
      "text-outline-color": "#fbfcfe",
      "text-outline-width": 2,
      "line-color": "data(relationColor)",
      "target-arrow-color": "data(relationColor)",
    },
  },
  {
    selector: "edge.is-highlighted",
    style: {
      width: 5,
      "line-color": "data(relationColor)",
      "target-arrow-color": "data(relationColor)",
      "font-weight": "bold",
      color: "data(relationColor)",
      "z-index": 10,
    },
  },
  { selector: ".is-dim", style: { opacity: 0.18 } },
  { selector: ".is-layout-hidden", style: { display: "none" } },
];

function focusRelation(instance: Core, edgeId: string) {
  const edge = instance.getElementById(edgeId);
  if (edge.empty()) return false;
  const target = edge.union(edge.connectedNodes());
  instance.resize();
  instance.fit(target, 72);
  // Keep the pair readable without excessively magnifying short edges or loops.
  if (instance.zoom() > 1.3) instance.zoom(1.3);
  instance.center(target);
  return true;
}

function arrangeGraph(instance: Core, highlightedOnly = false) {
  instance.elements().removeClass("is-layout-hidden");
  if (highlightedOnly)
    instance.elements(".is-dim").addClass("is-layout-hidden");
  const displayed = instance.elements().not(".is-layout-hidden");
  const layoutNodes = displayed.nodes();
  const count = Math.max(1, layoutNodes.length);
  const radius = 60 + count * 12;
  layoutNodes.positions((_node, index) => ({
    x: radius * Math.cos((2 * Math.PI * index) / count),
    y: radius * Math.sin((2 * Math.PI * index) / count),
  }));
  // Parallel category edges should not multiply the attraction between two nodes.
  const connectedPairs = new Set<string>();
  const layoutEdges = displayed.edges().filter((edge) => {
    if (edge.source().id() === edge.target().id()) return false;
    const pair = [edge.source().id(), edge.target().id()].sort().join("|");
    if (connectedPairs.has(pair)) return false;
    connectedPairs.add(pair);
    return true;
  });
  layoutNodes
    .union(layoutEdges)
    .layout({
      name: "cose",
      randomize: false,
      animate: false,
      fit: false,
      padding: 64,
      nodeRepulsion: (node: cytoscape.NodeSingular) =>
        22000 + Number(node.data("size")) * 350,
      idealEdgeLength: (edge: cytoscape.EdgeSingular) =>
        150 + Math.max(edge.source().width(), edge.target().width()),
      componentSpacing: 180,
      nodeOverlap: 40,
      numIter: 1600,
      nodeDimensionsIncludeLabels: true,
    } as cytoscape.LayoutOptions)
    .run();
  // Fit all displayed category curves after the node positions have settled.
  instance.fit(displayed, 64);
  instance.center(displayed);
  // 只有几个节点时 fit 会放得很大，限制一下。
  if (instance.zoom() > 1.6) {
    instance.zoom(1.6);
    instance.center(displayed);
  }
}

export function GraphView({
  hopInfo,
  nodes,
  edges,
  selected,
  selectedEdge,
  highlightedEdge,
  highlightedEdgeCategory,
  highlightedCategory,
  onSelect,
  onExpand,
  onSelectEdge,
  entityQuery = "",
  navigation,
  canvasRestore,
  onCanvasChange,
  emptyText = "没有可显示的实体",
}: {
  hopInfo?: GraphHopInfo | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected?: string | null;
  selectedEdge?: string | null;
  highlightedEdge?: string | null;
  highlightedEdgeCategory?: string | null;
  highlightedCategory?: string | null;
  onSelect?: (id: string) => void;
  onExpand?: (id: string) => void;
  onSelectEdge?: (edge: GraphEdge) => void;
  emptyText?: string;
  entityQuery?: string;
  navigation?: ReactNode;
  canvasRestore?: { token: number; state: GraphCanvasState } | null;
  onCanvasChange?: (state: GraphCanvasState) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const selectionHalo = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const canvasHandler = useRef(onCanvasChange);
  canvasHandler.current = onCanvasChange;
  const applyingCanvas = useRef(false);
  const restoreRequest = useRef(canvasRestore);
  restoreRequest.current = canvasRestore;
  const appliedRestore = useRef<number | null>(null);
  const activeRelation = useRef<string | null>(null);
  activeRelation.current = selectedEdge || highlightedEdge || null;
  // 事件回调总是用最新的 props，不用每次重新绑定。
  const handlers = useRef({ onSelect, onExpand, onSelectEdge, edges });
  handlers.current = { onSelect, onExpand, onSelectEdge, edges };
  const hasNodes = nodes.length > 0;
  const key =
    nodes
      .map(
        (node) =>
          `${node.id}:${node.hidden_neighbors}:${node.focus}:${node.name}:${node.type}`,
      )
      .join(",") +
    "|" +
    edges.map((edge) => `${edge.id}:${edge.count}`).join(",");
  const types = useMemo(
    () => [...new Set(nodes.map((node) => node.type))],
    [nodes],
  );

  // 创建和销毁 Cytoscape 实例。
  useEffect(() => {
    if (!container.current) return;
    const instance = cytoscape({
      container: container.current,
      style: STYLE,
      minZoom: 0.05,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });
    instance.on("tap", "node", (event) =>
      handlers.current.onSelect?.(event.target.id()),
    );
    instance.on("dbltap", "node", (event) =>
      handlers.current.onExpand?.(event.target.id()),
    );
    instance.on("tap", "edge", (event) => {
      const edge = handlers.current.edges.find(
        (item) => item.id === event.target.id(),
      );
      if (edge) handlers.current.onSelectEdge?.(edge);
    });
    // 鼠标停在节点、边上时用浏览器的提示框显示详情。
    instance.on("mouseover", "node, edge", (event) => {
      if (container.current)
        container.current.title = event.target.data("title") ?? "";
    });
    instance.on("mouseout", "node, edge", () => {
      if (container.current) container.current.title = "";
    });
    cy.current = instance;
    function saveCanvas() {
      if (
        applyingCanvas.current ||
        (restoreRequest.current &&
          appliedRestore.current !== restoreRequest.current.token)
      )
        return;
      const positions: GraphCanvasState["positions"] = {};
      instance.nodes().forEach((node) => {
        positions[node.id()] = { ...node.position() };
      });
      canvasHandler.current?.({
        zoom: instance.zoom(),
        pan: { ...instance.pan() },
        positions,
        edges: instance
          .edges()
          .map((edge) => edge.id())
          .sort(),
      });
    }
    instance.on("pan zoom dragfree layoutstop", saveCanvas);
    let resizeFrame = 0;
    let focused = Boolean(
      container.current?.closest(".graph-workspace.is-focused"),
    );
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        instance.resize();
        const nextFocused = Boolean(
          container.current?.closest(".graph-workspace.is-focused"),
        );
        const modeChanged = nextFocused !== focused;
        focused = nextFocused;
        // Cards and hop labels may change available space; preserve the camera.
        // Only switching focus mode automatically reframes the whole viewport.
        if (!modeChanged) return;
        if (instance.nodes().empty()) return;
        if (restoreRequest.current) return;
        if (
          activeRelation.current &&
          focusRelation(instance, activeRelation.current)
        )
          return;
        instance.fit(undefined, 48);
        if (instance.zoom() > 1.2) {
          instance.zoom(1.2);
          instance.center();
        }
      });
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      instance.destroy();
      cy.current = null;
    };
  }, [hasNodes]);

  // 数据变了重新放元素、重新布局。
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() => {
      instance.elements().remove();
      instance.add(elements(nodes, edges));
    });
    arrangeGraph(instance);
  }, [key, hasNodes]);

  // Updating hop labels must not recreate elements, rerun layout or move the camera.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() =>
      instance.nodes().forEach((node) => {
        const distance = hopInfo?.distances.get(node.id());
        const suffix = hopInfo
          ? ` · ${distance === undefined ? "未连通" : `${distance}跳`}`
          : "";
        node.data("label", `${node.data("baseLabel")}${suffix}`);
      }),
    );
  }, [hopInfo, key, hasNodes]);

  // 选中某个实体时，突出它和它的邻居，其他的淡化；相连的边显示关系分类。
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() => {
      instance
        .elements()
        .removeClass(
          "is-dim is-selected is-near is-highlighted is-layout-hidden",
        );
      for (const edge of edges) {
        const category =
          !selectedEdge &&
          edge.id === highlightedEdge &&
          highlightedEdgeCategory
            ? highlightedEdgeCategory
            : highlightedCategory &&
                edge.categories.includes(highlightedCategory)
              ? highlightedCategory
              : edge.categories.length === 1
                ? edge.categories[0]
                : null;
        instance
          .getElementById(edge.id)
          .data(
            "relationColor",
            category ? `hsl(${labelHue(category)}, 62%, 30%)` : "#64748b",
          );
      }
      const activeEdge = selectedEdge || highlightedEdge;
      if (activeEdge && !instance.getElementById(activeEdge).empty()) {
        const edge = instance.getElementById(activeEdge);
        edge.addClass("is-near is-highlighted");
        edge.connectedNodes().addClass("is-selected");
        instance
          .elements()
          .not(edge.union(edge.connectedNodes()))
          .addClass("is-dim");
        return;
      }
      if (!selected) return;
      const node = instance.getElementById(selected);
      if (node.empty()) return;
      if (highlightedCategory || entityQuery.trim()) {
        const ids = new Set(
          edges
            .filter((edge) => {
              if (
                highlightedCategory &&
                !edge.categories.includes(highlightedCategory)
              )
                return false;
              const neighbor =
                edge.source === selected ? edge.target : edge.source;
              return matchesEntityName(
                nodes.find((node) => node.id === neighbor)?.name ?? "",
                entityQuery,
              );
            })
            .map((edge) => edge.id),
        );
        const matching = node
          .connectedEdges()
          .filter((edge) => ids.has(edge.id()));
        const visible = matching.union(matching.connectedNodes()).union(node);
        node.addClass("is-selected");
        matching.addClass("is-near is-highlighted");
        if (entityQuery.trim())
          matching.connectedNodes().addClass("is-selected");
        instance.elements().not(visible).addClass("is-dim");
        return;
      }
      const near = node.closedNeighborhood();
      node.addClass("is-selected");
      node.connectedEdges().addClass("is-near");
      instance.elements().not(near).addClass("is-dim");
    });
    const activeEdge = selectedEdge || highlightedEdge;
    if (activeEdge) focusRelation(instance, activeEdge);
  }, [
    selected,
    selectedEdge,
    highlightedEdge,
    highlightedCategory,
    entityQuery,
    highlightedEdgeCategory,
    edges,
    key,
    hasNodes,
  ]);

  useEffect(() => {
    const instance = cy.current;
    if (
      !instance ||
      !canvasRestore ||
      appliedRestore.current === canvasRestore.token
    )
      return;
    const state = canvasRestore.state;
    const ids = instance
      .nodes()
      .map((node) => node.id())
      .sort();
    if (
      JSON.stringify(ids) !==
        JSON.stringify(Object.keys(state.positions).sort()) ||
      JSON.stringify(
        instance
          .edges()
          .map((edge) => edge.id())
          .sort(),
      ) !== JSON.stringify(state.edges)
    )
      return;
    applyingCanvas.current = true;
    instance.batch(() => {
      instance.nodes().positions((node) => state.positions[node.id()]);
      instance.viewport({ zoom: state.zoom, pan: state.pan });
    });
    appliedRestore.current = canvasRestore.token;
    applyingCanvas.current = false;
  }, [canvasRestore, key, hasNodes]);

  // The pulse is a DOM overlay: animate only transform/opacity, never the graph layout.
  useEffect(() => {
    const instance = cy.current;
    const halo = selectionHalo.current;
    if (!instance || !halo || !selected || selectedEdge) return;
    function syncHalo() {
      const node = instance!.getElementById(selected!);
      halo!.style.visibility = node.empty() ? "hidden" : "visible";
      if (node.empty()) return;
      const position = node.renderedPosition();
      const diameter = node.renderedWidth();
      halo!.style.width = `${diameter}px`;
      halo!.style.height = `${diameter}px`;
      halo!.style.transform = `translate(${position.x - diameter / 2}px, ${position.y - diameter / 2}px)`;
      halo!.style.color = node.data("stroke");
    }
    syncHalo();
    instance.on("pan zoom resize layoutstop", syncHalo);
    instance.on("position", "node", syncHalo);
    return () => {
      instance.off("pan zoom resize layoutstop", syncHalo);
      instance.off("position", "node", syncHalo);
    };
  }, [selected, selectedEdge, key, hasNodes]);

  if (!hasNodes) return <div className="graph-empty">{emptyText}</div>;
  function zoom(factor: number) {
    const instance = cy.current;
    if (!instance) return;
    instance.zoom({
      level: instance.zoom() * factor,
      renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 },
    });
  }

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <div className="graph-legend">
          {types.map((type) => {
            const color = typeColor(type);
            return (
              <span key={type}>
                <i
                  style={{ background: color.fill, borderColor: color.stroke }}
                />
                {type}
              </span>
            );
          })}
        </div>
        <div className="graph-zoom">
          <button type="button" onClick={() => zoom(1.25)}>
            ＋
          </button>
          <button type="button" onClick={() => zoom(1 / 1.25)}>
            －
          </button>
          <button type="button" onClick={() => cy.current?.fit(undefined, 30)}>
            适应
          </button>
          <button
            type="button"
            title="重新均匀排布当前节点并适配画布"
            onClick={() => {
              if (cy.current) arrangeGraph(cy.current, true);
            }}
          >
            重新布局
          </button>
        </div>
      </div>
      <div className="graph-interaction-hint">
        <span>
          <strong>单击实体</strong>：突出已显示的邻居、查看详情
        </span>
        <span>
          <strong>双击实体</strong>：每次再显示最多 15 个邻居（可重复双击）
        </span>
      </div>
      <div className="graph-canvas-wrap">
        {navigation}
        <div ref={container} className="graph-canvas" />
        {selected &&
          !selectedEdge &&
          nodes.some((node) => node.id === selected) && (
            <div
              key={selected}
              ref={selectionHalo}
              className="graph-selection-halo"
              aria-hidden="true"
            >
              <i />
              <i />
            </div>
          )}
      </div>
      <small className="graph-hint">
        滚轮缩放、拖动空白处平移、拖动节点调整位置；点击实体看详情，点击关系线看出处。名字后面的
        +数字 表示还有几个相连的实体没显示；每次双击再显示最多 15
        个邻居，可重复双击继续展开。
      </small>
    </div>
  );
}
