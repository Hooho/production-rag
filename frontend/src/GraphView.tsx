import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { GraphEdge, GraphNode } from "./api";
import { labelHue } from "./hues";
import "./Graph.css";

// 知识图谱的图：自己用 SVG 画，不引入画图库。布局用 Fruchterman-Reingold 力导向算法，节点几十到一两百个时在浏览器里一次算完。
// 文档「实体关系」页签、全局「知识图谱」共用，第 2 期检索过程里的遍历图也会复用。
const WIDTH = 900;
const HEIGHT = 560;
const ITERATIONS = 300;

type Point = { x: number; y: number };

// 同一组节点和边每次算出来的位置都一样：初始位置按顺序排在圆上，不用随机数。
function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const positions = new Map<string, Point>();
  const count = nodes.length;
  if (count === 0) return positions;
  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / count;
    const radius =
      Math.min(WIDTH, HEIGHT) * 0.35 * (0.6 + (0.4 * ((index * 7) % 5)) / 4);
    positions.set(node.id, {
      x: WIDTH / 2 + radius * Math.cos(angle),
      y: HEIGHT / 2 + radius * Math.sin(angle),
    });
  });
  if (count === 1) return positions;
  const k = Math.sqrt((WIDTH * HEIGHT) / count) * 0.75;
  let temperature = WIDTH / 8;
  const ids = nodes.map((node) => node.id);
  for (let step = 0; step < ITERATIONS; step += 1) {
    const moves = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < count; i += 1) {
      const a = positions.get(ids[i])!;
      for (let j = i + 1; j < count; j += 1) {
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          distance = Math.hypot(dx, dy);
        }
        const force = (k * k) / distance;
        const ma = moves.get(ids[i])!;
        const mb = moves.get(ids[j])!;
        ma.x += (dx / distance) * force;
        ma.y += (dy / distance) * force;
        mb.x -= (dx / distance) * force;
        mb.y -= (dy / distance) * force;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const force = (distance * distance) / k;
      const ma = moves.get(edge.source)!;
      const mb = moves.get(edge.target)!;
      ma.x -= (dx / distance) * force;
      ma.y -= (dy / distance) * force;
      mb.x += (dx / distance) * force;
      mb.y += (dy / distance) * force;
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const move = moves.get(id)!;
      // 往中心拉一点，没有连线的点不会被推到很远。
      move.x += (WIDTH / 2 - point.x) * 0.02 * k;
      move.y += (HEIGHT / 2 - point.y) * 0.02 * k;
      const length = Math.max(0.01, Math.hypot(move.x, move.y));
      point.x += (move.x / length) * Math.min(length, temperature);
      point.y += (move.y / length) * Math.min(length, temperature);
    }
    temperature *= 0.985;
  }
  return positions;
}

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
      fill: "hsl(215 15% 92%)",
      stroke: "hsl(215 12% 50%)",
      text: "hsl(215 15% 30%)",
    };
  const hue = TYPE_HUES[type] ?? labelHue(type);
  return {
    fill: `hsl(${hue} 75% 90%)`,
    stroke: `hsl(${hue} 45% 42%)`,
    text: `hsl(${hue} 55% 26%)`,
  };
}

function radius(node: GraphNode) {
  return 7 + Math.min(15, Math.sqrt(node.relation_count) * 3);
}

