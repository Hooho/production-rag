import { useEffect, useState } from "react";
import {
  getGraphOverview,
  getGraphTasks,
  type GraphOverview,
  type GraphTask,
} from "./api";
import { BUILD_STATUS, TRIGGER_LABELS } from "./DocumentGraph";
import { formatShortTime } from "./format";
import { GraphBuildDialog } from "./GraphBuildDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";
import { GraphView } from "./GraphView";
import { Tag } from "./Tag";

type ShowToast = (kind: "success" | "error", message: string) => void;
export type KnowledgeGraphTab = "overview" | "tasks";

// 全局「知识图谱」（只有管理员能看）：所有文档当前版本的图合在一起看，以及每份文档的建图状态。
// 第 1 期只能查看和建图；跨文档合并、拆分、别名表等维护功能在第 3 期。
export default function KnowledgeGraph({
  tab,
  onNavigate,
  onToast,
}: {
  tab: KnowledgeGraphTab;
  onNavigate: (path: string) => void;
  onToast: ShowToast;
}) {
  return (
    <div className="knowledge-graph-page">
      <header className="topbar">
        <div>
          <h1>知识图谱</h1>
          <p className="graph-note">
            所有文档当前版本的实体和关系合在一起：同一个实体在所有文档里共用一个点。只影响这里和文档的「实体关系」页签，不影响问答和评测。
          </p>
        </div>
      </header>
      <div
        className="document-detail-tabs"
        role="tablist"
        aria-label="知识图谱"
      >
        <button
          className={tab === "overview" ? "active" : ""}
          onClick={() => onNavigate("/graph")}
        >
          总图
        </button>
        <button
          className={tab === "tasks" ? "active" : ""}
          onClick={() => onNavigate("/graph/tasks")}
        >
          建图任务
        </button>
      </div>
      {tab === "overview" ? (
        <Overview onNavigate={onNavigate} />
      ) : (
        <Tasks onNavigate={onNavigate} onToast={onToast} />
      )}
    </div>
  );
}

function Overview({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<GraphOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    getGraphOverview({
      document_id: documentId,
      type: entityType,
      category,
      q: search,
      focus,
      limit,
    })
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError("");
        }
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [documentId, entityType, category, search, focus, limit]);
  if (error) return <div className="document-panel-empty">{error}</div>;
  if (!data) return <div className="document-panel-empty">正在读取图谱…</div>;
  if (data.documents.length === 0)
    return (
      <div className="document-panel-empty">
        还没有文档建过图。可以在「建图任务」里选文档建图，或者在文档详情的「实体关系」页签里建图。
      </div>
    );
  return (
    <div className="graph-panel">
      <div className="graph-filters">
        <select
          value={documentId ?? ""}
          onChange={(event) => setDocumentId(event.target.value || null)}
        >
          <option value="">全部 {data.documents.length} 份文档</option>
          {data.documents.map((item) => (
            <option key={item.document_id} value={item.document_id}>
              {item.title}
            </option>
          ))}
        </select>
        <select
          value={entityType ?? ""}
          onChange={(event) => setEntityType(event.target.value || null)}
        >
          <option value="">全部类型</option>
          {Object.entries(data.type_counts).map(([type, count]) => (
            <option key={type} value={type}>
              {type}（{count}）
            </option>
          ))}
        </select>
        <select
          value={category ?? ""}
          onChange={(event) => setCategory(event.target.value || null)}
        >
          <option value="">全部关系</option>
          {Object.entries(data.category_counts).map(([item, count]) => (
            <option key={item} value={item}>
              {item}（{count}）
            </option>
          ))}
        </select>
        <select
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
        >
          {[50, 100, 200].map((value) => (
            <option key={value} value={value}>
              最多显示 {value} 个
            </option>
          ))}
        </select>
        <input
          value={query}
          placeholder="搜索实体，例如 段永平"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) =>
            event.key === "Enter" && setSearch(query.trim())
          }
          onBlur={() => setSearch(query.trim())}
        />
        {focus.length > 0 && (
          <button className="link-button" onClick={() => setFocus([])}>
            收起展开的 {focus.length} 个实体
          </button>
        )}
      </div>
      {search && (
        <p className="graph-note">
          {data.matches.length > 0
            ? "搜到："
            : `没有名字包含「${search}」的实体`}
          {data.matches.map((item) => (
            <button
              key={item.id}
              className="link-button"
              onClick={() => setSelected(item.id)}
            >
              {item.name}（{item.type}）
            </button>
          ))}
        </p>
      )}
      <div className={selected ? "graph-body" : ""}>
        <div>
          <GraphView
            nodes={data.network.nodes}
            edges={data.network.edges}
            selected={selected}
            onSelect={setSelected}
            onExpand={(id) =>
              setFocus((items) => (items.includes(id) ? items : [...items, id]))
            }
          />
          <p className="graph-note">
            显示 {data.network.nodes.length} / {data.network.total_entities}{" "}
            个实体、{data.network.edges.length} 条边（
            {data.network.total_relations} 条关系）。
          </p>
        </div>
        {selected && (
          <GraphEntityPanel
            entityId={selected}
            onClose={() => setSelected(null)}
            onOpenDocument={(id) => onNavigate(`/knowledge/${id}`)}
            onOpenChunk={(_chunkId, _position, id) =>
              onNavigate(`/knowledge/${id}`)
            }
            onFocus={(id) =>
              setFocus((items) => (items.includes(id) ? items : [...items, id]))
            }
          />
        )}
      </div>
    </div>
  );
}

