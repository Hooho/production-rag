// 分类色：预设 48 个色相，按黄金角（137.5°）间隔取，相邻两个的颜色差得足够开；超过 48 个从头循环。
// 红色和偏红的玫红（315°～25°）留给"失败"这类语义色（tag.css 的 tone-danger），分类色跳过这一段，免得类型标签看起来像报错。
// 用在：Agent 执行链的工具颜色、专项题目类型、评测类型和运行模式（Tag.tsx 的 hue 着色）。
function isRed(hue: number) {
  return hue >= 315 || hue < 25;
}

export const PRESET_HUES: number[] = [];
for (let index = 0; PRESET_HUES.length < 48; index += 1) {
  const hue = Math.round((215 + index * 137.508) % 360);
  if (!isRed(hue)) PRESET_HUES.push(hue);
}

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

// 固定的分类标签（评测类型、运行模式、调参评测集的五种题型）：先占好位置，颜色固定不变，新名字依次往后排。
export const labelHue = huePicker(["检索", "生成", "专项", "多轮对话", "固定流程", "Agent", "回答", "事实", "同义改写", "关键词", "多轮追问", "无法回答"]);
