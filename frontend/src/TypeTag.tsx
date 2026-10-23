import type { CSSProperties } from "react";
import { hueMap, labelHue } from "./hues";

// 通用的彩色标签：hue 不传时按名字从固定标签的预设里取色（评测类型、运行模式等）。
export function HueTag({ label, hue }: { label: string; hue?: number }) {
  return <span className="hue-tag" style={{ "--tag-h": hue ?? labelHue(label) } as CSSProperties}>{label}</span>;
}

// 题目类型标签：颜色按类型在这一组题里第一次出现的顺序取预设色相（hues.ts，和 Agent 执行链的工具颜色同一套）。
export function TypeTag({ type, hues }: { type: string | null | undefined; hues: Map<string, number> }) {
  if (!type) return null;
  return <HueTag label={type} hue={hues.get(type) ?? 215} />;
}

export { hueMap as typeHues };

export type TypeStat = { type: string; count: number; passed: number; fixed_passed?: number; agent_passed?: number };

// 按类型统计通过数：只跑一种模式时一列「通过」，两种模式一起跑时固定流程、Agent 各一列。
export function TypeStats({ stats, hues, both }: { stats: TypeStat[]; hues: Map<string, number>; both: boolean }) {
  const cell = (passed: number | undefined, count: number) => passed === undefined ? "—" : `${passed} / ${count}`;
  return <div className="diag-table-wrap"><table className="diag-table ev-table type-stats">
    <thead><tr><th>类型</th><th className="num">题数</th>{both ? <><th className="num">固定流程通过</th><th className="num">Agent 通过</th></> : <th className="num">通过</th>}</tr></thead>
    <tbody>{stats.map((row) => <tr key={row.type}><td><TypeTag type={row.type} hues={hues} /></td><td className="num">{row.count}</td>
      {both ? <><td className="num">{cell(row.fixed_passed, row.count)}</td><td className="num">{cell(row.agent_passed, row.count)}</td></> : <td className="num">{cell(row.passed, row.count)}</td>}</tr>)}</tbody>
  </table></div>;
}
