import { useEffect, useState } from "react";
import { getChunkOriginal, type ChunkOriginal } from "./api";
import { DetailDialog } from "./DetailDialog";
import { HighlightedText } from "./HighlightedText";

// 分片原文：检索诊断的排名表里点「更多」时看这一片的正文。
// 弹窗里再打开的内容就是伴随浮窗（DetailDialog 会自己贴到「更多」左边），不再叠一层抽屉。
// 来源列已经取过的原文直接传进来，不用再读一次；没取到才自己读。
// 标题固定：标题一变，浮窗会重新定位，闪一下。
export function ChunkOriginalPanel({
  chunkId,
  chunk,
  onClose,
}: {
  chunkId: string;
  chunk?: ChunkOriginal;
  onClose: () => void;
}) {
  const [state, setState] = useState<{
    id: string;
    data?: ChunkOriginal;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (chunk) return;
    let cancelled = false;
    getChunkOriginal(chunkId)
      .then((data) => {
        if (!cancelled) setState({ id: chunkId, data });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            id: chunkId,
            error:
              error instanceof Error
                ? error.message
                : "读取原文失败，请关闭后重试",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [chunkId, chunk]);
  const current = state?.id === chunkId ? state : null;
  const data = chunk ?? current?.data;
  return (
    <DetailDialog open title="分片原文" onClose={onClose}>
      {data ? (
        <>
          <p>
            <strong>{data.title}</strong>
            {data.heading && (
              <small className="ag-muted"> · {data.heading}</small>
            )}
          </p>
          <HighlightedText text={data.content} className="ag-delivery-text" />
        </>
      ) : (
        <p role="status" className="ag-muted">
          {current?.error ?? "正在读取原文…"}
        </p>
      )}
    </DetailDialog>
  );
}
