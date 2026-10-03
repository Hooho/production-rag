import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getInspectionIssue, getInspectionSchedule, listInspectionIssues, saveInspectionSchedule, startInspection, updateInspectionIssue, type InspectionEvent, type InspectionSchedule, type InspectionScheduleView, type InspectionIssue, type InspectionIssueFull, type InspectionIssuePage, type InspectionKind, type InspectionStatus } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./Inspection.css";

type ShowToast = (kind: "success" | "error", message: string) => void;

const STATUS_TABS: { key: InspectionStatus | null; label: string }[] = [
  { key: "open", label: "待处理" },
  { key: "handled", label: "已处理" },
  { key: "resolved", label: "已解决" },
  { key: "ignored", label: "已忽略" },
  { key: null, label: "全部" },
];
const STATUS_TONES: Record<InspectionStatus, string> = { open: "orange", handled: "blue", resolved: "green", ignored: "gray" };
const FEEDBACK_REASONS: Record<string, string> = { wrong: "答错了", incomplete: "没答全", missed: "资料里有却说找不到", citation: "引用不对", other: "其他" };
const TRIGGERS: Record<string, string> = { cli: "命令行", api: "手动", schedule: "定时" };

// 每类问题用大白话说明"这是什么问题"和"建议怎么处理"，详情页顶部显示。
// 原来详情页只列出系统内部的字段（错误信息、出错步骤、最高分），第一次看的人不知道问题意味着什么、下一步该做什么。
function explain(issue: InspectionIssue): { what: string; todo: string[] } {
  const detail = issue.detail;
  if (issue.kind === "knowledge_gap") {
    return {
      what: "用户问了下面这些问题，系统没能给出答案：直接拒答、判断资料不够，或者用户反馈「没答全」「资料里有却说找不到」。通常说明知识库里缺少相关文档。",
      todo: ["先判断问题是否属于你的业务范围：闲聊、常识、和业务无关的问题，拒答是正确的，点「忽略」即可。", "属于业务范围的，补充或更新相关文档，然后点「标记已处理」；之后如果还有人问同类问题答不上，会自动重新打开。"],
    };
  }
  if (issue.kind === "suspect_content") {
    return {
      what: "下面这段文档内容被回答引用后，多次收到用户差评。内容可能已经过时、写错了，或者表述容易让人误解。",
      todo: ["对照用户的补充说明核对原文。有问题就在知识库里上传新版本，文档更新后这个问题会自动变成「已解决」。", "核对后内容没有问题（比如用户理解错了），点「忽略」。"],
    };
  }
  if (detail.signals?.citation_failure) {
    return {
      what: "系统检索到了资料并交给模型（编号为 S1、S2…），要求模型在回答里用编号标明每句话的依据。下面这些回答要么没有引用任何一段资料，要么引用了根本不存在的编号（虚构来源）。为了防止编造，系统拦下了回答，用户只看到一句提示，没有拿到答案。",
      todo: ["看每条关联记录的具体原因和模型原话：没有引用，多半是模型没遵守格式；引用了不存在的编号，说明模型在编造来源。", "偶尔出现可以忽略；反复出现时，检查回答模型的提示词，或者在设置页换一个更听指令的模型。"],
    };
  }
  const error = detail.error ?? "";
  const step = detail.last_step_label ?? detail.last_step ?? "某一步";
  const todo = /connection|timeout|timed out|连不上|超时/i.test(error)
    ? ["这类错误多半是连不上大模型服务：检查网络和代理（容器访问外网要在 .env 里设置 HTTP_PROXY / HTTPS_PROXY），以及设置页的模型地址。", "确认恢复后点「标记已处理」；如果之后还出现，会自动重新打开。"]
    : /auth|401|api key|密钥/i.test(error)
      ? ["这类错误通常是模型密钥无效或过期：在设置页检查模型配置。", "确认恢复后点「标记已处理」。"]
      : ["根据下面的错误信息排查，必要时查看 api 容器日志：docker-compose logs api。", "修复后点「标记已处理」。"];
  return { what: `用户提问后，系统在「${step}」完成之后的下一步出错，用户只收到了错误提示，没有拿到回答。`, todo };
}

