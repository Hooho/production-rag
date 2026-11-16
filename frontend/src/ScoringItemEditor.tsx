import { useEffect, useRef, useState } from "react";
import {
  listEvalTargetChunks,
  type EvalScoringGroup,
  type EvalScoringTarget,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { ConfirmPopover } from "./ConfirmPopover";
import { EvidenceTargetTags } from "./EvidenceTargetTags";
import { foldText } from "./evidenceRanges";

import "./Special.css";

const PAGE_SIZE = 10;
const targetKey = (target: EvalScoringTarget) =>
  `${target.title}:${target.position}:${target.fingerprint}`;

export function ScoringItemEditor({
  groups,
  onChange,
}: {
  groups: EvalScoringGroup[];
  onChange: (value: EvalScoringGroup[]) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<EvalScoringTarget[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const options = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active === null) return;
    setCatalog(null);
    let cancelled = false;
    setError("");
    listEvalTargetChunks()
      .then((data) => {
        if (!cancelled) setCatalog(data.items);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : "读取分片失败");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  function update(index: number, changes: Partial<EvalScoringGroup>) {
    onChange(
      groups.map((group, i) =>
        i === index ? { ...group, ...changes } : group,
      ),
    );
  }
  const group = active === null ? undefined : groups[active];
  const chosen = new Set(group?.targets.map(targetKey));
  const needle = foldText(search).toLowerCase();
  // 搜索框里输入的内容：打开原文时高亮出来，省得在一大片正文里找。
  const searchTerms = search.trim() ? [search.trim()] : [];
  const filtered = (catalog ?? []).filter(
    (target) =>
      (!title || target.title === title) &&
      (!needle ||
        foldText(`${target.position + 1} ${target.quote}`)
          .toLowerCase()
          .includes(needle)),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  useEffect(() => {
    if (options.current) options.current.scrollTop = 0;
  }, [currentPage]);
  return (
    <div className="sp-scoring-wrap">
      <div className="sp-scoring-editor">
        {groups.map((item, index) => (
          <div className="sp-scoring-item" key={index}>
            <div className="sp-scoring-heading">
              <label>
                计分项 {index + 1}
                <input
                  aria-label={`计分项 ${index + 1}名称`}
                  value={item.label}
                  maxLength={100}
                  placeholder="例如：诺基亚"
                  onChange={(event) =>
                    update(index, { label: event.target.value })
                  }
                />
              </label>
              <ConfirmPopover
                message={`移除计分项 ${index + 1}？这一项和它选的分片一起没了。`}
                confirmText="移除"
                danger
                onConfirm={() => onChange(groups.filter((_, i) => i !== index))}
              >
                <button type="button" className="rg-link">
                  移除计分项
                </button>
              </ConfirmPopover>
            </div>
            {item.targets.length > 0 && (
              <div className="sp-scoring-targets">
                {item.targets.map((target) => (
                  <div className="sp-scoring-target" key={targetKey(target)}>
                    <EvidenceTargetTags
                      targets={[target]}
                      number={index + 1}
                      highlight={searchTerms}
                    />
                    <ConfirmPopover
                      message={`移除第 ${target.position + 1} 片？这一项就不再按它算命中。`}
                      confirmText="移除"
                      danger
                      onConfirm={() =>
                        update(index, {
                          targets: item.targets.filter(
                            (chosen) => targetKey(chosen) !== targetKey(target),
                          ),
                        })
                      }
                    >
                      <button
                        type="button"
                        className="rg-link"
                        aria-label={`移除第 ${target.position + 1} 片`}
                      >
                        ×
                      </button>
                    </ConfirmPopover>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="rg-link"
              onClick={() => {
                setActive(index);
                setSearch("");
                setTitle("");
                setPage(1);
              }}
            >
              选择分片（已选 {item.targets.length} 片）
            </button>
          </div>
        ))}
        <div className="sp-scoring-add">
          <button
            type="button"
            className="secondary-button"
            onClick={() => onChange([...groups, { label: "", targets: [] }])}
          >
            ＋ 添加计分项
          </button>
        </div>
      </div>
      <small className="rg-muted">
        每项至少选择一个分片；命中其中任意一个即得该项分数。
      </small>
      <DetailDialog
        open={group !== undefined}
        title={`选择目标分片 · ${group?.label || "未命名计分项"}`}
        onClose={() => setActive(null)}
      >
        <div className="sp-chunk-filters">
          <select
            aria-label="筛选书籍"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部书籍</option>
            {[...new Set((catalog ?? []).map((target) => target.title))].map(
              (name) => (
                <option key={name}>{name}</option>
              ),
            )}
          </select>
          <input
            aria-label="搜索分片"
            placeholder="搜索分片编号或正文"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {error ? (
          <p role="alert">{error}</p>
        ) : !catalog ? (
          <p role="status">正在读取分片…</p>
        ) : (
          <div className="sp-chunk-options" ref={options}>
            {!filtered.length && <p className="rg-muted">没有符合条件的分片</p>}
            {visible.map((target) => (
              <div className="sp-chunk-option" key={targetKey(target)}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(targetKey(target))}
                    onChange={(event) => {
                      if (active === null || !group) return;
                      update(active, {
                        targets: event.target.checked
                          ? [...group.targets, target]
                          : group.targets.filter(
                              (item) => targetKey(item) !== targetKey(target),
                            ),
                      });
                    }}
                  />
                  <span>
                    <strong>
                      第 {target.position + 1} 片 · {target.title}
                    </strong>
                    <small>
                      {target.quote.slice(0, 140)}
                      {target.quote.length > 140 ? "…" : ""}
                    </small>
                  </span>
                </label>
                <EvidenceTargetTags
                  targets={[target]}
                  number={(active ?? 0) + 1}
                  buttonLabel="查看详情"
                  highlight={searchTerms}
                />
              </div>
            ))}
          </div>
        )}
        {catalog && !error && (
          <nav className="sp-chunk-pagination" aria-label="分片分页">
            <span className="rg-muted">
              共 {filtered.length} 片 · 每页 {PAGE_SIZE} 片
            </span>
            <div className="sp-chunk-page-controls">
              <button
                type="button"
                className="secondary-button"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <select
                className="sp-chunk-page-select"
                aria-label="跳转页码"
                value={currentPage}
                onChange={(event) => setPage(Number(event.target.value))}
              >
                {Array.from({ length: pageCount }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    第 {i + 1} / {pageCount} 页
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary-button"
                disabled={currentPage === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          </nav>
        )}
        <div className="rg-buttons sp-chunk-footer">
          <span className="rg-muted">已选 {group?.targets.length ?? 0} 片</span>
          <button
            type="button"
            className="primary-button"
            onClick={() => setActive(null)}
          >
            完成选择
          </button>
        </div>
      </DetailDialog>
    </div>
  );
}
