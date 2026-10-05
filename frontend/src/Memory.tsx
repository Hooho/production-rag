import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clearLongMemory, deleteLongMemory, getLongMemory, getMemorySession, listMemorySessions, setLongMemoryEnabled, type LongMemoryItem, type LongMemoryView, type MemorySessionDetail, type MemorySessionList, type MemoryTimelineTurn, type MemoryTurnText } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./Memory.css";

// 会话记忆：每个用户只能看自己的会话。列表看每个会话记忆的大小和压缩情况；
// 详情看「模型下一轮会记得什么」（滚动摘要 + 保留原文的最近几轮）和每一轮之后记忆是怎么变化的。

const HINTS = {
  compressions: "对话超过压缩阈值后，较早的问答会被大模型压成一段摘要，只保留最近几轮原文。这里是这个会话压缩过几次。",
  memory: "下一轮提问时，回答模型会收到的对话记忆的大小（摘要 + 保留的原文），和压缩阈值对比。达到阈值就会触发下一次压缩。",
  snapshots: "对话记忆每更新一步就存一份当时的完整状态，一份叫一个快照。一轮问答通常会存 3–4 个（收到问题、检查是否压缩、生成回答、收尾）。只有最新的一个会被用到，旧快照只占空间。",
  bytes: "这个会话的记忆在数据库里占的空间，包括所有旧快照。会话越长、快照越多，占用越大。",
  summary: "对话越长，每次发给模型的内容就越多，回答更慢、更贵，还会挤占检索资料的空间。超过阈值后，较早的对话压成一段摘要，只记住要点：用户目标、已确认的事实、还没解决的问题。",
  rewritten: "检索之前，系统会结合最近几轮的问题，把半句话的追问补成完整的问题再去检索。这一列能看出记忆有没有帮上忙。",
};

// 提示气泡挂到 body 上、按视口定位：放在图标里时会被左侧导航栏挡住，在表格里还会被滚动容器裁掉。
// 默认在图标下方居中，左右不超出视口；下方放不下时放到上方。
const BUBBLE_WIDTH = 260;
function Hint({ text }: { text: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(BUBBLE_WIDTH, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom > 160;
    setStyle(below ? { left, width, top: rect.bottom + 6 } : { left, width, bottom: window.innerHeight - rect.top + 6 });
  };
  const hide = () => setStyle(null);
  return <span ref={anchor} className="mem-hint" tabIndex={0} aria-label={text}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>?
    {style && createPortal(<span className="mem-hint-bubble" role="tooltip" style={style}>{text}</span>, document.body)}
  </span>;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function tokens(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");
}

export default function Memory({ sessionId, tab, onNavigate }: { sessionId: string | null; tab?: "long"; onNavigate: (path: string) => void }) {
  if (tab === "long") return <LongMemory onNavigate={onNavigate} />;
  return sessionId ? <MemoryDetail sessionId={sessionId} onBack={() => onNavigate("/memory")} /> : <MemoryList onNavigate={onNavigate} onOpen={(id) => onNavigate(`/memory/${encodeURIComponent(id)}`)} />;
}

// 记忆分两种：会话记忆（短期，同一个会话里的对话，按会话存）和长期记忆（跨会话的用户偏好、身份，按用户存）。
function MemoryTabs({ active, onNavigate }: { active: "session" | "long"; onNavigate: (path: string) => void }) {
  return <div className="mem-tabs" role="tablist">
    <button type="button" role="tab" aria-selected={active === "session"} className={active === "session" ? "is-active" : ""} onClick={() => onNavigate("/memory")}>会话记忆<small>短期 · 每个会话各自记</small></button>
    <button type="button" role="tab" aria-selected={active === "long"} className={active === "long" ? "is-active" : ""} onClick={() => onNavigate("/memory/long")}>长期记忆<small>跨会话 · 记住你本人</small></button>
  </div>;
}

function MemoryList({ onOpen, onNavigate }: { onOpen: (sessionId: string) => void; onNavigate: (path: string) => void }) {
  const [data, setData] = useState<MemorySessionList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    listMemorySessions().then(setData).catch((reason: Error) => setError(reason.message));
  }, []);
  return <div className="mem-page">
    <header className="topbar mem-topbar">
      <div>
        <h1>记忆</h1>
        <MemoryTabs active="session" onNavigate={onNavigate} />
        <p className="mem-subtitle">你的每个会话里，系统记住了什么：较早的对话压成的摘要，加上最近几轮原文。只有你自己能看到。{data && ` 当前设置：超过 ${tokens(data.trigger_tokens)} Token 压缩，压缩后保留最近不超过 ${tokens(data.keep_tokens)} Token 的原文。`}</p>
      </div>
    </header>
    {error && <div className="field-error">{error}</div>}
    {!data && !error && <LoadingSkeleton label="正在加载会话记忆"><SkeletonBlock className="mem-skeleton" /></LoadingSkeleton>}
    {data && (data.items.length === 0 ? <div className="mem-empty">还没有对话。到「知识问答」里聊几句，这里就会出现。</div> : <div className="mem-table-wrap"><table className="mem-table">
      <thead><tr>
        <th>会话</th><th className="num">轮数</th>
        <th className="num">压缩 <Hint text={HINTS.compressions} /></th>
        <th>当前记忆 <Hint text={HINTS.memory} /></th>
        <th className="num">快照 <Hint text={HINTS.snapshots} /></th>
        <th className="num">占用 <Hint text={HINTS.bytes} /></th>
        <th>最后活动</th>
      </tr></thead>
      <tbody>{data.items.map((item) => <tr key={item.session_id} onClick={() => onOpen(item.session_id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onOpen(item.session_id); }}>
        <td className="mem-title-cell"><strong>{item.title || "未命名对话"}</strong></td>
        <td className="num">{item.turns}</td>
        <td className="num">{item.compressions ? `${item.compressions} 次` : "未压缩"}</td>
        <td><Usage used={item.memory_tokens} limit={data.trigger_tokens} compact /></td>
        <td className="num">{item.snapshots ?? "—"}</td>
        <td className="num">{formatBytes(item.bytes)}</td>
        <td>{formatTime(item.last_active)}</td>
      </tr>)}</tbody>
    </table></div>)}
  </div>;
}

