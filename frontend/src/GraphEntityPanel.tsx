import { useEffect, useState, type CSSProperties } from "react";
import { labelHue } from "./hues";
import {
  getGraphEntity,
  type GraphEntityDetail,
  type GraphRelationRow,
} from "./api";
import { Tag } from "./Tag";
import { typeColor } from "./GraphView";

// 实体详情：标准名、类型；由哪些名字合并而来（各自出自第几片、用什么方法合并）；出现在哪些文档；全部关系和出处。
// documentId 给了只看这份文档里的，不给看全局（管理员）。
export function GraphEntityPanel({
  entityId,
  documentId,
  onClose,
  onOpenChunk,
  onFocus,
  onOpenDocument,
}: {
  onOpenDocument?: (documentId: string) => void;
  entityId: string;
  documentId?: string | null;
  onClose: () => void;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
  onFocus?: (entityId: string) => void;
}) {
  const [detail, setDetail] = useState<GraphEntityDetail | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError("");
    setCategory(null);
    getGraphEntity(entityId, documentId)
      .then((value) => !cancelled && setDetail(value))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [entityId, documentId]);
  if (error)
    return (
      <aside className="graph-side">
        <p className="field-error">{error}</p>
      </aside>
    );
  if (!detail)
    return (
      <aside className="graph-side">
        <p className="graph-note">正在读取实体详情…</p>
      </aside>
    );
  const color = typeColor(detail.entity.type);
  const categoryCounts = new Map<string, number>();
  for (const row of detail.relations) {
    categoryCounts.set(
      row.category,
      (categoryCounts.get(row.category) ?? 0) + 1,
    );
  }
  const relations =
    category === null
      ? detail.relations
      : detail.relations.filter((row) => row.category === category);
  return (
    <aside className="graph-side">
      <div className="graph-side-heading">
        <h3>
          {detail.entity.name}{" "}
          <span
            className="tag is-sm"
            style={{
              background: color.fill,
              color: color.text,
              borderColor: color.stroke,
            }}
          >
            {detail.entity.type}
          </span>
        </h3>
        <button type="button" className="link-button" onClick={onClose}>
          关闭
        </button>
      </div>
      {detail.entity.description && (
        <p className="graph-note">{detail.entity.description}</p>
      )}
      {onFocus && (
        <button
          type="button"
          className="link-button"
          onClick={() => onFocus(detail.entity.id)}
        >
          在图里展开关系（每次最多 15 个邻居）
        </button>
      )}
      <h4>由这些名字合并而来（{detail.names.length}）</h4>
      <ul>
        {detail.names.map((item) => (
          <li key={`${item.name}-${item.method}`}>
            <strong>{item.name}</strong>{" "}
            <Tag
              size="sm"
              plain
              tone={item.method === "new" ? "neutral" : "info"}
            >
              {item.method_label}
            </Tag>
            <small>
              出现 {item.count} 次：
              {item.positions.slice(0, 8).map((position, index) => (
                <button
                  key={`${item.chunk_ids[index]}-${index}`}
                  type="button"
                  className="link-button"
                  disabled={!onOpenChunk || !documentId}
                  onClick={() =>
                    documentId &&
                    onOpenChunk?.(item.chunk_ids[index], position, documentId)
                  }
                >
                  第 {position + 1} 片
                </button>
              ))}
              {item.positions.length > 8 ? " …" : ""}
            </small>
            {item.descriptions.length > 0 && (
              <small>{item.descriptions.join("；")}</small>
            )}
          </li>
        ))}
      </ul>
      {!documentId && (
        <>
          <h4>出现在 {detail.documents.length} 份文档</h4>
          <ul>
            {detail.documents.map((item) => (
              <li key={item.document_id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenDocument?.(item.document_id)}
                >
                  {item.title ?? item.document_id}
                </button>
                <small>
                  名字出现 {item.mention_count} 次 · 关系 {item.relation_count}{" "}
                  条
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      <section className="graph-entity-relations" aria-label="实体关系">
        <div className="graph-relations-header">
          <h4>
            关系（{relations.length} / {detail.relations.length}）
          </h4>
          <div
            className="graph-relation-categories"
            role="group"
            aria-label="筛选关系分类"
          >
            <button
              type="button"
              aria-pressed={category === null}
              onClick={() => setCategory(null)}
            >
              全部 {detail.relations.length}
            </button>
            {[...categoryCounts].map(([name, count]) => (
              <button
                type="button"
                key={name}
                className="tag is-hue"
                style={{ "--tag-h": labelHue(name) } as CSSProperties}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name} {count}
              </button>
            ))}
          </div>
        </div>
        <ul>
          {relations.map((row) => (
            <RelationItem
              key={row.id}
              row={row}
              entityId={detail.entity.id}
              onOpenChunk={onOpenChunk}
              showDocument={!documentId}
            />
          ))}
        </ul>
      </section>
    </aside>
  );
}

function RelationItem({
  row,
  entityId,
  onOpenChunk,
  showDocument,
}: {
  row: GraphRelationRow;
  entityId: string;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
  showDocument: boolean;
}) {
  const outgoing = row.source_id === entityId;
  return (
    <li>
      <span>
        {outgoing ? "→" : "←"}{" "}
        <strong>{outgoing ? row.target_entity : row.source_entity}</strong>{" "}
        <Tag size="sm" plain hue={true}>
          {row.category}
        </Tag>
      </span>
      {row.description && <small>{row.description}</small>}
      <small>
        原文写的是「{row.source_name}」→「{row.target_name}」 ·{" "}
        {showDocument && row.document_title ? `《${row.document_title}》` : ""}
        {onOpenChunk ? (
          <button
            type="button"
            className="link-button"
            onClick={() =>
              onOpenChunk(row.chunk_id, row.position, row.document_id)
            }
          >
            第 {row.position + 1} 片
          </button>
        ) : (
          `第 ${row.position + 1} 片`
        )}
      </small>
      {row.evidence && <small>出处：「{row.evidence}」</small>}
    </li>
  );
}
