// 耗时按量级换成时分秒。以前各页面直接显示毫秒（819029 ms），有的连单位都没有，要自己换算才知道多久；
// 现在所有耗时统一用这里的格式：不到 1 秒保留毫秒；不到 1 分钟保留一位小数，方便比较相近的两次结果；更长时拆成时、分、秒。
// 显示成「10/09 14:30」这样的月日时分；解析不了时原样返回。
export function formatShortTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const ms = Math.round(Math.abs(value));
  const sign = value < 0 ? "-" : "";
  if (ms < 1000) return `${sign}${ms} 毫秒`;
  // 按四舍五入后的秒数判断，避免 59960 毫秒显示成"60.0 秒"。
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${sign}${tenths.toFixed(1)} 秒`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} 时`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes} 分`);
  parts.push(`${seconds} 秒`);
  return sign + parts.join(" ");
}

// 耗时差值：带正负号，例如 +0.5 秒、-2.1 秒。
export function formatDurationDelta(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return (value > 0 ? "+" : "") + formatDuration(value);
}

// 悬停提示里的原始毫秒数，需要精确数字时查看。
export function durationTitle(value: number | null | undefined) {
  return value === null || value === undefined ? undefined : `${Math.round(value)} ms`;
}

// 字段名以 _ms 结尾且值是数字时视为耗时，结果面板里新加的耗时字段不用再单独处理。
export function isDurationField(key: string | undefined, value: unknown): value is number {
  return !!key && key.endsWith("_ms") && typeof value === "number";
}
