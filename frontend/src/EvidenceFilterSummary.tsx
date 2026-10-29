import type { EvalQuestion } from "./api";
import "./EvidenceFilterSummary.css";
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
  const { items, total, missing, unknown } = evidenceFilters(questions, mode);
  const groups = Object.entries(FILTER_LABELS) as [FilterStage, string][];
  return (
    <div className="ag-mode-row is-result">
      <span className="ag-mode-label">召回后被过滤</span>
      <div className="ag-mode-value">
        <b>
          {unknown
            ? "未记录完整"
            : missing
              ? `${items.length} / ${missing} · ${Math.round((items.length / missing) * 100)}%`
              : total
                ? "0 / 0 · —"
                : "—"}
        </b>
        <small>已召回后被过滤的计分项，占最终未拿到的全部计分项的比例</small>
        <details className="ag-filter-details">
          <summary>
            查看过滤明细
            <span>{items.length} 项</span>
          </summary>
          {unknown > 0 && (
            <p className="ag-filter-unknown">{unknown} 项缺少完整记录</p>
          )}
          <div className="ag-filter-groups">
            {groups.map(([stage, label]) => {
              const selected = items.filter((item) => item.stage === stage);
              return (
                <section
                  key={stage}
                  className={`ag-filter-group${selected.length ? "" : " is-empty"}`}
                >
                  <div className="ag-filter-heading">
                    <span>{label}</span>
                    <span className="ag-filter-count">{selected.length}</span>
                  </div>
                  {selected.length > 0 && (
                    <ul>
                      {selected.map((item, index) => (
                        <li key={index}>
                          <div className="ag-filter-question">
                            <span className="ag-filter-field-label">题目</span>
                            <span>{item.question}</span>
                          </div>
                          <div className="ag-filter-item-label">
                            <span className="ag-filter-field-label">
                              计分项
                            </span>
                            <span>{item.label}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}
