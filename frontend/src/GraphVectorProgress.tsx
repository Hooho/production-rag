import type { GraphTaskVectors, GraphVectorState } from "./api";
import { DetailDialog } from "./DetailDialog";
import { formatDuration, formatShortTime } from "./format";
import { ProgressSteps, type ProgressStep } from "./GraphCheckSteps";
import { Tag } from "./Tag";
import type { Tone } from "./tags";

// 建图任务里每份文档的图检索向量（名字、关系向量）：表格里一个标签，点开右侧抽屉看进度和明细。
export const VECTOR_STATE: Record<
  GraphVectorState,
  { label: string; tone: Tone }
> = {
  none: { label: "未算", tone: "neutral" },
  queued: { label: "排队中", tone: "info" },
  running: { label: "计算中", tone: "info" },
  done: { label: "已算", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  stale: { label: "需要重算", tone: "warning" },
  interrupted: { label: "中断", tone: "warning" },
};

const PHASES: { key: string; label: string }[] = [
  { key: "names", label: "名字向量" },
  { key: "relations", label: "关系向量" },
  { key: "writing", label: "写入 Milvus" },
];

export function vectorsBusy(value: GraphTaskVectors | null | undefined) {
  return value?.state === "queued" || value?.state === "running";
}

// 进度按条数算：名字 + 关系一共多少条、算完多少条；写入阶段算 99%，完成 100%。
export function vectorPercent(value: GraphTaskVectors) {
  if (value.state === "done") return 100;
  const total = (value.names ?? 0) + (value.relations ?? 0);
  if (!total) return 0;
  const done = (value.names_done ?? 0) + (value.relations_done ?? 0);
  const percent = Math.floor((done / total) * 100);
  return value.phase === "writing" ? 99 : Math.min(percent, 99);
}

export function GraphVectorTag({
  value,
  onClick,
}: {
  value: GraphTaskVectors;
  onClick: () => void;
}) {
  const state = VECTOR_STATE[value.state] ?? VECTOR_STATE.none;
  const label =
    value.state === "running"
      ? `${state.label} ${vectorPercent(value)}%`
      : state.label;
  return (
    <Tag
      size="sm"
      tone={state.tone}
      dot
      onClick={onClick}
      title="查看图检索向量的进度和明细"
    >
      {label}
    </Tag>
  );
}

const PHASE_ORDER = ["names", "relations", "writing", "done"];

// 时长显示成 00:00:08。
function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

// 剩余时间按已算条数的速度估：(总条数 - 已算) ÷ (已算 ÷ 已用时间)。还没算出一批时不估。
function remaining(value: GraphTaskVectors) {
  if (!value.started || !value.at) return null;
  const used = new Date(value.at).getTime() - new Date(value.started).getTime();
  const done = (value.names_done ?? 0) + (value.relations_done ?? 0);
  const total = (value.names ?? 0) + (value.relations ?? 0);
  if (used <= 0 || done <= 0 || total <= done) return null;
  return ((total - done) * used) / done;
}

// 三步的状态：完成前面的打勾；当前这步进行中（失败、中断时打叉）；后面的等待。
export function vectorSteps(value: GraphTaskVectors): ProgressStep[] {
  const finished = value.state === "done";
  const broken = value.state === "failed" || value.state === "interrupted";
  const phase = PHASE_ORDER.indexOf(value.phase ?? "");
  const at = broken
    ? Math.max(phase, 0)
    : value.state === "running"
      ? phase
      : -1;
  const left = value.state === "running" ? remaining(value) : null;
  const count = (done?: number, total?: number) =>
    total === undefined ? undefined : `${done ?? 0} / ${total} 条`;
  return PHASES.map((item, index) => {
    const status = finished
      ? "finish"
      : at < 0 || index > at
        ? "wait"
        : index < at
          ? "finish"
          : broken
            ? "error"
            : "process";
    let subtitle: string | undefined;
    if (status === "process" && item.key !== "writing" && left !== null)
      subtitle = `剩余约 ${clock(left)}`;
    if (status === "error")
      subtitle = value.state === "interrupted" ? "中断" : "失败";
    const description =
      item.key === "names"
        ? count(value.names_done, value.names)
        : item.key === "relations"
          ? count(value.relations_done, value.relations)
          : status === "finish"
            ? "已写入，集合已加载"
            : "删除旧向量、写入、加载集合";
    return {
      key: item.key,
      title: item.label,
      subtitle,
      description: description ?? "等待开始",
      status,
    };
  });
}

export function GraphVectorDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: GraphTaskVectors;
  onClose: () => void;
}) {
  const state = VECTOR_STATE[value.state] ?? VECTOR_STATE.none;
  const percent = vectorPercent(value);
  const running = vectorsBusy(value);
  const elapsed =
    value.duration_ms ??
    (value.started && value.at
      ? new Date(value.at).getTime() - new Date(value.started).getTime()
      : null);
  const rows: [string, string][] = [
    ["图谱版本", `v${value.version_number}`],
    [
      "名字向量",
      value.names !== undefined
        ? `${value.names_done ?? 0} / ${value.names} 条`
        : "—",
    ],
    [
      "关系向量",
      value.relations !== undefined
        ? `${value.relations_done ?? 0} / ${value.relations} 条`
        : "—",
    ],
    ["Embedding 模型", value.model || "—"],
    ["向量集合", value.collection || "—"],
    ["排队时间", formatShortTime(value.queued_at) || "—"],
    ["开始时间", formatShortTime(value.started) || "—"],
    ["最近更新", formatShortTime(value.at) || "—"],
    [
      value.state === "done" ? "耗时" : "已用时间",
      elapsed !== null ? formatDuration(elapsed) : "—",
    ],
  ];
  return (
    <DetailDialog open title={`图检索向量 · ${title}`} onClose={onClose}>
      <div
        className={`gv-progress${running ? "" : " is-stopped"}${value.state === "done" ? " is-done" : ""}`}
      >
        <div className="gv-progress-head">
          <Tag size="sm" tone={state.tone} dot>
            {state.label}
          </Tag>
          <strong>{percent}%</strong>
        </div>
        <div className="gv-progress-bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <ProgressSteps steps={vectorSteps(value)} direction="vertical" />
      </div>
      {value.state === "none" && (
        <p className="graph-note">
          这个图谱版本还没有算向量，点上方「补算向量」开始。
        </p>
      )}
      {value.state === "queued" && (
        <p className="graph-note">
          已排进建图队列，等 worker 处理完前面的任务就开始计算。
        </p>
      )}
      {value.state === "stale" && (
        <p className="graph-note">
          向量是用别的 embedding
          模型算的，当前检索查不到，点上方「补算向量」重新计算。
        </p>
      )}
      {value.state === "interrupted" && (
        <p className="graph-note">
          超过 10 分钟没有进展，worker
          可能中断了。可以点上方「补算向量」重新排队。
        </p>
      )}
      {value.error && <pre className="gv-error">{value.error}</pre>}
      <dl className="gv-facts">
        {rows.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </DetailDialog>
  );
}
