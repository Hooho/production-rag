import { useEffect, useState } from "react";
import {
  getGraphRelations,
  type GraphEdge,
  type GraphRelationDetail,
} from "./api";
import { Tag } from "./Tag";

export function GraphRelationPanel({
  edge,
  documentId,
  category,
  onClose,
  onOpenChunk,
}: {
  edge: GraphEdge;
  documentId?: string | null;
  category?: string | null;
  onClose: () => void;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
}) {
  const [items, setItems] = useState<GraphRelationDetail[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError("");
    getGraphRelations(edge.source, edge.target, documentId, category)
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [edge.source, edge.target, documentId, category]);
  return (
    <aside className="graph-side">
      <div className="graph-side-heading">
        <h3>关系详情{items ? `（${items.length}）` : ""}</h3>
        <button type="button" className="link-button" onClick={onClose}>
          关闭
        </button>
      </div>
      {error ? (
        <p className="field-error">{error}</p>
      ) : !items ? (
        <p className="graph-note">正在读取关系…</p>
      ) : items.length === 0 ? (
        <p className="graph-note">当前范围内没有可查看的关系。</p>
      ) : (
        <ul>
          {items.map((row) => (
            <li key={row.id}>
              <h4>
                {row.source_entity} → {row.target_entity}
              </h4>
              <Tag size="sm" plain hue>
                {row.category}
              </Tag>{" "}
              <Tag size="sm" plain>
                {row.origin === "manual" ? "手动" : "抽取"}
              </Tag>
              <p>{row.description}</p>
              <small>
                《{row.document_title ?? "文档"}》 ·{" "}
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
              {row.chunk_content ? (
                <p className="graph-evidence">
                  {highlightEvidence(row.chunk_content, row.evidence)}
                </p>
              ) : (
                <p className="graph-note">出处分片原文暂不可用。</p>
              )}
              {row.evidence && !row.chunk_content.includes(row.evidence) && (
                <small>抽取时记录的证据：{row.evidence}</small>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function highlightEvidence(text: string, evidence: string | null) {
  if (!evidence || !text.includes(evidence)) return text;
  const parts = text.split(evidence);
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 && <mark>{evidence}</mark>}
      {part}
    </span>
  ));
}