// 记忆用量：当前 / 压缩阈值，以及还差多少触发下一次压缩。
function Usage({ used, limit, compact = false }: { used: number; limit: number; compact?: boolean }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const over = used >= limit;
  return <div className={`mem-usage ${compact ? "is-compact" : ""}`}>
    <span className="mem-usage-track"><span className={`mem-usage-fill ${over ? "is-over" : ""}`} style={{ width: `${ratio * 100}%` }} /></span>
    <span className="mem-usage-text">{tokens(used)} / {tokens(limit)} Token{!compact && (over ? "（已超过阈值，下一轮会再次压缩）" : `（再多约 ${tokens(limit - used)} Token 会触发下一次压缩）`)}</span>
  </div>;
}

function MemoryDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [data, setData] = useState<MemorySessionDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    getMemorySession(sessionId).then(setData).catch((reason: Error) => setError(reason.message));
  }, [sessionId]);
  const current = data?.current;
  const lastCompressed = data ? [...data.timeline].reverse().find((turn) => turn.compressed) : undefined;
  // 保留原文对应的轮次：最近几轮进入了回答模型的问答。
  // 早期格式的记录（entered 为 null）无法判断，按进入过记忆算。
  const entered = data ? data.timeline.filter((turn) => turn.entered !== false) : [];
  const keptRounds = current ? entered.slice(Math.max(0, entered.length - current.turns.length)) : [];
  return <div className="mem-page">
    <button type="button" className="mem-back" onClick={onBack}>← 全部会话</button>
    {error && <div className="field-error">{error}</div>}
    {!data && !error && <LoadingSkeleton label="正在加载会话记忆"><SkeletonBlock className="mem-skeleton" /></LoadingSkeleton>}
    {data && current && <>
      <header className="mem-detail-head">
        <h1>{data.title || "未命名对话"}</h1>
        <p className="mem-subtitle">{data.timeline.length} 轮问答{data.last_order && <> · 最近订单 <code>{data.last_order}</code>（订单追问时自动带上）</>}</p>
      </header>

      <section className="mem-card">
        <h2>当前记忆：模型下一轮会记得什么</h2>
        <Usage used={current.estimated_tokens} limit={data.trigger_tokens} />
        {current.message_count === 0 ? <div className="mem-empty">这个会话还没有进入过回答模型（订单查询、数据查询、问候和没检索到资料的问题不会写进对话记忆），所以没有记忆。</div> : <>
          <div className="mem-block">
            <h3>摘要 <Hint text={HINTS.summary} /> <small>{current.summary ? `${lastCompressed ? `第 ${lastCompressed.index} 轮时生成` : "已生成"}${current.summary_tokens ? ` · ${tokens(current.summary_tokens)} Token` : ""}` : "还没有触发压缩，所以没有摘要"}</small></h3>
            {current.summary && <p className="mem-summary">{current.summary}</p>}
          </div>
          <div className="mem-block">
            <h3>最近原文 <small>{keptRounds.length ? `第 ${keptRounds[0].index}–${keptRounds[keptRounds.length - 1].index} 轮` : ""} · 压缩时保留最近不超过 {tokens(data.keep_tokens)} Token 的整轮问答</small></h3>
            <p className="mem-note">追问几乎都针对最近几轮，需要原话里的细节（数字、引用、原本的说法），摘要会丢掉这些，所以最近的几轮不压缩、原样保留。按整轮问答保留，不会只留下回答而丢了问题。</p>
            <TurnList turns={current.turns} rounds={keptRounds.map((turn) => turn.index)} />
          </div>
        </>}
      </section>

      <section className="mem-card">
        <h2>记忆时间线</h2>
        <p className="mem-note">每一轮的问题、检索前被补成了什么、回答前记忆有多大。点「压缩」或「追加」展开，看这一轮回答时模型拿到的记忆：摘要和保留的原文；压缩的那一轮还能看到被压掉了哪些原文。</p>
        <div className="mem-table-wrap"><table className="mem-table mem-timeline">
          <thead><tr><th className="num">轮次</th><th>问题</th><th>改写成 <Hint text={HINTS.rewritten} /></th><th className="num">回答前记忆</th><th>记忆变化</th></tr></thead>
          <tbody>{data.timeline.map((turn) => <TimelineRow key={turn.run_id} turn={turn} />)}</tbody>
        </table></div>
      </section>

      <details className="mem-card mem-storage">
        <summary>存储信息</summary>
        <dl>
          <div><dt>快照 <Hint text={HINTS.snapshots} /></dt><dd>{data.storage.snapshots ?? "—"} 个{data.timeline.length && data.storage.snapshots ? `（平均每轮约 ${(data.storage.snapshots / Math.max(1, entered.length)).toFixed(1)} 个）` : ""}</dd></div>
          <div><dt>占用 <Hint text={HINTS.bytes} /></dt><dd>{data.storage.backend === "postgres" ? formatBytes(data.storage.bytes) : "进程内存储，不统计占用"}</dd></div>
          <div><dt>存储位置</dt><dd>{data.storage.backend === "postgres" ? "PostgreSQL（LangGraph Checkpointer）" : "进程内存（重启后清空）"}</dd></div>
        </dl>
      </details>
    </>}
  </div>;
}

