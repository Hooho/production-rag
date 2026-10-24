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

export type TypeStat = { type: string; count: number; passed: number; fixed_passed?: number; agent_passed?: number;
  // 证据命中：一共几条证据、两边各命中几条（旧记录没有）。
  evidence_total?: number; fixed_hits?: number; agent_hits?: number };

// 按类型统计：每类题的通过数（证据全拿到算通过），以及证据命中条数（命中的证据 / 全部证据）。
// 只看通过数会掩盖差别：汇总题拿到 6/7 和 1/7 都算没通过。两种模式一起跑时固定流程、Agent 各两列；最后一行是合计。
export function TypeStats({ stats, hues, both }: { stats: TypeStat[]; hues: Map<string, number>; both: boolean }) {
  // 全部通过：绿色加 ✓；一道都没过：红色；其余正常显示。
  const cell = (passed: number | undefined, count: number) => {
    if (passed === undefined) return "—";
    const state = count > 0 && passed >= count ? "is-all" : passed === 0 ? "is-none" : "";
    return <span className={`type-stat ${state}`}>{state === "is-all" && <b aria-label="全部通过">✓</b>}{passed} / {count}</span>;
  };
  const evidence = (hits: number | undefined, total: number | undefined) => {
    if (hits === undefined || !total) return "—";
    return <span className={`type-stat ${hits >= total ? "is-all" : hits === 0 ? "is-none" : ""}`}>{Math.round((hits / total) * 100)}%<small>{hits} / {total}</small></span>;
  };
  const sum = (key: keyof TypeStat) => stats.some((row) => row[key] !== undefined) ? stats.reduce((value, row) => value + (Number(row[key]) || 0), 0) : undefined;
  const total: TypeStat = { type: "合计", count: sum("count") ?? 0, passed: sum("passed") ?? 0, fixed_passed: sum("fixed_passed"), agent_passed: sum("agent_passed"),
    evidence_total: sum("evidence_total"), fixed_hits: sum("fixed_hits"), agent_hits: sum("agent_hits") };
  const hasEvidence = stats.some((row) => row.evidence_total);
  const row = (item: TypeStat, isTotal = false) => <tr key={item.type} className={isTotal ? "is-total" : ""}>
    <td>{isTotal ? "合计" : <TypeTag type={item.type} hues={hues} />}</td><td className="num">{item.count}</td>
    {both ? <>
      <td className="num">{cell(item.fixed_passed, item.count)}</td>{hasEvidence && <td className="num">{evidence(item.fixed_hits, item.evidence_total)}</td>}
      <td className="num">{cell(item.agent_passed, item.count)}</td>{hasEvidence && <td className="num">{evidence(item.agent_hits, item.evidence_total)}</td>}
    </> : <>
      <td className="num">{cell(item.passed, item.count)}</td>{hasEvidence && <td className="num">{evidence(item.fixed_hits ?? item.agent_hits, item.evidence_total)}</td>}
    </>}
  </tr>;
  return <div className="diag-table-wrap type-stats-wrap"><table className="diag-table ev-table type-stats">
    <thead><tr><th>类型</th><th className="num">题数</th>{both
      ? <><th className="num">固定流程通过</th>{hasEvidence && <th className="num">固定流程证据命中率</th>}<th className="num">Agent 通过</th>{hasEvidence && <th className="num">Agent 证据命中率</th>}</>
      : <><th className="num">通过</th>{hasEvidence && <th className="num">证据命中率</th>}</>}</tr></thead>
    <tbody>{stats.map((item) => row(item))}{stats.length > 1 && row(total, true)}</tbody>
  </table></div>;
}