// 显示成本地时间的"月-日 时:分"；年份不同时带上年份。
function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  const text = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? text : `${date.getFullYear()}-${text}`;
}

// 知识巡检页（只有管理员可见）：从问答日志合并出来的问题清单，逐条查看、处理、标记状态。
export default function Inspection({ onToast }: { onToast: ShowToast }) {
  const [status, setStatus] = useState<InspectionStatus | null>("open");
  const [kind, setKind] = useState<InspectionKind | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InspectionIssuePage | null>(null);
  const [loading, setLoading] = useState(true);
  // 展开的问题可以同时有多个，互不影响：对比几个问题时不用来回切换。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggle(issueId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }
  const [starting, setStarting] = useState(false);

  async function reload(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      setData(await listInspectionIssues({ status, kind, page }));
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [status, kind, page]);

  // 巡检在后台执行，运行期间每 3 秒刷新一次，结束后自动显示新结果。
  const running = data?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void reload(true), 3000);
    return () => window.clearInterval(timer);
  }, [running, status, kind, page]);

  async function runNow() {
    setStarting(true);
    try {
      await startInspection();
      onToast("success", "已开始巡检，完成后列表会自动刷新");
      await reload(true);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setStarting(false);
    }
  }

  // 问题状态变了之后可能不再属于当前筛选，刷新列表并收起详情。
  function handleChanged(issue: InspectionIssueFull) {
    if (status && issue.status !== status) setExpanded((current) => {
      const next = new Set(current);
      next.delete(issue.id);
      return next;
    });
    void reload(true);
  }

  const lastRun = data?.last_run;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return <div className="inspection-page">
    <header className="topbar inspection-topbar">
      <div>
        <h1>知识巡检</h1>
        <p className="inspection-subtitle">从问答日志中收集拒答、资料不足、差评和处理失败，合并成待处理问题。只有管理员可见。</p>
      </div>
      <div className="inspection-run">
        <span className="inspection-run-info">
          {running ? "巡检进行中…" : lastRun ? <>上次巡检 {formatTime(lastRun.started)}（{TRIGGERS[lastRun.trigger] ?? lastRun.trigger}）{lastRun.status === "failed" && <span className="inspection-run-failed" title={lastRun.error ?? ""}>失败</span>}</> : "还没有巡检记录"}
        </span>
        <button type="button" className="primary-button inspection-run-button" onClick={() => void runNow()} disabled={starting || running}>{running ? "巡检中…" : "立即巡检"}</button>
      </div>
    </header>

    <ScheduleBar running={running} onToast={onToast} />

    <div className="document-detail-tabs inspection-tabs" role="tablist">
      {STATUS_TABS.map((tab) => {
        const count = tab.key ? data?.status_counts[tab.key] ?? 0 : null;
        return <button key={tab.label} role="tab" aria-selected={status === tab.key} className={status === tab.key ? "active" : ""} onClick={() => { setStatus(tab.key); setPage(1); setExpanded(new Set()); }}>{tab.label}{count !== null && <span>{count}</span>}</button>;
      })}
    </div>

    <div className="inspection-kinds" role="group" aria-label="问题类型">
      <button type="button" className={`inspection-chip ${kind === null ? "is-selected" : ""}`} onClick={() => { setKind(null); setPage(1); }}>全部类型</button>
      {data && (Object.keys(data.kinds) as InspectionKind[]).map((key) => <button key={key} type="button" className={`inspection-chip ${kind === key ? "is-selected" : ""}`} onClick={() => { setKind(key); setPage(1); }}>{data.kinds[key]}<span>{data.kind_counts[key] ?? 0}</span></button>)}
    </div>

    {loading && !data ? <InspectionSkeleton /> : data && data.items.length === 0 ? <div className="inspection-empty">{status === "open" ? "没有待处理的问题。" : "没有符合条件的问题。"}{!lastRun && " 点击「立即巡检」开始第一次巡检。"}</div> : <ul className="inspection-list">
      {data?.items.map((issue) => <IssueRow key={issue.id} issue={issue} signals={data.signals} open={expanded.has(issue.id)} onToggle={() => toggle(issue.id)} onChanged={handleChanged} onToast={onToast} />)}
    </ul>}

    {data && data.total > data.page_size && <div className="inspection-pager">
      <span>共 {data.total} 个问题</span>
      <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{page} / {totalPages}</span>
      <button type="button" className="secondary-button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </div>;
}

