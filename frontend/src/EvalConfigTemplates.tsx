import { useEffect, useState } from "react";
import Table from "./Table";
import { ConfirmPopover } from "./ConfirmPopover";
import {
  listEvalConfigTemplates,
  saveEvalConfigTemplate,
  deleteEvalConfigTemplate,
  type EvalConfigTemplate,
} from "./api";
import { useToast, errorText } from "./Toast";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
export default function EvalConfigTemplates({
  onUse,
}: {
  onUse: (item: EvalConfigTemplate) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<EvalConfigTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function refresh() {
    setItems((await listEvalConfigTemplates()).items);
  }
  useEffect(() => {
    void refresh().catch((reason) => toast("error", errorText(reason)));
  }, [toast]);
  return (
    <section>
      <div className="cp-toolbar">
        <div>
          <h2>评测配置模板</h2>
          <p>保存常用配置，在发起评测时加载使用。</p>
        </div>
      </div>
      {items === null ? (
        <LoadingSkeleton label="正在读取配置模板">
          <SkeletonBlock />
        </LoadingSkeleton>
      ) : (
        <Table size="compact">
          <thead>
            <tr>
              <th>名称</th>
              <th>评测类型</th>
              <th>模式</th>
              <th>检索方式</th>
              <th>题集 / 语料</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  {item.issues?.map((issue) => (
                    <small key={issue} className="ev-muted-note">
                      {" "}
                      · {issue}
                    </small>
                  ))}
                </td>
                <td>
                  {item.config.kind === "generation" ? "生成评测" : "检索评测"}
                </td>
                <td>{item.config.mode === "agent" ? "Agent" : "固定流程"}</td>
                <td>
                  {item.config.methods
                    .map(
                      (method) =>
                        ({ dense: "向量", keyword: "关键词", graph: "图检索" })[
                          method
                        ],
                    )
                    .join("、")}
                </td>
                <td>
                  {item.config.suite_ids?.length
                    ? (item.suite_names?.join("、") ??
                      `${item.config.suite_ids.length} 个题集`)
                    : {
                        dev: "开发集",
                        holdout: "留出集",
                        all: "全部已审核题目",
                      }[item.config.split ?? "dev"]}{" "}
                  ·{" "}
                  {item.corpus_names?.join("、") ||
                    `${item.config.corpus_ids.length} 份语料`}
                </td>
                <td>{new Date(item.updated).toLocaleString()}</td>
                <td>
                  <div className="unified-eval-options">
                    <button
                      className="link-button button-sm"
                      disabled={busy !== null}
                      onClick={() => onUse(item)}
                    >
                      使用
                    </button>
                    <button
                      className="link-button button-sm"
                      disabled={busy !== null}
                      onClick={() => onUse(item)}
                    >
                      编辑
                    </button>
                    <button
                      className={`link-button button-sm${busy === `copy-${item.id}` ? " is-loading" : ""}`}
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy(`copy-${item.id}`);
                        try {
                          await saveEvalConfigTemplate(
                            `${item.name.slice(0, 36)} 副本`,
                            item.config,
                          );
                          await refresh();
                          toast("success", "配置模板已复制");
                        } catch (reason) {
                          toast("error", errorText(reason));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      复制
                    </button>
                    <ConfirmPopover
                      danger
                      message="删除此配置模板？不可恢复，历史报告和本次运行配置保留。"
                      confirmText="删除模板"
                      onConfirm={async () => {
                        setBusy(item.id);
                        try {
                          await deleteEvalConfigTemplate(item.id);
                          await refresh();
                          toast("success", "配置模板已删除");
                        } catch (reason) {
                          toast("error", errorText(reason));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      <button
                        className={`link-button button-sm cp-remove${busy === item.id ? " is-loading" : ""}`}
                        disabled={busy !== null}
                      >
                        删除
                      </button>
                    </ConfirmPopover>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {items?.length === 0 && <p>尚未保存配置模板。</p>}
    </section>
  );
}
