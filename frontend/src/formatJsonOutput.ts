// 仅格式化展示，解析失败时保留模型原始文本。
export function formatJsonOutput(text: string | null | undefined): string {
  if (!text) return text ?? "";
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try {
    return JSON.stringify(JSON.parse(fenced?.[1] ?? text), null, 2);
  } catch {
    return text;
  }
}
