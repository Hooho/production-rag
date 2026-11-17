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
import {
  RelationEvidenceCards,
  RelationEvidenceList,
} from "./RelationEvidenceCards";
import { errorText, useToast } from "./Toast";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";

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
  const toast = useToast();
  const [mode, setMode] = useState<"chunks" | "relations">("chunks");
  const [relationTab, setRelationTab] = useState<"select" | "selected">(
    "select",
  );
  const [relationDocument, setRelationDocument] = useState("");
  const [relationChunk, setRelationChunk] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<EvalScoringTarget[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const options = useRef<HTMLDivElement>(null);
  const needsCatalog =
    active !== null || groups.some((group) => group.relations?.length);
  useEffect(() => {
    if (!needsCatalog) return;
    let cancelled = false;
    setError("");
    listEvalTargetChunks()
      .then((data) => {
        if (!cancelled) setCatalog(data.items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError("读取失败，请关闭后重试");
          toast("error", errorText(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needsCatalog, toast]);
  function update(index: number, changes: Partial<EvalScoringGroup>) {
    if (changes.targets) {
      changes = {
        ...changes,
        targets: changes.targets.map(
          ({ relations: _relations, ...target }) => target,
        ),
      };
    }
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
                <button type="button" className="link-button button-sm">
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
                      onConfirm={() => {
                        if (item.relations?.length) {
                          toast(
                            "error",
                            "请先在关系证据分支取消已选关系，再移除分片",
                          );
                          return;
                        }
                        update(index, {
                          targets: item.targets.filter(
                            (row) => targetKey(row) !== targetKey(target),
                          ),
                        });
                      }}
                    >
                      <button
                        type="button"
                        className="link-button button-sm"
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
              className="link-button button-sm"
              onClick={() => {
                setMode("chunks");
                setActive(index);
                setSearch("");
                setTitle("");
                setPage(1);
              }}
            >
              选择分片（已选 {item.targets.length} 片）
            </button>
            <button
              type="button"
              className="link-button button-sm"
              disabled={!item.targets.length}
              onClick={() => {
                setRelationDocument("");
                setRelationTab("select");
                setRelationChunk(targetKey(item.targets[0]));
                setMode("relations");
                setActive(index);
              }}
            >
              配置关系证据（已选 {item.relations?.length ?? 0} 条）
            </button>
            <RelationEvidenceList
              relations={item.relations ?? []}
              catalog={catalog ?? []}
            />
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
        title={`${mode === "relations" ? "选择关系证据" : "选择目标分片"} · ${group?.label || "未命名计分项"}`}
        onClose={() => setActive(null)}
      >
        {mode === "relations" ? (
          error ? (
            <p className="rg-muted">{error}</p>
          ) : !catalog ? (
            <LoadingSkeleton>
              <SkeletonBlock style={{ height: 100 }} />
            </LoadingSkeleton>
          ) : (
            <>
              <div
                className="sp-chunk-filters"
                role="group"
                aria-label="关系证据视图"
              >
                <button
                  type="button"
                  className="secondary-button button-sm"
                  aria-pressed={relationTab === "select"}
                  onClick={() => setRelationTab("select")}
                >
                  选择
                </button>
                <button
                  type="button"
                  className="secondary-button button-sm"
                  aria-pressed={relationTab === "selected"}
                  onClick={() => setRelationTab("selected")}
                >
                  已选（{group?.relations?.length ?? 0} 条）
                </button>
              </div>
              {relationTab === "select" && (
                <>
                  <div
                    className="sp-chunk-filters"
                    role="group"
                    aria-label="筛选关系出处文档"
                  >
                    {[
                      "",
                      ...new Set(group?.targets.map((target) => target.title)),
                    ].map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="secondary-button button-sm"
                        aria-pressed={relationDocument === name}
                        onClick={() => {
                          setRelationDocument(name);
                          const first = group?.targets.find(
                            (target) => !name || target.title === name,
                          );
                          setRelationChunk(first ? targetKey(first) : "");
                        }}
                      >
                        {name || "全部文档"}
                      </button>
                    ))}
                  </div>
                  <div
                    className="sp-chunk-filters"
                    role="group"
                    aria-label="筛选关系出处分片"
                  >
                    {group?.targets
                      .filter(
                        (target) =>
                          !relationDocument ||
                          target.title === relationDocument,
                      )
                      .map((target) => (
                        <button
                          key={targetKey(target)}
                          type="button"
                          className="secondary-button button-sm"
                          aria-pressed={relationChunk === targetKey(target)}
                          onClick={() => setRelationChunk(targetKey(target))}
                        >
                          第 {target.position + 1} 片
                        </button>
                      ))}
                  </div>
                </>
              )}
              {relationTab === "selected" && (
                <>
                  {!group?.relations?.length && (
                    <p className="rg-muted">尚未选择关系证据</p>
                  )}
                  <RelationEvidenceCards
                    relations={(group?.relations ?? []).filter((relation) =>
                      catalog.some(
                        (target) =>
                          group?.targets.some(
                            (row) => targetKey(row) === targetKey(target),
                          ) &&
                          target.relations?.some(
                            (row) => row.relation_id === relation.relation_id,
                          ),
                      ),
                    )}
                    selected={
                      new Set(group?.relations?.map((row) => row.relation_id))
                    }
                    onToggle={(relation, checked) => {
                      if (active === null || checked) return;
                      update(active, {
                        relations: group?.relations?.filter(
                          (row) => row.relation_id !== relation.relation_id,
                        ),
                      });
                    }}
                  />
                </>
              )}
              {relationTab === "select" &&
                group?.targets
                  .filter((target) => targetKey(target) === relationChunk)
                  .map((target) => {
                    const current = catalog.find(
                      (row) => targetKey(row) === targetKey(target),
                    );
                    const relations = current?.relations ?? [];
                    return (
                      <section key={targetKey(target)}>
                        <strong>
                          第 {target.position + 1} 片 · {target.title}
                        </strong>
                        <EvidenceTargetTags
                          targets={[target]}
                          number={(active ?? 0) + 1}
                        />
                        {!relations.length && (
                          <p className="rg-muted">此分片没有生效的图谱关系</p>
                        )}
                        <RelationEvidenceCards
                          relations={relations}
                          selected={
                            new Set(
                              group.relations?.map((row) => row.relation_id),
                            )
                          }
                          onToggle={(relation, checked) => {
                            if (active === null) return;
                            update(active, {
                              relations: checked
                                ? [...(group.relations ?? []), relation]
                                : (group.relations ?? []).filter(
                                    (row) =>
                                      row.relation_id !== relation.relation_id,
                                  ),
                            });
                          }}
                        />
                      </section>
                    );
                  })}
              {relationTab === "selected" &&
                (group?.relations ?? [])
                  .filter(
                    (relation) =>
                      !catalog.some(
                        (target) =>
                          group?.targets.some(
                            (row) => targetKey(row) === targetKey(target),
                          ) &&
                          target.relations?.some(
                            (row) => row.relation_id === relation.relation_id,
                          ),
                      ),
                  )
                  .map((relation) => (
                    <div key={relation.relation_id}>
                      <p>已选关系不在当前分片或生效图谱中，请重新选择。</p>
                      <RelationEvidenceCards relations={[relation]} />
                      <ConfirmPopover
                        message="移除这条失效的关系证据？保存题目后生效。"
                        confirmText="移除"
                        danger
                        onConfirm={() =>
                          active !== null &&
                          update(active, {
                            relations: group?.relations?.filter(
                              (row) => row.relation_id !== relation.relation_id,
                            ),
                          })
                        }
                      >
                        <button
                          type="button"
                          className="delete-button button-sm"
                        >
                          移除失效关系
                        </button>
                      </ConfirmPopover>
                    </div>
                  ))}
              <button
                type="button"
                className="primary-button"
                onClick={() => setActive(null)}
              >
                完成选择
              </button>
            </>
          )
        ) : (
          <>
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
                {[
                  ...new Set((catalog ?? []).map((target) => target.title)),
                ].map((name) => (
                  <option key={name}>{name}</option>
                ))}
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
              <p className="rg-muted">{error}</p>
            ) : !catalog ? (
              <LoadingSkeleton>
                <SkeletonBlock style={{ height: 100 }} />
              </LoadingSkeleton>
            ) : (
              <div className="sp-chunk-options" ref={options}>
                {!filtered.length && (
                  <p className="rg-muted">没有符合条件的分片</p>
                )}
                {visible.map((target) => (
                  <div className="sp-chunk-option" key={targetKey(target)}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen.has(targetKey(target))}
                        onChange={(event) => {
                          if (active === null || !group) return;
                          if (
                            !event.target.checked &&
                            group.relations?.some((relation) =>
                              catalog
                                ?.find(
                                  (row) => targetKey(row) === targetKey(target),
                                )
                                ?.relations?.some(
                                  (row) =>
                                    row.relation_id === relation.relation_id,
                                ),
                            )
                          ) {
                            toast(
                              "error",
                              "请先在关系证据分支移除该分片的已选关系，再取消分片",
                            );
                            return;
                          }
                          update(active, {
                            targets: event.target.checked
                              ? [...group.targets, target]
                              : group.targets.filter(
                                  (item) =>
                                    targetKey(item) !== targetKey(target),
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
              <span className="rg-muted">
                已选 {group?.targets.length ?? 0} 片
              </span>
              <button
                type="button"
                className="primary-button"
                onClick={() => setActive(null)}
              >
                完成选择
              </button>
            </div>
          </>
        )}
      </DetailDialog>
    </div>
  );
}
