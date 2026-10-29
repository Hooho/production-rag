import type { EvalQuestion } from "./api";
import {
  evidenceFilters,
  FILTER_LABELS,
  type FilterStage,
} from "./evidenceFilters";

export function EvidenceFilterSummary({
  questions,
  mode,
}: {
  questions: EvalQuestion[];
  mode: "fixed" | "agent";
}) {
  const { items, total, unknown } = evidenceFilters(questions, mode);
  const groups = Object.entries(FILTER_LABELS) as [FilterStage, string][];
  return (
    <div className="ag-mode-row is-result">
      <span className="ag-mode-label">召回后被过滤</span>
      <span className="ag-mode-value">
        <b>
          {unknown
            ? "未记录完整"
            : total
              ? `${items.length} / ${total} · ${Math.round((items.length / total) * 100)}%`
              : "—"}
        </b>
        <small>已召回、最终未拿到的计分项；占全部计分项的比例</small>
        <details>
          <summary>
            查看过滤阶段与计分项{unknown ? `（${unknown} 项缺少完整记录）` : ""}
          </summary>
          {groups.map(([stage, label]) => {
            const selected = items.filter((item) => item.stage === stage);
            return (
              <div key={stage}>
                <strong>
                  {label}：{selected.length} 项
                </strong>
                {selected.length > 0 && (
                  <ul>
                    {selected.map((item, index) => (
                      <li key={index}>
                        {item.question} · {item.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </details>
      </span>
    </div>
  );
}
