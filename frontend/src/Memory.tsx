import { useEffect, useState, type ReactNode } from "react";
import { getMemorySession, listMemorySessions, type MemorySessionDetail, type MemorySessionList, type MemoryTimelineTurn, type MemoryTurnText } from "./api";
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

function Hint({ text }: { text: string }) {
  return <span className="mem-hint" tabIndex={0} aria-label={text}>?<span className="mem-hint-bubble" role="tooltip">{text}</span></span>;
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

export default function Memory({ sessionId, onNavigate }: { sessionId: string | null; onNavigate: (path: string) => void }) {
  return sessionId ? <MemoryDetail sessionId={sessionId} onBack={() => onNavigate("/memory")} /> : <MemoryList onOpen={(id) => onNavigate(`/memory/${encodeURIComponent(id)}`)} />;
}

function MemoryList({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [data, setData] = useState<MemorySessionList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    listMemorySessions().then(setData).catch((reason: Error) => setError(reason.message));
  }, []);
  return <div className="mem-page">
    <header className="topbar mem-topbar">
      <div>
        <h1>会话记忆</h1>
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
  const entered = data ? data.timeline.filter((turn) => turn.entered) : [];
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
        <p className="mem-note">每一轮的问题、检索前被补成了什么、回答前记忆有多大。标着「压缩」的那一轮可以展开，对比被压掉的原文和生成的摘要。</p>
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
    {rounds?.[index] && <span className="mem-round">第 {rounds[index]} 轮</span>}
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
  if (!turn.entered) change = <span className="mem-tag is-muted" title="订单查询、数据查询、问候和没检索到资料的问题不经过回答模型，不会写进对话记忆">未写入记忆</span>;
  else if (turn.compressed) change = <button type="button" className="mem-tag is-compress" onClick={() => setOpen(!open)} aria-expanded={open}>压缩 {open ? "▴" : "▾"}</button>;
  else change = <span className="mem-tag">追加</span>;
  return <>
    <tr className={open ? "is-open" : ""}>
      <td className="num">{turn.index}</td>
      <td>{turn.question}</td>
      <td className={turn.rewritten && turn.rewritten !== turn.question ? "mem-rewritten" : "mem-same"}>{turn.rewritten ? (turn.rewritten === turn.question ? "（不用改写）" : turn.rewritten) : "—"}</td>
      <td className="num">{turn.entered && turn.memory_tokens !== null ? `${tokens(turn.memory_tokens)} Token` : "—"}</td>
      <td>{change}</td>
    </tr>
    {open && <tr className="mem-compare-row"><td colSpan={5}>
      <div className="mem-compare">
        <div><h4>被压掉的原文</h4>{turn.compressed_turns?.length ? <TurnList turns={turn.compressed_turns} /> : <div className="mem-empty">更早的记录里没有保存当时的记忆，看不到被压掉的原文。</div>}</div>
        <div><h4>生成的摘要</h4>{turn.summary ? <p className="mem-summary">{turn.summary}</p> : <div className="mem-empty">没有记录到摘要内容。</div>}</div>
      </div>
    </td></tr>}
  </>;
}
