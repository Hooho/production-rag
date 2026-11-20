import { Fragment, useEffect, useState } from "react";
import Table from "./Table";
import { paramsSummary } from "./EvalParamsPanel";
import "./EvalConfigTemplates.css";
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
  onCreate,
}: {
  onUse: (item: EvalConfigTemplate) => void;
  onCreate: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<EvalConfigTemplate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) =>
    setExpanded((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  const [busy, setBusy] = useState<string | null>(null);
  async function refresh() {
    setItems((await listEvalConfigTemplates()).items);
  }
  useEffect(() => {
    void refresh().catch((reason) => {
      setLoadFailed(true);
      toast("error", errorText(reason));
    });
  }, [toast]);
  return (
    <section className="eval-template-page">
      <div className="eval-template-heading">
        <div>
          <h2>评测配置模板</h2>
          <p>保存常用配置，在发起评测时加载使用。</p>
        </div>
      </div>
      <div className="eval-template-content">
        {loadFailed && items === null ? (
          <div className="eval-template-empty">
            <strong>暂时无法读取配置模板</strong>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setLoadFailed(false);
                void refresh().catch((reason) => {
                  setLoadFailed(true);
                  toast("error", errorText(reason));
                });
              }}
            >
              重试
            </button>
          </div>
        ) : items === null ? (
          <LoadingSkeleton label="正在读取配置模板">
            <SkeletonBlock className="skeleton-line-short" />
            <SkeletonBlock className="skeleton-line" />
            <SkeletonBlock className="skeleton-line" />
            <SkeletonBlock className="skeleton-line" />
          </LoadingSkeleton>
        ) : items.length === 0 ? (
          <div className="eval-template-empty">
            <svg
              width="40"
              height="40"
              viewBox="0 0 40 40"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="9"
                y="5"
                width="22"
                height="30"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M15 13h10M15 19h10M15 25h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <strong>还没有配置模板</strong>
            <p>将常用评测配置保存为模板，下次直接选择使用。</p>
            <button type="button" className="primary-button" onClick={onCreate}>
              创建配置模板
            </button>
          </div>
        ) : (
          <Table size="compact" className="eval-template-table">
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
                <Fragment key={item.id}>
                  <tr
                    className="eval-template-summary"
                    tabIndex={0}
                    aria-expanded={expanded.includes(item.id)}
                    aria-controls={`template-detail-${item.id}`}
                    onClick={() => toggle(item.id)}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        toggle(item.id);
                      }
                    }}
                  >
                    <td>
                      <span className="eval-template-caret" aria-hidden="true">
                        {expanded.includes(item.id) ? "▾" : "▸"}
                      </span>
                      {item.name}
                      {item.issues?.map((issue) => (
                        <small key={issue} className="ev-muted-note">
                          {" "}
                          · {issue}
                        </small>
                      ))}
                    </td>
                    <td>
                      {item.config.kind === "generation"
                        ? "生成评测"
                        : "检索评测"}
                    </td>
                    <td>
                      {item.config.mode === "agent" ? "Agent" : "固定流程"}
                    </td>
                    <td>
                      {item.config.methods
                        .map(
                          (method) =>
                            ({
                              dense: "向量",
                              keyword: "关键词",
                              graph: "图检索",
                            })[method],
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
                    <td onClick={(event) => event.stopPropagation()}>
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
                  {expanded.includes(item.id) && (
                    <tr id={`template-detail-${item.id}`}>
                      <td colSpan={7} className="eval-template-detail-cell">
                        <div className="eval-template-details">
                          <section>
                            <h3>题目与语料</h3>
                            <dl>
                              <dt>题目来源</dt>
                              <dd>
                                {item.suite_names?.length
                                  ? item.suite_names.join("、")
                                  : {
                                      dev: "开发集",
                                      holdout: "留出集",
                                      all: "全部已审核题目",
                                    }[item.config.split ?? "dev"]}
                              </dd>
                              <dt>评测语料</dt>
                              <dd>
                                {item.corpus_names?.join("、") || "未选择语料"}
                              </dd>
                            </dl>
                          </section>
                          <section>
                            <h3>模型与提示词</h3>
                            <dl>
                              <dt>大模型</dt>
                              <dd>
                                {item.config.params.llm
                                  ? `${item.config.params.llm.provider} · ${item.config.params.llm.model ?? "默认模型"}`
                                  : "跟随系统"}
                              </dd>
                              <dt>评审模型</dt>
                              <dd>
                                {item.config.params.judge
                                  ? `${item.config.params.judge.provider} · ${item.config.params.judge.model ?? "默认模型"}`
                                  : "跟随回答模型"}
                              </dd>
                            </dl>
                            {paramsSummary({
                              prompts: item.config.params.prompts,
                            }).map((text) => (
                              <p key={text}>{text}</p>
                            ))}
                            {!Object.keys(item.config.params.prompts ?? {})
                              .length && <p>提示词版本跟随系统</p>}
                          </section>
                          <section>
                            <h3>运行参数</h3>
                            {paramsSummary({
                              settings: item.config.params.settings,
                            }).length ? (
                              paramsSummary({
                                settings: item.config.params.settings,
                              }).map((text) => <p key={text}>{text}</p>)
                            ) : (
                              <p>全部跟随系统</p>
                            )}
                            <small>
                              未单独设置的参数跟随系统，实际值在评测启动时固定。
                            </small>
                          </section>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </section>
  );
}
