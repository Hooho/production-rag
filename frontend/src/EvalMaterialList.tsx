import { useState } from "react";
import Table, { TablePagination } from "./Table";
import { DetailDialog } from "./DetailDialog";
import { buildHaystack, normalizeSearch, SearchText } from "./searchText";
import type { EvalMaterial } from "./api";
import "./GraphRetrieval.css";

const PAGE_SIZE = 8;

// 交给模型的每一段资料：编号、命中的分片（+父块扩展几片）、哪次检索拿到的、含哪几条证据、多少字。
export type MaterialEntry = {
  id: string;
  chunkId: string | null;
  position?: number | null;
  extended: number;
  from: string;
  hits: number[];
  extHits: number[];
};

function chunkLabel(
  position: number | null | undefined,
  chunkId?: string | null,
) {
  if (typeof position === "number") return `第 ${position + 1} 片`;
  const index = chunkId?.match(/:(\d+)$/)?.[1];
  if (index !== undefined) return `第 ${Number(index) + 1} 片`;
  return chunkId ?? "—";
}

function entryHaystack(entry: MaterialEntry) {
  return buildHaystack([
    entry.id,
    chunkLabel(entry.position, entry.chunkId),
    entry.from,
    entry.hits.map((index) => `证据 ${index + 1}`).join("、"),
    entry.extHits.map((index) => `证据 ${index + 1}`).join("、"),
  ]);
}

// 交给模型的资料逐段明细：编号、分片、哪次检索拿到的、含哪几条证据、多少字。
export function MaterialListDialog({
  material,
  entries,
  onClose,
}: {
  material: EvalMaterial | null;
  entries: MaterialEntry[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const sizes = new Map(
    (material?.items ?? []).map((item) => [item.chunk_id, item]),
  );
  const needle = normalizeSearch(query);
  const filtered = needle
    ? entries.filter((entry) => entryHaystack(entry).includes(needle))
    : entries;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const search = (next: string) => {
    setQuery(next);
    setPage(1);
  };
  return (
    <DetailDialog
      open
      title={`交给模型的资料 · ${entries.length} 段`}
      className="grt-dialog"
      size="table"
      onClose={onClose}
    >
      <div className="diag grt">
        <div className="grt-filter-top">
          <div className="grt-chips">
            <span className="grt-chip is-active is-static">
              交给模型 <em>{entries.length}</em>
            </span>
          </div>
          {/* 搜索框在右上角：按这一行看得见的文字过滤。 */}
          <div className="grt-search">
            <input
              type="search"
              className="input-sm"
              value={query}
              placeholder="搜编号、分片或证据"
              aria-label="搜编号、分片或证据"
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
        <p className="grt-hint">
          编号是这一份资料里的顺序；「含证据」写的是命中的计分项，标了扩展的是在父块扩展拼进来的分片里。
        </p>
        {rows.length === 0 ? (
          <p className="grt-empty">
            {query ? `没有匹配「${query}」的资料` : "没有交给模型的资料"}
          </p>
        ) : (
          <Table
            containerProps={{ className: "diag-table-wrap" }}
            className="diag-table grt-table"
          >
            <thead>
              <tr>
                <th>编号</th>
                <th>分片</th>
                <th>哪次拿到的</th>
                <th>含哪些证据</th>
                <th>大小</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const size = entry.chunkId
                  ? sizes.get(entry.chunkId)
                  : undefined;
                const direct = entry.hits.filter(
                  (index) => !entry.extHits.includes(index),
                );
                return (
                  <tr key={entry.id}>
                    <td className="num">
                      <SearchText text={entry.id} query={query} />
                    </td>
                    <td>
                      <SearchText
                        text={chunkLabel(entry.position, entry.chunkId)}
                        query={query}
                      />
                      {entry.extended ? (
                        <small>扩展 {entry.extended} 片</small>
                      ) : null}
                    </td>
                    <td>
                      <SearchText text={entry.from} query={query} />
                    </td>
                    <td>
                      {direct.length > 0 && (
                        <span className="grt-kept">
                          含证据{" "}
                          <SearchText
                            text={direct.map((index) => index + 1).join("、")}
                            query={query}
                          />
                        </span>
                      )}
                      {entry.extHits.length > 0 && (
                        <small>
                          证据{" "}
                          <SearchText
                            text={entry.extHits
                              .map((index) => index + 1)
                              .join("、")}
                            query={query}
                          />{" "}
                          在扩展的分片里
                        </small>
                      )}
                      {!entry.hits.length ? <small>—</small> : null}
                    </td>
                    <td className="num">
                      {size ? (
                        <>
                          {size.chars.toLocaleString()} 字
                          <small>约 {size.tokens.toLocaleString()} token</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <TablePagination
          page={current}
          pageSize={PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
        />
      </div>
    </DetailDialog>
  );
}
