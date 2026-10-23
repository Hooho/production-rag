// 标签颜色：预设 48 个色相，按黄金角（137.5°）间隔取，相邻两个的颜色差得足够开；超过 48 个从头循环。
// 原来只在 Agent 执行链里给工具上色（AgentTrace.tsx），专项题目的类型标签也用同一套：
// 一组名字按第一次出现的顺序依次取色，同一组里同一个名字颜色固定。样式类是 .hue-tag，色相放在 --tag-h。
export const PRESET_HUES = Array.from({ length: 48 }, (_, index) => Math.round((215 + index * 137.508) % 360));

// 给一组名字分配色相：initial 是预先占好位置的名字（例如已有的 4 个工具），之后新出现的名字依次往后排。
export function huePicker(initial: string[] = []) {
  const order = new Map<string, number>(initial.map((name, index) => [name, index]));
  return (name: string) => {
    if (!order.has(name)) order.set(name, order.size);
    return PRESET_HUES[order.get(name)! % PRESET_HUES.length];
  };
}

// 按名字第一次出现的顺序分配色相，返回 名字 → 色相。
export function hueMap(names: (string | null | undefined)[]) {
  const pick = huePicker();
  const result = new Map<string, number>();
  for (const name of names) if (name && !result.has(name)) result.set(name, pick(name));
  return result;
}
