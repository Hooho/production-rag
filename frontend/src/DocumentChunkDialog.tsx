import { useEffect, useState } from "react";
import {
  listDocumentChunks,
  retryDocumentGraph,
  type DocumentChunk,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { DocumentChunkCard } from "./DocumentChunkCard";

export type ChunkTarget = {
  documentId: string;
  chunkId: string;
  position: number;
};

export function DocumentChunkDialog({
  target,
  onClose,
}: {
  target: ChunkTarget;
  onClose: () => void;
}) {
  const [chunk, setChunk] = useState<DocumentChunk | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChunk(null);
    setError("");
    setNotice("");
    listDocumentChunks(
      target.documentId,
      Math.floor(target.position / 10) + 1,
      10,
    )
      .then((data) => {
        if (cancelled) return;
        const found = data.chunks.find(
          (item) => item.chunk_id === target.chunkId,
        );
        if (found) setChunk(found);
        else setError("未找到该分片，文档版本可能已更新。");
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [target.documentId, target.chunkId, target.position]);
  return (
    <DetailDialog
      open
      title={`第 ${target.position + 1} 片 · 分片详情`}
      onClose={onClose}
    >
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="graph-note" role="status">
          {notice}
        </p>
      )}
      {chunk ? (
        <DocumentChunkCard
          chunk={chunk}
          expanded
          onRetryGraph={
            retrying
              ? undefined
              : async (chunkId) => {
                  setRetrying(true);
                  setError("");
                  try {
                    await retryDocumentGraph(target.documentId, chunkId);
                    setNotice("已开始重试这一片，完成后重新打开即可查看结果。");
                  } catch (reason) {
                    setError((reason as Error).message);
                  } finally {
                    setRetrying(false);
                  }
                }
          }
        />
      ) : (
        !error && <p className="graph-note">正在读取分片…</p>
      )}
    </DetailDialog>
  );
}