// 下次执行时间按巡检设置的时区显示，和"每天 08:00（时区）"对得上；浏览器在别的时区时不会显示成另一个钟点。
function formatZoned(value: string, timeZone: string) {
  const date = new Date(value);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return formatTime(value);
  }
}

function describeSchedule(schedule: InspectionSchedule, timezone: string) {
  const frequency = schedule.mode === "daily" ? `每天 ${schedule.time}（${timezone}）` : `每隔 ${schedule.interval_hours} 小时`;
  return `${frequency} · 扫描最近 ${schedule.days} 天的问答`;
}

// 定时巡检：显示当前设置和下次执行时间，点"设置"展开表单。由 worker 按设置执行，保存后立即生效。
function ScheduleBar({ running, onToast }: { running: boolean; onToast: ShowToast }) {
  const [view, setView] = useState<InspectionScheduleView | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InspectionSchedule | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setView(await getInspectionSchedule());
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  // 巡检结束后刷新一次，"下次执行"会跟着更新。
  useEffect(() => {
    if (!running) void load();
  }, [running]);

  function startEdit() {
    if (!view) return;
    setDraft({ ...view.schedule });
    setEditing(true);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const { enabled, mode, time, interval_hours, days } = draft;
      setView(await saveInspectionSchedule({ enabled, mode, time, interval_hours: Number(interval_hours), days: Number(days) }));
      setEditing(false);
      onToast("success", enabled ? "定时巡检已保存" : "已关闭定时巡检");
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!view) return null;
  const schedule = view.schedule;
  const update = (patch: Partial<InspectionSchedule>) => setDraft((current) => current ? { ...current, ...patch } : current);
  return <section className="inspection-schedule">
    <div className="inspection-schedule-bar">
      <span className="inspection-schedule-title">定时巡检</span>
      {schedule.enabled
        ? <span>{describeSchedule(schedule, view.timezone)}{view.next_run && <> · 下次 {formatZoned(view.next_run, view.timezone)}</>}</span>
        : <span className="inspection-schedule-off">未开启，只能手动点"立即巡检"</span>}
      {!editing && <button type="button" className="secondary-button" onClick={startEdit}>设置</button>}
    </div>
    {editing && draft && <div className="inspection-schedule-form">
      <div className="inspection-schedule-row"><label><input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />开启定时巡检</label></div>
      <div className="inspection-schedule-row">
        <span className="inspection-schedule-label">频率</span>
        <label><input type="radio" name="inspection-mode" checked={draft.mode === "daily"} onChange={() => update({ mode: "daily" })} disabled={!draft.enabled} />每天</label>
        <input type="time" value={draft.time} onChange={(event) => update({ time: event.target.value })} disabled={!draft.enabled || draft.mode !== "daily"} />
        <span className="inspection-schedule-hint">（{view.timezone}）</span>
        <span className="inspection-schedule-gap" />
        <label><input type="radio" name="inspection-mode" checked={draft.mode === "interval"} onChange={() => update({ mode: "interval" })} disabled={!draft.enabled} />每隔</label>
        <input type="number" min={1} max={168} value={draft.interval_hours} onChange={(event) => update({ interval_hours: Number(event.target.value) })} disabled={!draft.enabled || draft.mode !== "interval"} />
        <span>小时</span>
      </div>
      <div className="inspection-schedule-row">
        <span className="inspection-schedule-label">扫描范围</span>
        <span>最近</span>
        <input type="number" min={1} max={365} value={draft.days} onChange={(event) => update({ days: Number(event.target.value) })} />
        <span>天的问答</span>
        <span className="inspection-schedule-hint">手动点"立即巡检"也用这个范围</span>
      </div>
      <p className="inspection-hint">保存后立即生效，下一次执行时间从现在算起，不会马上补跑一次。定时巡检由 worker 服务执行，worker 停止时不会执行。</p>
      <div className="inspection-action-buttons">
        <button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={saving}>取消</button>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </div>}
  </section>;
}

