// 标签的含义 → 语义色，集中在这里定义（样式见 tag.css，组件见 Tag.tsx）。
// 页面里不再自己写颜色：同一种含义（成功、失败、运行中……）全站同一个颜色，改一处就全站生效。
export type Tone =
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "neutral"
  | "accent"
  | "gold"
  | "silver"
  | "slate";

// 后端配置里写的颜色名（app/business/definitions.py 的 tones，例如会员等级、物流状态）换成语义色。
const COLOR_TONES: Record<string, Tone> = {
  green: "success",
  red: "danger",
  orange: "warning",
  blue: "info",
  gray: "neutral",
  purple: "accent",
  gold: "gold",
  silver: "silver",
  slate: "slate",
};
export function colorTone(color: string | null | undefined): Tone {
  return (color && COLOR_TONES[color]) || "neutral";
}

// 评测、复测这类后台任务的运行状态（评测记录、专项、巡检复测集共用）。
export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "运行中", tone: "info" },
  queued: { label: "排队中", tone: "neutral" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  interrupted: { label: "已中断", tone: "warning" },
};
export function runStatus(status: string) {
  return RUN_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
}

// 通过 / 没通过（专项、复测逐题）。
export function passTone(passed: boolean): Tone {
  return passed ? "success" : "danger";
}

// 和上一次比：新通过、新失败、新加入。
export const CHANGE_TONES: Record<string, Tone> = {
  fixed: "success",
  regressed: "danger",
  new: "neutral",
};

// 文档处理状态：可用、处理中、排队、失败或被拒、待审核、暂存、被标记。
export function documentStatusTone(status: string): Tone {
  if (status.startsWith("ready")) return "success";
  if (status.startsWith("processing")) return "info";
  if (status === "queued") return "warning";
  if (status === "failed" || status === "rejected") return "danger";
  if (status.startsWith("review:")) return "accent";
  if (status.startsWith("staged:")) return "warning";
  if (status.startsWith("flagged:")) return "danger";
  return "neutral";
}

// 巡检问题状态：待处理、已处理、已解决、无需处理。
export const INSPECTION_STATUS_TONES: Record<string, Tone> = {
  open: "warning",
  handled: "info",
  resolved: "success",
  ignored: "neutral",
};

// 文档可见范围：私有、共享给部门、公开、不上架；公开审核中、公开未通过另外标。
export const VISIBILITY_TONES: Record<string, Tone> = {
  private: "neutral",
  shared: "warning",
  public: "success",
  unlisted: "neutral",
};
