import type { CSSProperties, ReactNode } from "react";
import { hueMap, labelHue } from "./hues";
import type { Tone } from "./tags";

// 公共标签（样式见 tag.css）。颜色二选一：
//   tone：有好坏含义的状态，用语义色（含义和颜色的对应集中在 tags.ts）；
//   hue：只为区分类别，用分类色（色相来自 hues.ts）；hue 传 true 时按文字从固定分类标签里取色。
// dot：前面带圆点，表示状态；outline：只描边；plain：普通字重；mono：等宽字体；size="sm"：小号。
type TagProps = {
  tone?: Tone;
  hue?: number | true;
  dot?: boolean;
  outline?: boolean;
  plain?: boolean;
  mono?: boolean;
  size?: "sm" | "md";
  title?: string;
  className?: string;
  // 可以点的标签（例如点开看详情）：渲染成按钮。
  onClick?: () => void;
  expanded?: boolean;
  children: ReactNode;
};

export function Tag({ tone, hue, dot, outline, plain, mono, size, title, className, onClick, expanded, children }: TagProps) {
  const classes = ["tag"];
  if (hue !== undefined) classes.push("is-hue");
  else classes.push(`tone-${tone ?? "neutral"}`);
  if (dot) classes.push("is-dot");
  if (outline) classes.push("is-outline");
  if (plain) classes.push("is-plain");
  if (mono) classes.push("is-mono");
  if (size === "sm") classes.push("is-sm");
  if (className) classes.push(className);
  const style = hue === undefined ? undefined
    : { "--tag-h": hue === true ? labelHue(String(children)) : hue } as CSSProperties;
  if (onClick) return <button type="button" className={[...classes, "is-button"].join(" ")} style={style} title={title} onClick={onClick} aria-expanded={expanded}>{children}</button>;
  return <span className={classes.join(" ")} style={style} title={title}>{children}</span>;
}

// 固定的分类标签（评测类型、运行模式）：颜色按名字固定。
export function HueTag({ label, size }: { label: string; size?: "sm" | "md" }) {
  return <Tag hue={labelHue(label)} size={size}>{label}</Tag>;
}

// 题目类型标签：颜色按类型在这一组题里第一次出现的顺序取（hueMap）。
export function TypeTag({ type, hues }: { type: string | null | undefined; hues: Map<string, number> }) {
  if (!type) return null;
  return <Tag hue={hues.get(type) ?? labelHue(type)}>{type}</Tag>;
}

export { hueMap as typeHues };

export type TypeStat = { type: string; count: number; passed: number; fixed_passed?: number; agent_passed?: number };

// 按类型统计通过数：只跑一种模式时一列「通过」，两种模式一起跑时固定流程、Agent 各一列。
export function TypeStats({ stats, hues, both }: { stats: TypeStat[]; hues: Map<string, number>; both: boolean }) {
  // 全部通过：绿色加 ✓；一道都没过：红色；其余正常显示。
  const cell = (passed: number | undefined, count: number) => {
    if (passed === undefined) return "—";
    const state = count > 0 && passed >= count ? "is-all" : passed === 0 ? "is-none" : "";
    return <span className={`type-stat ${state}`}>{state === "is-all" && <b aria-label="全部通过">✓</b>}{passed} / {count}</span>;
  };
  return <div className="diag-table-wrap type-stats-wrap"><table className="diag-table ev-table type-stats">
    <thead><tr><th>类型</th><th className="num">题数</th>{both ? <><th className="num">固定流程通过</th><th className="num">Agent 通过</th></> : <th className="num">通过</th>}</tr></thead>
    <tbody>{stats.map((row) => <tr key={row.type}><td><TypeTag type={row.type} hues={hues} /></td><td className="num">{row.count}</td>
      {both ? <><td className="num">{cell(row.fixed_passed, row.count)}</td><td className="num">{cell(row.agent_passed, row.count)}</td></> : <td className="num">{cell(row.passed, row.count)}</td>}</tr>)}</tbody>
  </table></div>;
}
