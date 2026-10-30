import { useState } from "react";
import { DetailDialog } from "./DetailDialog";
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { items, total, missing, unrecalled, unknown } = evidenceFilters(
    questions,
    mode,
  );
  const groups = Object.entries(FILTER_LABELS) as [FilterStage, string][];
  return (
    <>
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
          <button
            type="button"
            className="ag-filter-trigger"
            onClick={() => setDetailsOpen(true)}
            aria-haspopup="dialog"
          >
            查看过滤明细
            <span>{items.length} 项</span>
          </button>
          <DetailDialog
            open={detailsOpen}
            title={`过滤明细 · ${mode === "agent" ? "Agent" : "固定流程"} · ${items.length} 项`}
            onClose={() => setDetailsOpen(false)}
            className="ag-filter-dialog"
          >
            <div className="ag-filter-details">
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
                        <span className="ag-filter-count">
                          {selected.length}
                        </span>
                      </div>
                      {selected.length > 0 && (
                        <ul>
                          {selected.map((item, index) => (
                            <li key={index}>
                              <div className="ag-filter-question">
                                <span className="ag-filter-field-label">
                                  题目
                                </span>
                                <span>{item.question}</span>
                              </div>
                              <div className="ag-filter-item-label">
                                <span className="ag-filter-field-label">
                                  计分项
                                </span>
                                <span>{item.label}</span>
                              </div>
                              <div className="ag-filter-metrics">
                                {(
                                  [
                                    [
                                      "向量排名",
                                      item.ranks?.vector_rank,
                                      false,
                                    ],
                                    [
                                      "关键词排名",
                                      item.ranks?.keyword_rank,
                                      false,
                                    ],
                                    ["合并排名", item.ranks?.rrf_rank, false],
                                    [
                                      "重排分数",
                                      item.ranks?.rerank_probability,
                                      true,
                                    ],
                                  ] as const
                                ).map(([label, value, score]) => (
                                  <span key={label}>
                                    <span>{label}</span>
                                    <b>
                                      {typeof value === "number" &&
                                      Number.isFinite(value)
                                        ? score
                                          ? value.toFixed(4)
                                          : value
                                        : score &&
                                            [
                                              "not_in_pool",
                                              "return_limit",
                                            ].includes(item.stage)
                                          ? "未重排"
                                          : "未记录"}
                                    </b>
                                  </span>
                                ))}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          </DetailDialog>
        </div>
      </div>
      <div className="ag-mode-row is-result">
        <span className="ag-mode-label">完全没找到</span>
        <div className="ag-mode-value">
          <b>
            {unknown
              ? "未记录完整"
              : missing
                ? `${unrecalled} / ${missing} · ${Math.round((unrecalled / missing) * 100)}%`
                : total
                  ? "0 / 0 · —"
                  : "—"}
          </b>
          <small>完全未召回的计分项，占本次最终未返回的计分项的比例</small>
        </div>
      </div>
    </>
  );
}
