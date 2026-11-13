import { useEffect, useState } from "react";
import Table from "./Table";
import {
  listEvalDocumentCandidates,
  saveEvalDocumentReferences,
  listEvalCorpus,
  deleteEvalCorpus,
  type EvalDocumentReference,
} from "./api";
import { DetailDialog } from "./DetailDialog";
import { ConfirmPopover } from "./ConfirmPopover";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { errorText } from "./Toast";
import { Tag } from "./Tag";
import "./Corpus.css";

type ShowToast = (kind: "success" | "error", message: string) => void;
export default function Corpus({ onToast }: { onToast: ShowToast }) {
  const [items, setItems] = useState<EvalDocumentReference[] | null>(null);
  const [candidates, setCandidates] = useState<EvalDocumentReference[] | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  async function refresh() {
    const data = await listEvalCorpus();
    setItems(data.items as EvalDocumentReference[]);
  }
  useEffect(() => {
    void refresh().catch((reason) => onToast("error", errorText(reason)));
  }, []);
  async function choose() {
    setSelected((items ?? []).map((item) => item.id));
    setCandidates(null);
    setOpen(true);
    try {
      setCandidates((await listEvalDocumentCandidates()).items);
    } catch (reason) {
      onToast("error", errorText(reason));
    }
  }
  async function save() {
    setWorking("save");
    try {
      await saveEvalDocumentReferences(selected);
      await refresh();
      setOpen(false);
      onToast("success", "评测语料已保存");
    } catch (reason) {
      onToast("error", errorText(reason));
    } finally {
      setWorking(null);
    }
  }
  return (
    <div className="cp-root">
      <div className="cp-toolbar">
        <div>
          <h2>评测语料</h2>
          <p>选择常用知识库文档，发起评测时勾选使用。</p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => void choose()}
        >
          选择文档
        </button>
      </div>
      {items === null ? (
        <LoadingSkeleton label="正在加载评测语料">
          <SkeletonBlock className="skeleton-line" />
        </LoadingSkeleton>
      ) : !items.length ? (
        <p>尚未选择评测文档。</p>
      ) : (
        <div className="cp-table-panel">
          <div className="cp-table-caption">
            文档列表 <span>{items.length} 份文档</span>
          </div>
          <Table className="cp-table" size="compact">
            <thead>
              <tr>
                <th>文档名称</th>
                <th>所有者</th>
                <th>版本</th>
                <th>分片</th>
                <th>图谱状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="cp-document-title" title={item.title}>
                      {item.title}
                    </span>
                  </td>
                  <td>{item.owner || "—"}</td>
                  <td>{item.version ? `v${item.version}` : "—"}</td>
                  <td className="cp-number">{item.chunks ?? "—"}</td>
                  <td>
                    <Tag
                      size="sm"
                      tone={
                        item.missing
                          ? "danger"
                          : item.graph_ready
                            ? "success"
                            : "warning"
                      }
                    >
                      {item.missing
                        ? "文档不可用"
                        : item.graph_ready
                          ? "图谱可用"
                          : "未建图"}
                    </Tag>
                  </td>
                  <td>
                    <ConfirmPopover
                      danger
                      message="从评测语料中移除此文档？知识库原文档和图谱保留，可重新加入。"
                      confirmText="移除引用"
                      onConfirm={async () => {
                        setWorking(item.id);
                        try {
                          await deleteEvalCorpus(item.id);
                          await refresh();
                          onToast("success", "已移除文档引用");
                        } catch (reason) {
                          onToast("error", errorText(reason));
                        } finally {
                          setWorking(null);
                        }
                      }}
                    >
                      <button
                        type="button"
                        className={`link-button button-sm cp-remove${working === item.id ? " is-loading" : ""}`}
                        disabled={working !== null}
                      >
                        移除
                      </button>
                    </ConfirmPopover>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <DetailDialog
        open={open}
        onClose={() => setOpen(false)}
        title="选择评测文档"
      >
        {candidates === null ? (
          <LoadingSkeleton label="正在加载知识库文档">
            <SkeletonBlock className="skeleton-line" />
          </LoadingSkeleton>
        ) : (
          <div>
            {candidates.map((item) => (
              <label key={item.id} className="cp-reference-option">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={item.missing || working !== null}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  {item.title}
                  <small>
                    {item.owner} · 版本 {item.version} ·{" "}
                    {item.missing
                      ? "处理中或不可用"
                      : item.graph_ready
                        ? "图谱可用"
                        : "未建图"}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="cp-head">
          <button
            type="button"
            className="secondary-button"
            disabled={working !== null}
            onClick={() => setOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            className={`primary-button${working === "save" ? " is-loading" : ""}`}
            disabled={working !== null || candidates === null}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </DetailDialog>
    </div>
  );
}