export function GraphView({
  nodes,
  edges,
  selected,
  onSelect,
  onExpand,
  onSelectEdge,
  emptyText = "没有可显示的实体",
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  onExpand?: (id: string) => void;
  onSelectEdge?: (edge: GraphEdge) => void;
  emptyText?: string;
}) {
  const key =
    nodes.map((node) => node.id).join(",") +
    "|" +
    edges.map((edge) => edge.id).join(",");
  const positions = useMemo(() => layout(nodes, edges), [key]);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const bounds = useMemo(() => {
    const points = [...positions.values()];
    if (points.length === 0)
      return { x: 0, y: 0, width: WIDTH, height: HEIGHT };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const padding = 60;
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    return {
      x: minX,
      y: minY,
      width: Math.max(...xs) + padding - minX,
      height: Math.max(...ys) + padding - minY,
    };
  }, [positions]);
  const neighbors = useMemo(() => {
    if (!selected) return null;
    const value = new Set<string>([selected]);
    for (const edge of edges) {
      if (edge.source === selected) value.add(edge.target);
      if (edge.target === selected) value.add(edge.source);
    }
    return value;
  }, [selected, edges]);
  // 滚轮缩放：React 的 onWheel 是被动监听，不能阻止页面跟着滚动，所以直接加原生监听。
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    function onWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((value) => ({
        ...value,
        scale: Math.min(6, Math.max(0.4, value.scale * factor)),
      }));
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [hasNodes]);
  const types = useMemo(
    () => [...new Set(nodes.map((node) => node.type))],
    [nodes],
  );
  if (nodes.length === 0) return <div className="graph-empty">{emptyText}</div>;
  const box = {
    width: bounds.width / view.scale,
    height: bounds.height / view.scale,
  };
  const viewBox = `${bounds.x + view.x + (bounds.width - box.width) / 2} ${bounds.y + view.y + (bounds.height - box.height) / 2} ${box.width} ${box.height}`;

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if ((event.target as Element).closest(".graph-node, .graph-edge")) return;
    drag.current = {
      x: view.x,
      y: view.y,
      startX: event.clientX,
      startY: event.clientY,
    };
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || !svg.current) return;
    const ratio = box.width / svg.current.clientWidth;
    const start = drag.current;
    setView((value) => ({
      ...value,
      x: start.x - (event.clientX - start.startX) * ratio,
      y: start.y - (event.clientY - start.startY) * ratio,
    }));
  }
  function onPointerUp() {
    drag.current = null;
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
          <button
            type="button"
            onClick={() =>
              setView((value) => ({
                ...value,
                scale: Math.min(6, value.scale * 1.25),
              }))
            }
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() =>
              setView((value) => ({
                ...value,
                scale: Math.max(0.4, value.scale / 1.25),
              }))
            }
          >
            －
          </button>
          <button
            type="button"
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
          >
            适应
          </button>
        </div>
      </div>
      <svg
        ref={svg}
        className="graph-canvas"
        viewBox={viewBox}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const a = positions.get(edge.source);
          const b = positions.get(edge.target);
          const target = nodes.find((node) => node.id === edge.target);
          if (!a || !b || !target) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.max(1, Math.hypot(dx, dy));
          const end = {
            x: b.x - (dx / length) * (radius(target) + 3),
            y: b.y - (dy / length) * (radius(target) + 3),
          };
          const dim =
            neighbors &&
            !(
              neighbors.has(edge.source) &&
              neighbors.has(edge.target) &&
              (edge.source === selected || edge.target === selected)
            );
          return (
            <g
              key={edge.id}
              className={`graph-edge ${dim ? "is-dim" : ""} ${onSelectEdge ? "is-clickable" : ""}`}
              onClick={() => onSelectEdge?.(edge)}
            >
              <title>{`${edge.categories.join("、")}（${edge.count} 条）\n${edge.descriptions.join("\n")}`}</title>
              <line
                x1={a.x}
                y1={a.y}
                x2={end.x}
                y2={end.y}
                strokeWidth={Math.min(5, 1 + Math.log2(edge.count + 1))}
                markerEnd="url(#graph-arrow)"
              />
              <line
                className="graph-edge-hit"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
              {edge.source === selected || edge.target === selected ? (
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 4}
                  className="graph-edge-label"
                >
                  {edge.categories.join("、")}
                  {edge.count > 1 ? ` ×${edge.count}` : ""}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((node) => {
          const point = positions.get(node.id)!;
          const color = typeColor(node.type);
          const size = radius(node);
          const dim = neighbors && !neighbors.has(node.id);
          return (
            <g
              key={node.id}
              className={`graph-node ${dim ? "is-dim" : ""} ${node.id === selected ? "is-selected" : ""}`}
              transform={`translate(${point.x} ${point.y})`}
              onClick={() => onSelect?.(node.id)}
            >
              <title>{`${node.name}（${node.type}）：${node.relation_count} 条关系，出现 ${node.mention_count} 次`}</title>
              <circle
                r={size}
                fill={color.fill}
                stroke={color.stroke}
                strokeWidth={node.id === selected ? 3 : node.focus ? 2.5 : 1.5}
              />
              <text
                y={size + 13}
                className="graph-node-label"
                fill={color.text}
              >
                {node.name.length > 12
                  ? `${node.name.slice(0, 12)}…`
                  : node.name}
              </text>
              {node.hidden_neighbors > 0 && onExpand ? (
                <g
                  className="graph-node-more"
                  transform={`translate(${size * 0.75} ${-size * 0.75})`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onExpand(node.id);
                  }}
                >
                  <title>{`还有 ${node.hidden_neighbors} 个相连的实体没显示，点击展开`}</title>
                  <circle r={8} />
                  <text y={3.5}>
                    +{node.hidden_neighbors > 99 ? "99" : node.hidden_neighbors}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
      <small className="graph-hint">
        滚轮缩放、拖动空白处平移；点击实体看详情，右上角的 +数字
        表示还有没显示的相连实体，点击展开。
      </small>
    </div>
  );
}
