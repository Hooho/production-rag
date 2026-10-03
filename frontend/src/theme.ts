// 界面配色：<html data-theme="green"> 时用绿调（颜色变量见 theme.css）。
// 设置在系统参数里，所有用户一起切换；先用浏览器里记住的上一次配色，避免打开页面时先闪一下蓝色再变绿，
// 然后再向服务端确认当前设置。
export type Theme = "blue" | "green";
const STORAGE_KEY = "ui-theme";

export function applyTheme(theme: string) {
  const value: Theme = theme === "green" ? "green" : "blue";
  if (value === "green") document.documentElement.dataset.theme = "green";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 浏览器禁止本地存储时只是下次打开会先显示蓝调，不影响使用。
  }
}

export function initTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) applyTheme(saved);
  } catch {
    // 同上，忽略。
  }
  fetch("/api/settings/ui").then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data?.theme) applyTheme(data.theme);
  }).catch(() => undefined);
}