function InspectionSkeleton() {
  return <LoadingSkeleton className="inspection-skeleton" label="正在加载巡检问题">
    {[0, 1, 2, 3].map((index) => <div key={index} className="inspection-skeleton-row"><SkeletonBlock className="skeleton-line-short" /><SkeletonBlock className="skeleton-line" /></div>)}
  </LoadingSkeleton>;
}

// 信号计数显示成小标签，按次数从多到少。
function SignalChips({ counts, labels }: { counts?: Record<string, number>; labels: Record<string, string> }) {
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return <div className="inspection-signals">{entries.map(([key, count]) => <span key={key} className="inspection-signal">{labels[key] ?? key} {count}</span>)}</div>;
}

// 列表中的一行：标题、类型、出现次数和信号；展开后加载详情。
function IssueRow({ issue, signals, open, onToggle, onChanged, onToast }: { issue: InspectionIssue; signals: Record<string, string>; open: boolean; onToggle: () => void; onChanged: (issue: InspectionIssueFull) => void; onToast: ShowToast }) {
  return <li className={`inspection-item ${open ? "is-open" : ""}`}>
    <button type="button" className="inspection-item-head" onClick={onToggle} aria-expanded={open}>
      <div className="inspection-item-main">
        <div className="inspection-item-tags">
          <span className={`inspection-kind is-${issue.kind}`}>{issue.kind_label}</span>
          <span className={`status-tag is-${STATUS_TONES[issue.status]}`}>{issue.status_label}</span>
          {issue.status === "open" && issue.detail.reopened && <span className="status-tag is-red">处理后再次出现</span>}
        </div>
        <div className="inspection-item-title">{issue.title}</div>
        <SignalChips counts={issue.detail.signals} labels={signals} />
      </div>
      <div className="inspection-item-stats">
        <span><strong>{issue.occurrences}</strong> 次 · <strong>{issue.users}</strong> 人</span>
        <em>最近 {formatTime(issue.last_seen)}</em>
      </div>
    </button>
    {open && <IssueDetail issueId={issue.id} signals={signals} onChanged={onChanged} onToast={onToast} />}
  </li>;
}

