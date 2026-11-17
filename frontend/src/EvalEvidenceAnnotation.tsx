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
  relationId?: string,
) {
  return items.flatMap((item, index) => {
    const ids = item.targets?.length
      ? item.targets.map((target) => target.chunk_id)
      : [...(item.chunk_ids ?? []), ...(item.chunk_id ? [item.chunk_id] : [])];
    const matched =
      relationId !== undefined
        ? (item.relations ?? []).some(
            (relation) => relation.relation_id === relationId,
          )
        : chunkId && ids.length
          ? ids.includes(chunkId)
          : !item.targets?.length &&
            !!text &&
            !!item.text &&
            evidenceRanges(text, [item.text]).length > 0;
    return matched ? [{ item, number: index + 1 }] : [];
  });
}

type EvidenceFilterValue =
  | "all"
  | "evidence"
  | "non-evidence"
  | "chunk-evidence";
type EvidenceLocation = {
  chunkId?: string | null;
  text?: string;
  relationId?: string;
};

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
  const relationMode = rows.some(
    (row) => locate?.(row).relationId !== undefined,
  );
  const chunkRows = rows.filter((row) => {
    const location = locate?.(row);
    return (
      location &&
      matchingScoringItems(items ?? [], location.chunkId, location.text)
        .length > 0
    );
  });
  const result = filterEvidenceRows(
    rows,
    (row) => {
      const location = locate?.(row);
      return (
        !!location &&
        matchingScoringItems(
          items ?? [],
          location.chunkId,
          location.text,
          location.relationId,
        ).length > 0
      );
    },
    enabled ? value : "all",
  );
  return {
    ...result,
    rows: value === "chunk-evidence" ? chunkRows : result.rows,
    counts: { ...result.counts, "chunk-evidence": chunkRows.length },
    relationMode,
    enabled,
    value,
    setValue,
  };
}

export function EvalEvidenceFilter({
  filter,
  onChange,
}: {
  filter: {
    enabled: boolean;
    relationMode?: boolean;
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
          ["evidence", filter.relationMode ? "关系证据" : "证据"],
          [
            filter.relationMode ? "chunk-evidence" : "non-evidence",
            filter.relationMode ? "出处含分片证据" : "非证据",
          ],
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
  relationId,
  origin = false,
}: {
  chunkId?: string | null;
  text?: string;
  relationEvidence?: string | null;
  relationId?: string;
  origin?: boolean;
}) {
  const items = useContext(EvalEvidenceContext);
  if (items === undefined) return null;
  const matches = matchingScoringItems(items, chunkId, text, relationId);
  const relation = relationEvidence !== undefined;
  if (!matches.length) return null;
  return (
    <span className="eval-evidence-annotation">
      {matches.map(({ item, number }) => (
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
              {relation ? "关系证据" : origin ? "分片证据" : "计分证据"} · 第{" "}
              {number} 项：
              {item.label || `要点 ${number}`}
            </Tag>
          </button>
        </InfoPopover>
      ))}
    </span>
  );
}