function Tasks({
  onNavigate,
  onToast,
}: {
  onNavigate: (path: string) => void;
  onToast: ShowToast;
}) {
  const [items, setItems] = useState<GraphTask[] | null>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ ids: string[]; title: string } | null>(
    null,
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getGraphTasks()
      .then((value) => !cancelled && setItems(value.items))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [tick]);
  const busy = items?.some(
    (item) => item.state === "queued" || item.state === "running",
  );
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [busy]);
  if (error) return <div className="document-panel-empty">{error}</div>;
  if (!items)
    return <div className="document-panel-empty">正在读取建图任务…</div>;
  const buildable = items.filter(
    (item) =>
      item.processed && item.state !== "queued" && item.state !== "running",
  );
  const notBuilt = buildable.filter(
    (item) => item.state === "none" || item.state === "outdated",
  );
  return (
    <div className="graph-panel">
      <div className="graph-tasks-actions">
        <span className="graph-note">
          共 {items.length} 份文档：已建{" "}
          {
            items.filter((item) =>
              ["completed", "partial"].includes(item.state),
            ).length
          }
          ，未建 {items.filter((item) => item.state === "none").length}，已过期{" "}
          {items.filter((item) => item.state === "outdated").length}
        </span>
        <div className="graph-actions">
          <button
            className="secondary-button"
            disabled={notBuilt.length === 0}
            onClick={() =>
              setChecked(new Set(notBuilt.map((item) => item.document_id)))
            }
          >
            选中未建和已过期的（{notBuilt.length}）
          </button>
          <button
            className="primary-button"
            disabled={checked.size === 0}
            onClick={() =>
              setDialog({
                ids: [...checked],
                title: `批量建图：${checked.size} 份文档`,
              })
            }
          >
            批量建图（{checked.size}）
          </button>
        </div>
      </div>
      <table className="graph-table">
        <thead>
          <tr>
            <th />
            <th>文档</th>
            <th>状态</th>
            <th>清单 · 模型</th>
            <th>分片</th>
            <th>实体 / 关系</th>
            <th>时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const status = BUILD_STATUS[item.state] ?? BUILD_STATUS.none;
            const build = item.build;
            const canBuild = buildable.includes(item);
            const processed = build
              ? build.extracted + build.reused + build.failed
              : 0;
            return (
              <tr key={item.doc_key}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!canBuild}
                    checked={checked.has(item.document_id)}
                    onChange={(event) =>
                      setChecked((value) => {
                        const next = new Set(value);
                        if (event.target.checked) next.add(item.document_id);
                        else next.delete(item.document_id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    className="link-button"
                    onClick={() => onNavigate(`/knowledge/${item.document_id}`)}
                  >
                    {item.title}
                  </button>
                  <small>
                    v{item.version} · {item.owner}
                    {item.listed ? "" : " · 已下架"}
                    {item.auto ? " · 上传时开启了图检索" : ""}
                    {item.processed ? "" : " · 还没处理完"}
                  </small>
                </td>
                <td>
                  <Tag size="sm" tone={status.tone} dot>
                    {status.label}
                  </Tag>
                  {item.state === "outdated" && (
                    <small>最近的图是给旧版本建的</small>
                  )}
                </td>
                <td>
                  {build ? (
                    <>
                      {build.schema_name} · {build.model}
                      <small>
                        {TRIGGER_LABELS[build.trigger] ?? build.trigger}
                      </small>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {build
                    ? item.state === "running" || item.state === "queued"
                      ? `${processed} / ${build.total}`
                      : `${build.total} 片，失败 ${build.failed}`
                    : "—"}
                </td>
                <td>
                  {build && build.active
                    ? `${build.entity_count} / ${build.relation_count}`
                    : "—"}
                </td>
                <td>
                  {build
                    ? formatShortTime(build.finished ?? build.created)
                    : "—"}
                </td>
                <td>
                  {canBuild && (
                    <button
                      className="secondary-button"
                      onClick={() =>
                        setDialog({
                          ids: [item.document_id],
                          title: `《${item.title}》v${item.version}`,
                        })
                      }
                    >
                      {item.state === "none" ? "建图" : "重建"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dialog && (
        <GraphBuildDialog
          documentIds={dialog.ids}
          title={dialog.title}
          onClose={() => setDialog(null)}
          onStarted={() => {
            setDialog(null);
            setChecked(new Set());
            setTick((value) => value + 1);
          }}
          onToast={onToast}
        />
      )}
    </div>
  );
}
