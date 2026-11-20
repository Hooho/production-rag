import type { ReactNode } from "react";

// 明细表搜索用的归一化：忽略空白、全角半角（NFKC）、大小写。
// 和后端 app/textnorm.py 的证据匹配一样宽松：搜「通用 电气」也能命中「通用电气公司」。
function normalizeChar(char: string): string {
  if (/\s/.test(char)) return "";
  return char.normalize("NFKC").toLowerCase();
}

// 归一化后的字符 → 原文下标，用来把命中位置映射回原文（归一化会去掉空白，位置会错位）。
function normalizeWithMap(text: string) {
  const chars: string[] = [];
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    for (const char of normalizeChar(text[index])) {
      chars.push(char);
      map.push(index);
    }
  }
  return { text: chars.join(""), map };
}

// 归一化一段文字（过滤和匹配都用这一套规则）。
export function normalizeSearch(text: string): string {
  return normalizeWithMap(text).text;
}

// 一整行可搜索的文字：把这一行所有可见字段拼起来再归一化，任一字段命中就算命中。
export function buildHaystack(
  fields: (string | number | null | undefined)[],
): string {
  return normalizeSearch(
    fields.filter((field) => field != null && field !== "").join(" "),
  );
}

// 命中的文字高亮：按归一化后的位置切原文，空白差异不影响高亮位置。
export function SearchText({
  text,
  query,
}: {
  text?: string | null;
  query: string;
}): ReactNode {
  if (text == null || text === "") return null;
  const needle = normalizeWithMap(query).text;
  if (!needle) return text;
  const { text: haystack, map } = normalizeWithMap(text);
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const start = map[index];
    const end = map[index + needle.length - 1] + 1;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="grt-hit" key={parts.length}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (!parts.length) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