function TurnList({ turns, rounds }: { turns: MemoryTurnText[]; rounds?: number[] }) {
  if (turns.length === 0) return <div className="mem-empty">没有保留的原文。</div>;
  return <ol className="mem-turns">{turns.map((turn, index) => <li key={index}>
    {rounds?.[index] ? <span className="mem-round">第 {rounds[index]} 轮</span> : null}
    <div><span className="mem-role">问</span>{turn.question}</div>
    <ClampText label="答" text={turn.answer} />
  </li>)}</ol>;
}

// 回答往往很长，默认只显示前三行，点击展开全文。
function ClampText({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return <div className={`mem-answer ${open || !long ? "is-open" : ""}`}>
    <span className="mem-role">{label}</span>{text}
    {long && <button type="button" className="mem-more" onClick={() => setOpen(!open)}>{open ? "收起" : "展开"}</button>}
  </div>;
}

function TimelineRow({ turn }: { turn: MemoryTimelineTurn }) {
  const [open, setOpen] = useState(false);
  let change: ReactNode;
  const toggle = (label: string, className: string) => <button type="button" className={`mem-tag ${className}`} onClick={() => setOpen(!open)} aria-expanded={open}>{label} {open ? "▴" : "▾"}</button>;
  if (turn.entered === null) change = <span className="mem-tag is-muted" title="这一轮的记录里没有保存记忆信息（早期格式），无法判断有没有写入记忆、有没有压缩">未记录</span>;
  else if (!turn.entered) change = <><span className="mem-tag is-muted">未写入记忆</span>{turn.skip_reason && <small className="mem-skip">{turn.skip_reason}，这一轮不写进对话记忆</small>}</>;
  else if (turn.compressed) change = toggle("压缩", "is-compress");
  else change = toggle("追加", "is-append");
  return <>
    <tr className={open ? "is-open" : ""}>
      <td className="num">{turn.index}</td>
      <td>{turn.question}</td>
      <td className={turn.rewritten && turn.rewritten !== turn.question ? "mem-rewritten" : "mem-same"}>{turn.rewritten ? (turn.rewritten === turn.question ? "（不用改写）" : turn.rewritten) : "—"}</td>
      <td className="num">{turn.entered === null ? <span className="mem-same">未记录</span> : turn.memory_tokens !== null && turn.memory_tokens !== undefined ? `${tokens(turn.memory_tokens)} Token` : "—"}</td>
      <td>{change}</td>
    </tr>
    {open && <tr className="mem-compare-row"><td colSpan={5}><TurnMemory turn={turn} /></td></tr>}
  </>;
}

// 这一轮回答时模型拿到的对话记忆：摘要 + 保留的原文（压缩之后的状态），压缩的那一轮另外列出被压掉的原文。
function TurnMemory({ turn }: { turn: MemoryTimelineTurn }) {
  const kept = turn.kept_turns;
  const summaryNote = !turn.summary ? "" : turn.compressed ? "本轮新生成：旧摘要 + 新压掉的原文一起总结而成" : "沿用之前的摘要";
  return <div className="mem-turn-memory">
    <h4>第 {turn.index} 轮回答时，模型拿到的记忆{turn.compressed ? "（压缩之后）" : ""}</h4>
    <div className="mem-compare">
      <div><h5>摘要{summaryNote && <small>{summaryNote}</small>}</h5>
        {turn.summary ? <p className="mem-summary">{turn.summary}</p> : <div className="mem-empty">还没有压缩过，没有摘要。</div>}</div>
      <div><h5>保留的原文{kept && kept.length > 0 && <small>{kept.length} 轮</small>}</h5>
        {kept === null ? <div className="mem-empty">这一轮的记录里没有保存发给模型的原文。</div>
          : kept.length === 0 ? <div className="mem-empty">没有之前的问答原文{turn.summary ? "，之前的对话都在摘要里" : "，这是会话的第一轮"}。</div>
          : <TurnList turns={kept} rounds={turn.kept_rounds} />}</div>
    </div>
    {turn.compressed && <CompressInput turn={turn} />}
  </div>;
}

// 这一轮压缩时送给大模型总结的内容：旧摘要 + 新压掉的原文，总结成上面的新摘要。
// 不只是这几轮原文：旧摘要也一起送去重写，所以新摘要里还有更早的内容。
function CompressInput({ turn }: { turn: MemoryTimelineTurn }) {
  const dropped = turn.compressed_turns;
  const rounds = dropped?.map((item) => item.round).filter((value): value is number => typeof value === "number") ?? [];
  const droppedLabel = rounds.length ? `第 ${rounds.join("、")} 轮` : dropped?.length ? `${dropped.length} 轮` : "";
  const previous = turn.previous_summary;
  return <details className="mem-dropped">
    <summary>本次送去压缩的内容：{previous ? "旧摘要 + " : ""}新压掉的原文{droppedLabel && `（${droppedLabel}）`}</summary>
    <p className="mem-note">压缩时，大模型拿到的是「旧摘要 + 这次要压掉的原文」，把它们一起总结成一段新摘要（上面的「摘要」）。所以新摘要里除了这几轮，还有更早对话的要点。</p>
    <div className="mem-compare">
      <div><h5>旧摘要</h5>{previous === undefined || previous === null
        ? <div className="mem-empty">上一轮的记录里没有保存摘要。</div>
        : previous ? <ClampText label="摘" text={previous} /> : <div className="mem-empty">这是第一次压缩，没有旧摘要。</div>}</div>
      <div><h5>新压掉的原文{droppedLabel && <small>{droppedLabel}</small>}</h5>{dropped?.length
        ? <TurnList turns={dropped} rounds={dropped.map((item) => item.round ?? 0)} />
        : <div className="mem-empty">更早的记录里没有保存当时的记忆，看不到被压掉的原文。</div>}</div>
    </div>
  </details>;
}

const LONG_HINT = "每轮回答之后，系统在后台判断这一轮里有没有值得长期记住的、关于你本人的信息：回答偏好（详略、格式）、身份和职责（部门、负责的区域）、长期关注的主题。不记知识库里的内容，也不记手机号、证件号这类敏感信息。";

// 长期记忆：跨会话记住的用户偏好、身份和长期关注的主题。可以逐条删除、清空，也可以关闭（关闭后既不读也不记）。
function LongMemory({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [data, setData] = useState<LongMemoryView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    getLongMemory().then(setData).catch((reason: Error) => setError(reason.message));
  }, []);
  const run = async (action: () => Promise<LongMemoryView>) => {
    setBusy(true);
    setError("");
    try {
      setData(await action());
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const groups = data ? Object.entries(data.categories).map(([key, label]) => ({ key, label, items: data.items.filter((item) => item.category === key) })) : [];
  return <div className="mem-page">
    <header className="topbar mem-topbar">
      <div>
        <h1>记忆</h1>
        <MemoryTabs active="long" onNavigate={onNavigate} />
        <p className="mem-subtitle">跨会话记住的关于你本人的信息。新开一个会话，回答时也会参考它们：按你的偏好组织回答，理解「我负责的区域」这类说法。它们只用来调整回答方式，不会当成事实来源。只有你自己能看到。 <Hint text={LONG_HINT} /></p>
      </div>
    </header>
    {error && <div className="field-error">{error}</div>}
    {!data && !error && <LoadingSkeleton label="正在加载长期记忆"><SkeletonBlock className="mem-skeleton" /></LoadingSkeleton>}
    {data && <>
      <section className="mem-card long-switch">
        <label className="long-toggle">
          <input type="checkbox" checked={data.enabled} disabled={busy} onChange={(event) => void run(() => setLongMemoryEnabled(event.target.checked))} />
          <span className="long-toggle-track" aria-hidden="true"><span /></span>
          <span><strong>{data.enabled ? "已开启长期记忆" : "已关闭长期记忆"}</strong>
            <small>{data.enabled ? `每轮回答后自动整理，最多记 ${data.max_items} 条。` : "关闭后不再记新的内容，已有的记忆也不会发给模型；可以随时重新打开。"}</small></span>
        </label>
        {!data.global_enabled && <p className="long-notice">管理员在设置页关闭了长期记忆，目前所有用户都不会记录和使用长期记忆。</p>}
      </section>
      <section className="mem-card">
        <div className="long-head">
          <h2>记住的内容 <small>{data.items.length} / {data.max_items} 条</small></h2>
          {data.items.length > 0 && (confirmClear
            ? <span className="long-actions"><button type="button" className="danger-text" disabled={busy} onClick={() => { setConfirmClear(false); void run(clearLongMemory); }}>确认清空</button><button type="button" className="link-text" onClick={() => setConfirmClear(false)}>取消</button></span>
            : <button type="button" className="link-text" onClick={() => setConfirmClear(true)}>清空全部</button>)}
        </div>
        {data.items.length === 0 ? <div className="mem-empty">还没有长期记忆。聊天时说出你的偏好或身份，比如「以后回答先给结论」「我负责华东区售后」，之后在这里就能看到。</div>
          : groups.filter((group) => group.items.length > 0).map((group) => <div className="long-group" key={group.key}>
            <h3>{group.label}</h3>
            <ul>{group.items.map((item) => <LongMemoryRow key={item.id} item={item} busy={busy} onNavigate={onNavigate} onDelete={() => void run(() => deleteLongMemory(item.id))} />)}</ul>
          </div>)}
      </section>
    </>}
  </div>;
}

function LongMemoryRow({ item, busy, onNavigate, onDelete }: { item: LongMemoryItem; busy: boolean; onNavigate: (path: string) => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return <li>
    <span className="long-content">{item.content}</span>
    <span className="long-meta">{formatTime(item.updated ?? item.created)}{item.source_session && <> · <button type="button" className="link-text" onClick={() => onNavigate(`/memory/${encodeURIComponent(item.source_session ?? "")}`)}>来自这个会话</button></>}</span>
    {confirming
      ? <span className="long-actions"><button type="button" className="danger-text" disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>确认删除</button><button type="button" className="link-text" onClick={() => setConfirming(false)}>取消</button></span>
      : <button type="button" className="link-text" onClick={() => setConfirming(true)}>删除</button>}
  </li>;
}
