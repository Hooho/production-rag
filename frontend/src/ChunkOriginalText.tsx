import { HighlightedText, type HighlightGroup } from "./HighlightedText";
import { evidenceRanges } from "./evidenceRanges";
import "./ChunkOriginalText.css";

// 分片原文是三段拼起来的：上下文说明、标题路径、正文。
// 拆开各给一个底色，一眼能看出哪段是什么（结构与后端 app/storage.py 的 chunk_body 一致）。
// 说明在最前面，接着一行「标题路径：…」，后面是正文；没有标题路径时整段都是正文。
export type ChunkTextParts = { note: string; path: string; body: string };

export function splitChunkText(text: string): ChunkTextParts {
  const lines = text.split("\n");
  const pathIndex = lines.findIndex((line) => line.startsWith("标题路径："));
  if (pathIndex < 0) return { note: "", path: "", body: text.trim() };
  return {
    note: lines.slice(0, pathIndex).join("\n").trim(),
    path: lines[pathIndex].trim(),
    body: lines
      .slice(pathIndex + 1)
      .join("\n")
      .trim(),
  };
}

// 原文的统一展示：说明、标题路径、正文三段各一个底色，高亮走 HighlightedText。
// 原文引用（kind: evidence）只在它真正所在的那一段里高亮，避免同一段引用在三段里重复提示；
// 一段都没找到时放进正文段，提示只出现一次（evidenceHint 关掉就不提示）。
export function ChunkOriginalText({
  text,
  groups = [],
  evidenceHint = true,
}: {
  text: string;
  groups?: HighlightGroup[];
  evidenceHint?: boolean;
}) {
  const parts = splitChunkText(text ?? "");
  const entries = [
    { kind: "note" as const, text: parts.note },
    { kind: "path" as const, text: parts.path },
    { kind: "body" as const, text: parts.body },
  ].filter((item) => item.text);
  if (!entries.length) return null;

  const others = groups.filter((group) => group.kind !== "evidence");
  const quotes = groups
    .filter((group) => group.kind === "evidence")
    .flatMap((group) => group.texts)
    .flatMap((value) => (value ? value.split("||") : []))
    .map((value) => value.trim())
    .filter(Boolean);
  const matched = entries.map((entry) =>
    quotes.filter((quote) => evidenceRanges(entry.text, [quote]).length > 0),
  );
  const unmatched = quotes.filter(
    (quote) => !matched.some((list) => list.includes(quote)),
  );

  const bodyIndex = entries.findIndex((entry) => entry.kind === "body");
  // 只有第一处出现高亮的段落负责滚到高亮处，其余段落不抢滚动。
  const scrollIndex = entries.findIndex(
    (entry, index) =>
      matched[index].length > 0 ||
      others.some((group) =>
        group.texts.some(
          (value) =>
            value?.trim() && evidenceRanges(entry.text, [value]).length > 0,
        ),
      ),
  );
  return (
    <div className="chunk-original">
      {entries.map((entry, index) => {
        const texts = [...matched[index]];
        if (evidenceHint && unmatched.length && index === bodyIndex)
          texts.push(...unmatched);
        const partGroups: HighlightGroup[] = [
          ...others,
          ...(texts.length ? [{ kind: "evidence" as const, texts }] : []),
        ];
        return (
          <div
            key={entry.kind}
            className={`chunk-original-part chunk-original-${entry.kind}`}
          >
            <HighlightedText
              text={entry.text}
              groups={partGroups}
              className="chunk-original-text"
              autoScroll={index === scrollIndex}
            />
          </div>
        );
      })}
    </div>
  );
}
