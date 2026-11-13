import { useEffect, useState } from "react";
import {
  getGraphRelations,
  type GraphEdge,
  type GraphRelationDetail,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { ChunkOriginalText } from "./ChunkOriginalText";
import { Tag } from "./Tag";

export function GraphRelationPanel({
  edge,
  documentId,
  version,
  category,
  onClose,
  onOpenChunk,
}: {
  edge: GraphEdge;
  documentId?: string | null;
  // 文档页签正在查看的图谱版本（不传就是生效版本）。
  version?: string | null;
  category?: string | null;
  onClose: () => void;
  onOpenChunk?: (chunkId: string, position: number, documentId: string) => void;
}) {
  const [items, setItems] = useState<GraphRelationDetail[] | null>(null);
  const [original, setOriginal] = useState<GraphRelationDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setOriginal(null);
    setError("");
    getGraphRelations(edge.source, edge.target, documentId, category, version)
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [edge.source, edge.target, documentId, category, version]);
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
          {items.map((row, index) => (
            <li key={row.id}>
              <h4>
                <span className="graph-item-number">{index + 1}.</span>{" "}
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
              <button
                type="button"
                className="secondary-button graph-original-button"
                title="打开可移动弹窗，查看原文并高亮证据"
                disabled={!row.chunk_content}
                onClick={() => setOriginal(row)}
              >
                原文
              </button>
              {!row.chunk_content && <small>出处分片原文暂不可用。</small>}
            </li>
          ))}
        </ul>
      )}
      {original && (
        <DetailDialog
          open
          movable
          title={`原文 · ${original.document_title ?? "文档"} · 第 ${original.position + 1} 片`}
          onClose={() => setOriginal(null)}
        >
          <ChunkOriginalText
            text={original.chunk_content}
            groups={[
              {
                kind: "entity",
                texts: [original.source_name, original.target_name],
              },
              { kind: "evidence", texts: [original.evidence] },
            ]}
          />
        </DetailDialog>
      )}
    </aside>
  );
}
