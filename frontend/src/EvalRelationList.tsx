import { useState, type CSSProperties } from "react";
import Table, { TablePagination } from "./Table";
import { DetailDialog } from "./DetailDialog";
import { InfoPopover } from "./Popover";
import { ChunkOriginalText } from "./ChunkOriginalText";
import { buildHaystack, normalizeSearch, SearchText } from "./searchText";
import { labelHue } from "./hues";
import type { ContextRelation } from "./api";
import "./GraphRetrieval.css";
import {
  EvalEvidenceAnnotation,
  EvalEvidenceFilter,
  useEvalEvidenceFilter,
} from "./EvalEvidenceAnnotation";

const PAGE_SIZE = 6;

// 一行关系能搜到的文字：这一行看得见的字段都算（和图检索「详情」里的关系表同一套规则）。
function relationHaystack(row: ContextRelation) {
  return buildHaystack([
    row.context_id,
    row.source,
    row.target,
    row.category,
    row.description,
    row.evidence,
    row.title,
    row.version ? `图 v${row.version}` : "",
    row.text,
    row.tokens,
  ]);
}

// 交给模型的图谱关系：列表 + 搜索框，和图检索「详情」抽屉里的关系表一致。
// status=context 是真的放进了回答上下文；beyond_budget 是图检索留下了但额度不够没放。
export function EvalRelationList({
  relations,
  reason,
  onClose,
}: {
  relations: ContextRelation[];
  reason?: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [dropped, setDropped] = useState(false);
  const [page, setPage] = useState(1);
  const given = relations.filter((row) => row.status === "context");
  const skipped = relations.filter((row) => row.status !== "context");
  const pool = dropped ? relations : given;
  const needle = normalizeSearch(query);
  const filtered = needle
    ? pool.filter((row) => relationHaystack(row).includes(needle))
    : pool;
  const evidenceFilter = useEvalEvidenceFilter(filtered, (row) => ({
    chunkId: row.chunk_id,
    relationId: row.relation_id,
  }));
  const pages = Math.max(1, Math.ceil(evidenceFilter.rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = evidenceFilter.rows.slice(
    (current - 1) * PAGE_SIZE,
    current * PAGE_SIZE,
  );
  const search = (next: string) => {
    setQuery(next);
    setPage(1);
  };
  return (
    <DetailDialog
      open
      title={`交给模型的图谱关系 · ${given.length} 条`}
      className="grt-dialog"
      size="table"
      onClose={onClose}
    >
      <div className="diag grt">
        <div className="grt-filter-top">
          <div className="grt-chips">
            <span className="grt-chip is-active is-static">
              放进上下文 <em>{given.length}</em>
            </span>
          </div>
          {/* 搜索框在右上角：按这一行看得见的文字过滤。 */}
          <div className="grt-search">
            <input
              type="search"
              className="input-sm"
              value={query}
              placeholder="搜实体、关系描述或原文"
              aria-label="搜实体、关系描述或原文"
              onChange={(event) => search(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="link-button button-sm"
                onClick={() => search("")}
              >
                清空
              </button>
            )}
          </div>
        </div>
        {skipped.length > 0 && (
          <label className="grt-dropped-toggle">
            <input
              type="checkbox"
              checked={dropped}
              onChange={(event) => {
                setDropped(event.target.checked);
                setPage(1);
              }}
            />
            包括没放进去的 {skipped.length} 条{reason ? `（${reason}）` : ""}
          </label>
        )}
        <EvalEvidenceFilter
          filter={evidenceFilter}
          onChange={() => setPage(1)}
        />
        <p className="grt-hint">
          每条关系按「起点 → 关系类型 → 终点：描述」写给模型，另附原文引用。
        </p>
        {rows.length === 0 ? (
          <p className="grt-empty">
            {query ? `没有匹配「${query}」的关系` : "没有放进上下文的关系"}
          </p>
        ) : (
          <Table
            containerProps={{ className: "diag-table-wrap" }}
            className="diag-table grt-table"
          >
            <thead>
              <tr>
                <th>编号</th>
                <th>关系</th>
                <th>出处</th>
                <th>大小</th>
                <th>去向</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.relation_id}
                  className={row.status === "context" ? "" : "is-dropped"}
                >
                  <td className="num">
                    <SearchText text={row.context_id} query={query} />
                  </td>
                  <td>
                    <span className="grt-rel">
                      <EvalEvidenceAnnotation
                        chunkId={row.chunk_id}
                        relationEvidence={row.evidence ?? null}
                        relationId={row.relation_id}
                      />
                      <span className="grt-rel-line">
                        <b>
                          <SearchText text={row.source} query={query} />
                        </b>
                        <span className="grt-arrow">→</span>
                        <small
                          className="grt-category is-hue"
                          style={
                            {
                              "--tag-h": labelHue(row.category),
                            } as CSSProperties
                          }
                        >
                          <SearchText text={row.category} query={query} />
                        </small>
                        <span className="grt-arrow">→</span>
                        <b>
                          <SearchText text={row.target} query={query} />
                        </b>
                      </span>
                      {row.description && (
                        <small className="grt-rel-desc">
                          <SearchText text={row.description} query={query} />
                        </small>
                      )}
                      {row.evidence && (
                        <small className="grt-evidence" title="原文引用">
                          「<SearchText text={row.evidence} query={query} />」
                        </small>
                      )}
                    </span>
                  </td>
                  <td>
                    <EvalEvidenceAnnotation chunkId={row.chunk_id} origin />
                    <span className="grt-origin">
                      <SearchText text={row.title} query={query} />
                      {row.version ? <em>图 v{row.version}</em> : null}
                    </span>
                    {row.text && (
                      <InfoPopover
                        title={`${row.context_id ?? ""} 给模型的原文`}
                        content={() => (
                          <ChunkOriginalText
                            text={row.text}
                            groups={[
                              {
                                kind: "evidence",
                                texts: (row.evidence ?? "")
                                  .split("||")
                                  .filter((item) => item.trim()),
                              },
                              {
                                kind: "entity",
                                texts: [row.source, row.target],
                              },
                            ]}
                          />
                        )}
                      >
                        <button type="button" className="link-button button-sm">
                          原文
                        </button>
                      </InfoPopover>
                    )}
                  </td>
                  <td className="num">
                    {row.text ? `${row.text.length} 字` : "—"}
                    {row.tokens ? <small>约 {row.tokens} token</small> : null}
                  </td>
                  <td>
                    {row.status === "context" ? (
                      <span className="grt-kept">✓ 放进上下文</span>
                    ) : row.status === "beyond_budget" ? (
                      <span className="grt-dropped">✕ 额度不够，没放</span>
                    ) : (
                      <span className="grt-dropped">✕ 没放</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <TablePagination
          page={current}
          pageSize={PAGE_SIZE}
          total={evidenceFilter.rows.length}
          onPageChange={setPage}
        />
      </div>
    </DetailDialog>
  );
}