// 问题详情：按类型展示线索，下面是关联的原始问答和处理操作。
function IssueDetail({ issueId, signals, onChanged, onToast }: { issueId: string; signals: Record<string, string>; onChanged: (issue: InspectionIssueFull) => void; onToast: ShowToast }) {
  const [issue, setIssue] = useState<InspectionIssueFull | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getInspectionIssue(issueId).then((value) => {
      if (cancelled) return;
      setIssue(value);
      setNote(value.note ?? "");
    }).catch((reason: Error) => onToast("error", reason.message));
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  async function save(status?: "open" | "handled" | "ignored") {
    if (!issue) return;
    setBusy(true);
    try {
      const value = await updateInspectionIssue(issue.id, { status, note });
      setIssue(value);
      onToast("success", status ? `已标记为${value.status_label}` : "备注已保存");
      onChanged(value);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!issue) return <div className="inspection-detail"><LoadingSkeleton label="正在加载问题详情"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton></div>;
  const detail = issue.detail;
  return <div className="inspection-detail">
    {detail.resolution && <div className="inspection-notice is-green">{detail.resolution}</div>}
    <Explanation issue={issue} />
    {issue.status === "open" && detail.reopened && <div className="inspection-notice is-red">标记为{detail.reopened.previous_status === "handled" ? "已处理" : "已解决"}之后又出现了 {detail.reopened.new_occurrences} 次，已重新打开（{formatTime(detail.reopened.at)}）。</div>}

    {issue.kind === "knowledge_gap" && <div className="inspection-facts">
      <Fact label="示例问题">{detail.questions?.length ? <ul>{detail.questions.map((text) => <li key={text}>{text}</li>)}</ul> : "—"}</Fact>
      {detail.missing?.length ? <Fact label="缺失内容"><ul>{detail.missing.map((item) => <li key={item.text}>{item.text}{item.count > 1 && <span className="inspection-count">×{item.count}</span>}</li>)}</ul></Fact> : null}
      {detail.comments?.length ? <Fact label="用户补充">{<ul>{detail.comments.map((text) => <li key={text}>{text}</li>)}</ul>}</Fact> : null}
    </div>}

    {issue.kind === "suspect_content" && <div className="inspection-facts">
      <Fact label="所在文档">{detail.document_title ? `《${detail.document_title}》` : "已不在当前版本中"}</Fact>
      {detail.preview && <Fact label="分片原文"><blockquote>{detail.preview}</blockquote></Fact>}
      <Fact label="引用与差评">{detail.cited !== undefined ? `窗口内被引用 ${detail.cited} 次，差评 ${detail.signals?.negative_feedback ?? 0} 次（${Math.round((detail.negative_rate ?? 0) * 100)}%）` : `差评 ${detail.signals?.negative_feedback ?? 0} 次`}</Fact>
      {detail.comments?.length ? <Fact label="用户补充">{<ul>{detail.comments.map((text) => <li key={text}>{text}</li>)}</ul>}</Fact> : null}
    </div>}

    {issue.kind === "system_error" && <div className="inspection-facts">
      {detail.last_step && !detail.signals?.citation_failure && <Fact label="出错位置">「{detail.last_step_label ?? detail.last_step}」之后的下一步</Fact>}
      {!detail.signals?.citation_failure && <Fact label="错误信息"><code>{detail.error ?? "—"}</code></Fact>}
    </div>}

    <div className="inspection-meta">首次出现 {formatTime(issue.first_seen)} · 最近 {formatTime(issue.last_seen)}{issue.status_by && <> · {issue.status_by === "system" ? "巡检" : issue.status_by} 于 {formatTime(issue.status_updated)} 标记为{issue.status_label}</>}</div>

    <div className="inspection-actions">
      <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={2} placeholder="处理备注：补了哪份文档、改了什么配置（可选）" />
      <div className="inspection-action-buttons">
        <button type="button" className="secondary-button" disabled={busy || note === (issue.note ?? "")} onClick={() => void save()}>保存备注</button>
        {issue.status !== "open" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void save("open")}>重新打开</button>}
        {issue.status !== "ignored" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void save("ignored")}>忽略</button>}
        {issue.status !== "handled" && issue.status !== "resolved" && <button type="button" className="primary-button" disabled={busy} onClick={() => void save("handled")}>标记已处理</button>}
      </div>
      <p className="inspection-hint">标记已处理后，如果又出现同类问答，下次巡检会自动重新打开；忽略的问题不会再提醒。</p>
    </div>

    <h3 className="inspection-section-title">关联记录（{issue.occurrences}）</h3>
    <ul className="inspection-events">
      {issue.events.map((event) => <li key={`${event.source}:${event.source_id}`} className="inspection-event">
        <div className="inspection-event-head">
          <span>{formatTime(event.created)}</span>
          <span>{event.owner}</span>
          {event.signals.map((signal) => <span key={signal} className="inspection-signal">{signals[signal] ?? signal}</span>)}
          {event.returned !== undefined && event.returned !== null && <span className="inspection-score">检索返回 {event.returned} 段资料</span>}
          {event.top_score !== undefined && event.top_score !== null && <span className="inspection-score" title="检索到的资料里，和问题最相关的那一段的得分，满分 1，越高说明资料越对题">最相关资料得分 {event.top_score.toFixed(2)}（满分 1）</span>}
        </div>
        {event.question && <div className="inspection-event-question"><span className="inspection-event-label">问题：</span>{event.question}</div>}
        {event.answer && <AnswerText label="用户看到的回答：" text={event.answer} />}
        {event.signals.includes("citation_failure") && <CitationDetail event={event} />}
        <SourceList event={event} />
        <CallSummary event={event} />
        {event.missing && event.missing.length > 0 && <div className="inspection-event-line">缺失：{event.missing.join("；")}</div>}
        {event.feedback && event.feedback.rating === -1 && <div className="inspection-event-line">差评{event.feedback.reason ? `：${FEEDBACK_REASONS[event.feedback.reason] ?? event.feedback.reason}` : ""}{event.feedback.comment && <>（{event.feedback.comment}）</>}</div>}
        {event.error && <div className="inspection-event-line"><code>{event.error}</code></div>}
      </li>)}
    </ul>
    {issue.occurrences > issue.events.length && <p className="inspection-hint">只显示最近 {issue.events.length} 条。</p>}
  </div>;
}

