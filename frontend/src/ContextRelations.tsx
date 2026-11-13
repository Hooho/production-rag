import { useState, type CSSProperties } from "react";
import type { ContextRelation } from "./api";
import { ChunkOriginalPanel } from "./ChunkOriginalPanel";
import type { HighlightGroup } from "./HighlightedText";
import Table from "./Table";
import { Tag } from "./Tag";
import { labelHue } from "./hues";
import "./GraphRetrieval.css";

// 放进回答上下文的图谱关系（G 编号）：回答步骤、组装上下文步骤、检索诊断三处共用。
// 「原文」打开出处分片（伴随浮窗），高亮这条关系的原文引用和起点、终点的名字。

function relationGroups(relation: ContextRelation): HighlightGroup[] {
  return [
    {
      kind: "evidence",
      texts: (relation.evidence ?? "").split("||").filter(Boolean),
    },
    { kind: "entity", texts: [relation.source, relation.target] },
  ];
}

function score(value: number | null | undefined) {
  return typeof value === "number" ? value.toFixed(2) : "—";
}

// 起点 → 分类 → 终点，下面是描述和原文引用，和图检索明细里的写法一致。
function RelationLine({ relation }: { relation: ContextRelation }) {
  return (
    <span className="grt-rel">
      <span className="grt-rel-line">
        <b>{relation.source}</b>
        <span className="grt-arrow">→</span>
        <small
          className="grt-category is-hue"
          style={{ "--tag-h": labelHue(relation.category) } as CSSProperties}
        >
          {relation.category}
        </small>
        <span className="grt-arrow">→</span>
        <b>{relation.target}</b>
      </span>
      {relation.description && (
        <small className="grt-rel-desc">{relation.description}</small>
      )}
      {relation.evidence && (
        <small className="grt-evidence" title="原文引用">
          {relation.evidence
            .split("||")
            .filter(Boolean)
            .map((quote) => `「${quote}」`)
            .join("")}
        </small>
      )}
    </span>
  );
}

function useOriginal() {
  const [open, setOpen] = useState<ContextRelation | null>(null);
  const button = (relation: ContextRelation) =>
    relation.chunk_id ? (
      <button
        type="button"
        className="link-button button-sm"
        onClick={() => setOpen(relation)}
      >
        原文
      </button>
    ) : null;
  const panel = open?.chunk_id ? (
    <ChunkOriginalPanel
      chunkId={open.chunk_id}
      groups={relationGroups(open)}
      onClose={() => setOpen(null)}
    />
  ) : null;
  return { button, panel };
}

// 回答模型收到的图谱关系：每条写编号、交给模型的内容、重排分数，回答里引用了的标「已引用」。
export function ContextRelationList({
  relations,
  cited = [],
}: {
  relations: ContextRelation[];
  cited?: string[];
}) {
  const { button, panel } = useOriginal();
  return (
    <div className="answer-source-list">
      {relations.map((relation) => (
        <article
          className="answer-source"
          key={relation.id ?? relation.relation_id}
        >
          <div className="answer-source-head">
            <b>{relation.id}</b>
            <strong>
              {relation.title ?? "图谱关系"}
              {typeof relation.version === "number" && (
                <small className="source-location">
                  {" "}
                  · v{relation.version}
                </small>
              )}
            </strong>
            <span>
              {relation.id && cited.includes(relation.id) && (
                <Tag tone="success" size="sm">
                  已引用
                </Tag>
              )}{" "}
              重排 {score(relation.rerank_score)}
              {typeof relation.tokens === "number"
                ? ` · ${relation.tokens} token`
                : ""}
            </span>
          </div>
          <RelationLine relation={relation} />
          <div>{button(relation)}</div>
        </article>
      ))}
      {panel}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  beyond_budget: "额度不够没放",
  off: "没放",
};

// 检索诊断：图检索留下的关系和去向，按关系重排名次排列，可以按去向筛选。
export function ContextRelationTable({
  items,
  reason,
}: {
  items: ContextRelation[];
  reason: string | null;
}) {
  const { button, panel } = useOriginal();
  const [filter, setFilter] = useState<"all" | "context" | "other">("all");
  const rows = items.filter((item) =>
    filter === "all"
      ? true
      : filter === "context"
        ? item.status === "context"
        : item.status !== "context",
  );
  const placed = items.filter((item) => item.status === "context").length;
  return (
    <div className="diag context-relation-detail">
      <p className="result-help">
        {reason
          ? `没有放图谱关系：${reason}`
          : `放入上下文 ${placed} 条，额度不够没放 ${items.length - placed} 条；按关系重排名次排列，关系先占图保底额度。`}
      </p>
      <label className="context-relation-filter">
        去向{" "}
        <select
          value={filter}
          onChange={(event) =>
            setFilter(event.target.value as "all" | "context" | "other")
          }
        >
          <option value="all">全部（{items.length}）</option>
          <option value="context">放入上下文（{placed}）</option>
          <option value="other">没放（{items.length - placed}）</option>
        </select>
      </label>
      <Table
        containerProps={{ className: "diag-table-wrap" }}
        stickyHeader
        columnCount={5}
        size="compact"
        empty={rows.length === 0}
        emptyContent="没有关系"
      >
        <thead>
          <tr>
            <th>重排</th>
            <th>关系</th>
            <th>去向</th>
            <th>token</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.relation_id}>
              <td>
                {score(item.rerank_score)}
                {typeof item.rerank_rank === "number" && (
                  <small className="result-help"> 第 {item.rerank_rank}</small>
                )}
              </td>
              <td>
                <RelationLine relation={item} />
              </td>
              <td>
                {item.status === "context" ? (
                  <Tag tone="success" size="sm">
                    放入上下文 {item.context_id}
                  </Tag>
                ) : (
                  <Tag tone="neutral" size="sm">
                    {STATUS_LABELS[item.status ?? "off"] ?? "没放"}
                  </Tag>
                )}
              </td>
              <td>{item.tokens ?? "—"}</td>
              <td>{button(item)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {panel}
    </div>
  );
}
