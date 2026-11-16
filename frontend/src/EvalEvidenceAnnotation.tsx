import { createContext, useContext, type ReactNode } from "react";
import { InfoPopover } from "./Popover";
import { Tag } from "./Tag";
import { evidenceRanges } from "./evidenceRanges";
import type { EvalEvidenceGroup } from "./api";
import "./EvalEvidenceAnnotation.css";

type EvidenceItem = EvalEvidenceGroup & {
  text?: string;
  chunk_id?: string | null;
  chunk_ids?: string[];
};

// 仅由评测日志提供上下文，聊天和图谱页面不显示计分标注。
export const EvalEvidenceContext = createContext<EvidenceItem[] | undefined>(
  undefined,
);

export function withEvalEvidence(items: EvidenceItem[], children: ReactNode) {
  return (
    <EvalEvidenceContext.Provider value={items}>
      {children}
    </EvalEvidenceContext.Provider>
  );
}

export function matchingScoringItems(
  items: EvidenceItem[],
  chunkId?: string | null,
  text?: string,
) {
  return items.flatMap((item, index) => {
    const ids = item.targets?.length
      ? item.targets.map((target) => target.chunk_id)
      : [...(item.chunk_ids ?? []), ...(item.chunk_id ? [item.chunk_id] : [])];
    const matched =
      chunkId && ids.length
        ? ids.includes(chunkId)
        : !item.targets?.length &&
          !!text &&
          !!item.text &&
          evidenceRanges(text, [item.text]).length > 0;
    return matched ? [{ item, number: index + 1 }] : [];
  });
}

export function EvalEvidenceAnnotation({
  chunkId,
  text,
  relationEvidence,
}: {
  chunkId?: string | null;
  text?: string;
  relationEvidence?: string | null;
}) {
  const items = useContext(EvalEvidenceContext);
  if (items === undefined) return null;
  const matches = matchingScoringItems(items, chunkId, text);
  const relation = relationEvidence !== undefined;
  return (
    <span className="eval-evidence-annotation">
      {matches.length ? (
        matches.map(({ item, number }) => (
          <InfoPopover
            key={number}
            title={`计分项 ${number}：${item.label || `要点 ${number}`}`}
            content={() => (
              <div>
                <strong>标注的证据摘录</strong>
                {(item.targets?.length
                  ? item.targets.map((target) => target.quote)
                  : [item.text]
                )
                  .filter(Boolean)
                  .map((quote, index) => (
                    <p key={index}>{quote}</p>
                  ))}
                {relation && (
                  <>
                    <strong>关系的原文依据</strong>
                    <p>{relationEvidence || "未保存原文依据"}</p>
                  </>
                )}
              </div>
            )}
          >
            <button type="button" className="link-button button-sm">
              <Tag tone="success">
                {relation ? "关联计分证据" : "计分证据"} · 第 {number} 项：
                {item.label || `要点 ${number}`}
              </Tag>
            </button>
          </InfoPopover>
        ))
      ) : (
        <span className="eval-evidence-unmatched">未匹配计分证据</span>
      )}
    </span>
  );
}