// 回答被拦截的具体原因：没有引用，还是引用了不存在的编号；有模型原话时一并显示。
function CitationDetail({ event }: { event: InspectionEvent }) {
  const citation = event.citation;
  if (!citation) {
    const count = event.returned ? `${event.returned} 段` : "";
    return <div className="inspection-citation">
      <div><span className="inspection-event-label">拦截原因：</span>检索返回了 {count}资料，但模型的回答没有引用它们，或者引用了不存在的编号。</div>
      <div className="inspection-event-line">这条记录早于"保存模型原话"功能，看不到模型原话，也分不清是哪一种情况。</div>
    </div>;
  }
  const ids = citation.source_ids.join("、");
  const reason = citation.reason === "unknown_source"
    ? `检索只返回了 ${citation.source_ids.length} 段资料（${ids}），模型却引用了不存在的 ${citation.unknown.join("、")}，属于虚构来源。`
    : `检索返回了 ${citation.source_ids.length} 段资料（${ids}），但模型的回答没有引用其中任何一段。`;
  return <div className="inspection-citation">
    <div><span className="inspection-event-label">拦截原因：</span>{reason}</div>
    {citation.raw_answer && <div className="inspection-citation-raw"><AnswerText label="模型原话（被拦截，用户没有看到）：" text={citation.raw_answer} /></div>}
  </div>;
}

