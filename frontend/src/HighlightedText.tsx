import { useEffect, useRef } from "react";
import { evidenceRanges } from "./evidenceRanges";
import "./HighlightedText.css";

// 打开原文时高亮相关的实体和原文引用（前端交互约束「原文高亮」，见 AGENTS.md）：
//   entity      这次要看的实体名字：浅蓝底 + 下划线
//   entity-weak 一起出现、用来对比的实体名字：浅灰底 + 虚线
//   evidence    原文引用：黄底
// 匹配忽略空白、全角半角和 PDF 部首字（evidenceRanges）；打开时自动滚到第一处高亮；
// 原文引用在这段文字里找不到时，在上面提示。
export type HighlightKind = "entity" | "entity-weak" | "evidence";
export type HighlightGroup = {
  kind: HighlightKind;
  texts: (string | null | undefined)[];
};

const ORDER: HighlightKind[] = ["evidence", "entity", "entity-weak"];

export function HighlightedText({
  text,
  groups = [],
  className = "graph-chunk-text",
  autoScroll = true,
}: {
  text: string;
  groups?: HighlightGroup[];
  className?: string;
  // 分段展示时（ChunkOriginalText）只让第一处高亮的那一段滚动，避免每段都抢着滚。
  autoScroll?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  // 每个字符被哪几种高亮覆盖（位掩码），相同的连续字符合成一段。
  const masks = new Uint8Array(text.length);
  const missing: string[] = [];
  for (const group of groups) {
    const bit = 1 << ORDER.indexOf(group.kind);
    const texts = [
      ...new Set(group.texts.filter((item): item is string => !!item?.trim())),
    ];
    for (const value of texts) {
      const ranges = evidenceRanges(text, [value]);
      if (!ranges.length && group.kind === "evidence") missing.push(value);
      for (const [start, end] of ranges)
        for (let index = start; index < end; index += 1) masks[index] |= bit;
    }
  }
  const parts: { text: string; mask: number }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = parts[parts.length - 1];
    if (last && last.mask === masks[index]) last.text += text[index];
    else parts.push({ text: text[index], mask: masks[index] });
  }
  useEffect(() => {
    if (!autoScroll) return;
    root.current
      ?.querySelector("mark")
      ?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [text, autoScroll]);
  return (
    <div ref={root}>
      {missing.length > 0 && (
        <p className="graph-note hl-missing">
          原文引用在这一片里没有找到（可能被模型改写过）：
          {missing.map((item) => `「${item}」`).join("、")}
        </p>
      )}
      <p className={className}>
        {parts.map((part, index) =>
          part.mask ? (
            <mark
              key={index}
              className={ORDER.filter((_, bit) => part.mask & (1 << bit))
                .map((kind) => `hl-${kind}`)
                .join(" ")}
            >
              {part.text}
            </mark>
          ) : (
            part.text
          ),
        )}
      </p>
    </div>
  );
}
