import { createContext, useContext, useState, type ReactNode } from "react";
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

type EvidenceFilterValue = "all" | "evidence" | "non-evidence";
type EvidenceLocation = { chunkId?: string | null; text?: string };

export function filterEvidenceRows<T>(
  rows: T[],
  matches: (row: T) => boolean,
  value: EvidenceFilterValue,
) {
  const marked = rows.map((row) => ({ row, evidence: matches(row) }));
  const evidence = marked.filter((item) => item.evidence).length;
  return {
    rows: marked
      .filter(
        (item) => value === "all" || item.evidence === (value === "evidence"),
      )
      .map((item) => item.row),
    counts: {
      all: rows.length,
      evidence,
      "non-evidence": rows.length - evidence,
    },
  };
}

export function useEvalEvidenceFilter<T>(
  rows: T[],
  locate?: (row: T) => EvidenceLocation,
) {
  const items = useContext(EvalEvidenceContext);
  const [value, setValue] = useState<EvidenceFilterValue>("all");
  const enabled = items !== undefined && locate !== undefined;
  const result = filterEvidenceRows(
    rows,
    (row) => {
      const location = locate?.(row);
      return (
        !!location &&
        matchingScoringItems(items ?? [], location.chunkId, location.text)
          .length > 0
      );
    },
    enabled ? value : "all",
  );
  return { ...result, enabled, value, setValue };
}

export function EvalEvidenceFilter({
  filter,
  onChange,
}: {
  filter: {
    enabled: boolean;
    value: EvidenceFilterValue;
    counts: Record<EvidenceFilterValue, number>;
    setValue: (value: EvidenceFilterValue) => void;
  };
  onChange?: () => void;
}) {
  if (!filter.enabled) return null;
  return (
    <div className="eval-evidence-filter" role="group" aria-label="证据筛选">
      {(
        [
          ["all", "全部"],
          ["evidence", "证据"],
          ["non-evidence", "非证据"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          className="secondary-button button-sm"
          aria-pressed={filter.value === value}
          onClick={() => {
            filter.setValue(value);
            onChange?.();
          }}
        >
          {label} {filter.counts[value]}
        </button>
      ))}
    </div>
  );
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
        <Tag tone="neutral" className="eval-evidence-unmatched">
          不是证据
        </Tag>
      )}
    </span>
  );
}