// 配置信息：这次回答用了哪些模型、哪版提示词、多少 Token、多长时间，默认折叠。
// 模型名记录成"名称（类型）"，这里拆成"类型：名称（用在哪几步）"逐行显示，比挤在一行里好读。
function CallSummary({ event }: { event: InspectionEvent }) {
  const call = event.call;
  if (!call) return null;
  const rows: [string, string][] = [];
  for (const model of call.models) {
    const match = model.name.match(/^(.*)（([^（）]+)）$/);
    const name = match ? match[1] : model.name;
    const kind = match ? match[2] : "模型";
    rows.push([kind, model.steps.length ? `${name}（${model.steps.join("、")}）` : name]);
  }
  if (call.rerank_model && !rows.some(([kind]) => kind === "重排模型")) rows.push(["重排模型", call.rerank_model]);
  if (!rows.some(([kind]) => kind === "聊天大模型")) rows.push(["聊天大模型", "未调用"]);
  if (call.prompt_version) rows.push(["提示词", call.prompt_version]);
  const usage = call.token_usage;
  if (usage?.total) rows.push(["Token", `${usage.total.toLocaleString()}（输入 ${usage.input?.toLocaleString() ?? "—"} / 输出 ${usage.output?.toLocaleString() ?? "—"}）`]);
  if (typeof call.duration_ms === "number") rows.push(["总耗时", `${(call.duration_ms / 1000).toFixed(1)} 秒`]);
  return <details className="inspection-sources inspection-call">
    <summary>配置信息</summary>
    <dl>{rows.map(([label, value]) => <div key={label + value}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </details>;
}

// 检索返回、交给模型的资料，默认折叠。回答被拦截时标出模型引用了哪几段，没被引用的一目了然。
function SourceList({ event }: { event: InspectionEvent }) {
  // 资料之间是手风琴：同一时间只展开一段全文，其余只显示前 3 行。
  const [openId, setOpenId] = useState<string | null>(null);
  const sources = event.sources ?? [];
  if (event.source !== "run") return null;
  if (sources.length === 0) {
    return event.returned ? <div className="inspection-event-line">这条记录没有保存资料原文。</div> : null;
  }
  const cited = new Set(event.citation?.cited ?? []);
  return <details className="inspection-sources">
    <summary>查看检索返回的 {sources.length} 段资料</summary>
    <ol>
      {sources.map((source) => <li key={source.id}>
        <div className="inspection-source-head">
          <strong>{source.id}</strong>
          <span>《{source.title}》{source.version ? ` v${source.version}` : ""}{source.page_start ? ` · 第 ${source.page_start} 页` : ""}{source.heading ? ` · ${source.heading}` : ""}</span>
          {typeof source.score === "number" && <span className="inspection-score" title="这段资料和问题的相关度得分，满分 1">得分 {source.score.toFixed(2)}</span>}
          {event.citation && <span className={`inspection-source-tag ${cited.has(source.id) ? "is-cited" : ""}`}>{cited.has(source.id) ? "模型引用了" : "模型没有引用"}</span>}
        </div>
        <SourceText text={source.text} truncated={source.truncated} open={openId === source.id} onToggle={() => setOpenId(openId === source.id ? null : source.id)} />
      </li>)}
    </ol>
  </details>;
}

// 把推理模型的 <think> 思考过程和正式回答分开。没有闭合的 </think> 说明回答被截断或模型只输出了思考，全部算作思考过程。
function splitThink(text: string) {
  const match = text.match(/<think>([\s\S]*?)(<\/think>|$)/);
  if (!match) return { think: "", answer: text.trim() };
  return { think: match[1].trim(), answer: text.replace(match[0], "").trim() };
}

// 回答：正式回答默认显示 3 行，可展开全文；思考过程单独折叠，默认收起。
function AnswerText({ label, text }: { label: string; text: string }) {
  const { think, answer } = splitThink(text);
  return <div className="inspection-event-answer">
    <span className="inspection-event-label">{label}</span>
    {answer ? <SourceText text={answer} /> : <div className="inspection-event-line">模型只输出了思考过程，没有给出正式回答。</div>}
    {think && <details className="inspection-sources inspection-think">
      <summary>模型思考过程</summary>
      <div className="inspection-think-text">{think}</div>
    </details>}
  </div>;
}

// 长文本默认只显示 3 行，不出现滚动条；超过 3 行才显示"展开全文"。
// 传入 open / onToggle 时由外部控制（资料列表用它做手风琴），不传时自己管理展开状态。
function SourceText({ text, truncated = false, open: controlledOpen, onToggle }: { text: string; truncated?: boolean; open?: boolean; onToggle?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen(!ownOpen));
  // 外层"查看检索返回的资料"刚展开前，原文没有尺寸，量不出是否超过 3 行；用 ResizeObserver 在有尺寸后再量一次。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return <>
    <div ref={ref} className={`inspection-source-text ${open ? "is-open" : ""}`}>{text}{open && truncated && "…（原文较长，只显示前 1500 字）"}</div>
    {(overflow || open) && <button type="button" className="inspection-source-toggle" onClick={toggle}>{open ? "收起" : "展开全文"}</button>}
  </>;
}

function Explanation({ issue }: { issue: InspectionIssue }) {
  const { what, todo } = explain(issue);
  return <div className="inspection-explain">
    <div className="inspection-explain-block"><div className="inspection-explain-title">这是什么问题</div><p>{what}</p></div>
    <div className="inspection-explain-block"><div className="inspection-explain-title">建议怎么处理</div><ul>{todo.map((text) => <li key={text}>{text}</li>)}</ul></div>
  </div>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="inspection-fact"><div className="inspection-fact-label">{label}</div><div className="inspection-fact-value">{children}</div></div>;
}
