import { useEffect, useRef, useState } from "react";
import { type EvalAgentCall, type EvalCompareKey, type EvalMode, type EvalQuestion, type EvalRun, type EvalRunBrief, type EvalSummary } from "./api";
import { formatDuration as formatMs } from "./format";

// Agent 检索评测的结果页（后端 app/evaluation/agent_retrieval.py）。
// Agent 每道题用新会话跑一遍，只看它最后拿到的资料里有没有证据（最后命中），口径和固定流程的「过滤后 Recall」一致；
// 答案照样生成，但这一步不评分。和固定流程一起跑时，逐题对比两边是否命中，点开看两边的检索日志。

export function runModes(run: EvalRunBrief): EvalMode[] {
  return run.config.modes && run.config.modes.length ? run.config.modes : ["fixed"];
}

export function modesLabel(run: EvalRunBrief) {
  const modes = runModes(run);
  if (modes.length === 2) return "固定流程 + Agent";
  return modes[0] === "agent" ? "Agent" : "固定流程";
}

const COMPARE_LABELS: Record<EvalCompareKey, string> = {
  agent_only: "只有 Agent 命中", fixed_only: "只有固定流程命中", neither: "都没命中", both: "都命中",
};
const COMPARE_HINTS: Record<EvalCompareKey, string> = {
  agent_only: "Agent 多查几次或换词找到了，固定流程没找到",
  fixed_only: "固定流程找到了，Agent 没找到：重点看这一类",
  neither: "两边都没拿到全部证据",
  both: "两边都拿到了全部证据",
};
const STOP_LABELS: Record<string, string> = {
  answered: "正常回答", budget: "工具预算用完，强制回答", timeout: "超时，强制回答", demo: "演示模式",
};
const TOOL_LABELS: Record<string, string> = {
  search_knowledge: "检索知识库", read_context: "读前后文", lookup_order: "查订单", query_data: "查业务数据",
};
const SEARCH_MODE_LABELS: Record<string, string> = { hybrid: "混合检索", vector: "向量检索", keyword: "关键词检索" };
const CALL_STATUS: Record<string, string> = { ok: "", error: "出错", duplicate: "和之前的调用相同，没有执行", skipped: "预算用完，没有执行" };

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function number(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined ? "—" : String(Math.round(value * 10 ** digits) / 10 ** digits);
}

// 一道题 Agent 的结果：能回答的题看证据拿到多少；无法回答的题看有没有拿到资料（拿到了就可能硬凑答案）。
function agentVerdict(question: EvalQuestion) {
  const agent = question.agent;
  if (!agent) return { key: "none", label: "—" };
  if (agent.status !== "completed") return { key: "bad", label: "运行失败" };
  if (!question.answerable) return agent.returned === 0 ? { key: "good", label: "没拿到资料" } : { key: "warn", label: `拿到 ${agent.returned} 段` };
  const recall = agent.recall ?? 0;
  if (recall >= 1) return { key: "good", label: "命中" };
  if (recall > 0) return { key: "warn", label: `部分 ${percent(recall)}` };
  return { key: "bad", label: "未命中" };
}

function fixedVerdict(question: EvalQuestion) {
  if (!question.stages) return { key: "none", label: "—" };
  if (!question.answerable) return question.returned === 0 ? { key: "good", label: "没拿到资料" } : { key: "warn", label: `拿到 ${question.returned} 段` };
  const recall = question.stages.final.recall ?? 0;
  if (recall >= 1) return { key: "good", label: "命中" };
  if (recall > 0) return { key: "warn", label: `部分 ${percent(recall)}` };
  return { key: "bad", label: "未命中" };
}

function Verdict({ verdict }: { verdict: { key: string; label: string } }) {
  if (verdict.key === "none") return <span className="ag-muted">—</span>;
  return <span className={`ev-verdict is-${verdict.key}`}><b>{verdict.key === "good" ? "✓" : verdict.key === "warn" ? "◐" : "✕"}</b>{verdict.label}</span>;
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="ev-card"><span className="ev-card-label">{label}</span><strong className="ev-card-value">{value}</strong>{note && <div className="ev-card-explanation"><span>{note}</span></div>}</div>;
}

// 「对比」页签（固定流程和 Agent 一起跑时默认打开）：两边的核心指标左右并排，下面是逐题对比，点开看两边的检索日志。
export function ComparePanel({ run }: { run: EvalRun }) {
  const summary: EvalSummary = run.summary ?? {};
  const rows: [string, string, string, string][] = [
    ["资料命中率", percent(summary.recall_final), percent(summary.agent_recall), "能回答的题里，最后拿到的资料包含的证据比例（固定流程是阈值过滤后的来源，Agent 是所有检索结果和读到的前后文合起来）"],
    ["误杀率", percent(summary.false_reject_rate), percent(summary.agent_false_reject_rate), "能回答的题里，一段资料都没拿到的比例（越低越好）"],
    ["漏放率", percent(summary.false_accept_rate), percent(summary.agent_false_accept_rate), "无法回答的题里，仍然拿到了资料的比例（越低越好）"],
    ["平均检索次数", "1", number(summary.agent_avg_searches), "固定流程每题检索一次；Agent 自己决定查几次"],
    ["平均耗时", formatMs(summary.latency_avg_ms), formatMs(summary.agent_latency_avg_ms), "固定流程只算检索（召回 + 重排）；Agent 包括多轮模型调用和写回答"],
    ["平均输入 token", "0", number(summary.agent_avg_prompt_tokens, 0), "固定流程检索不调用大模型"],
  ];
  return <div className="ev-overview ag-eval">
    <p className="ev-muted-note">同一套题，固定流程和 Agent 各跑一遍，比较的是<strong>最后拿到的资料里有没有题目预设的证据</strong>，判断方法相同。{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答。</p>
    <div className="diag-table-wrap"><table className="diag-table ev-table ag-compare-table">
      <thead><tr><th>指标</th><th className="num">固定流程</th><th className="num">Agent</th><th>说明</th></tr></thead>
      <tbody>{rows.map(([label, fixed, agent, hint]) => <tr key={label}><td>{label}</td><td className="num">{fixed}</td><td className="num">{agent}</td><td className="ag-muted">{hint}</td></tr>)}</tbody>
    </table></div>
    {run.comparison && <>
      <div className="ev-section-title">逐题对比<small>能回答的题，证据全部拿到算命中</small></div>
      <div className="ev-cards">{(Object.keys(COMPARE_LABELS) as EvalCompareKey[]).map((key) => <Card key={key} label={COMPARE_LABELS[key]} value={`${run.comparison?.[key] ?? 0} 题`} note={COMPARE_HINTS[key]} />)}</div>
    </>}
    <div className="ev-section-title">按题目类型<small>资料命中率</small></div>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th>题型</th><th className="num">题数</th><th className="num">固定流程</th><th className="num">Agent</th><th className="num">Agent 平均检索次数</th></tr></thead>
      <tbody>{Object.entries(run.by_type ?? {}).map(([type, row]) => <tr key={type}>
        <td>{type}</td><td className="num">{row.count ?? row.agent_count ?? "—"}</td><td className="num">{percent(row.recall_final)}</td>
        <td className="num">{percent(row.agent_recall)}</td><td className="num">{number(row.agent_avg_searches)}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="ev-section-title">逐题<small>点开看两边的检索日志</small></div>
    <AgentQuestionList run={run} hasFixed />
  </div>;
}

// 「Agent」页签：Agent 自己的命中、检索过程和成本，逐题只看 Agent 的检索日志。
export function AgentPanel({ run }: { run: EvalRun }) {
  const summary: EvalSummary = run.summary ?? {};
  const config = run.config.agent;
  return <div className="ev-overview ag-eval">
    <p className="ev-muted-note">Agent 每道题用一个新会话跑一遍，自己决定查几次、用什么词。这里只看它<strong>最后拿到的资料</strong>里有没有题目预设的证据（所有检索结果和读到的前后文合在一起）。{config && <> 本次配置：工具预算 {config.tool_budget} 次 · 超时 {config.timeout} 秒 · 提示词版本 {config.prompt_version}{config.model ? ` · ${config.model}` : ""}。</>}</p>
    <div className="ev-section-title">命中<small>{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答</small></div>
    <div className="ev-cards">
      <Card label="资料命中率" value={percent(summary.agent_recall)} note="能回答的题里，拿到的证据比例" />
      <Card label="误杀率" value={percent(summary.agent_false_reject_rate)} note="能回答的题里一段资料都没拿到的比例" />
      <Card label="漏放率" value={percent(summary.agent_false_accept_rate)} note="无法回答的题里拿到了资料的比例" />
      {summary.agent_failed ? <Card label="运行失败" value={`${summary.agent_failed} 题`} note="模型调用失败等，点逐题看原因" /> : null}
    </div>
    <div className="ev-section-title">检索过程<small>每题平均</small></div>
    <div className="ev-cards">
      <Card label="检索次数" value={number(summary.agent_avg_searches)} note={`其中空检索 ${number(summary.agent_avg_empty_searches)} 次`} />
      <Card label="读前后文" value={number(summary.agent_avg_reads)} />
      <Card label="工具调用" value={number(summary.agent_avg_tool_calls)} note={`重复调用被拦下 ${summary.agent_duplicates ?? 0} 次`} />
      <Card label="模型轮数" value={number(summary.agent_avg_rounds)} note={`强制回答 ${summary.agent_forced ?? 0} 题 · 引用重写 ${summary.agent_citation_retried ?? 0} 题`} />
    </div>
    <div className="ev-section-title">成本<small>每题平均</small></div>
    <div className="ev-cards">
      <Card label="输入 token" value={number(summary.agent_avg_prompt_tokens, 0)} note={`缓存命中 ${percent(summary.agent_cache_hit_rate)}`} />
      <Card label="输出 token" value={number(summary.agent_avg_completion_tokens, 0)} />
      <Card label="耗时" value={formatMs(summary.agent_latency_avg_ms)} note={`P95 ${formatMs(summary.agent_latency_p95_ms)}`} />
    </div>
    <div className="ev-section-title">按题目类型</div>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th>题型</th><th className="num">题数</th><th className="num">资料命中率</th><th className="num">平均检索次数</th><th className="num">平均耗时</th></tr></thead>
      <tbody>{Object.entries(run.by_type ?? {}).map(([type, row]) => <tr key={type}>
        <td>{type}</td><td className="num">{row.count ?? row.agent_count ?? "—"}</td>
        <td className="num">{percent(row.agent_recall)}</td><td className="num">{number(row.agent_avg_searches)}</td><td className="num">{formatMs(row.agent_latency_avg_ms)}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="ev-section-title">逐题<small>点开看 Agent 的检索日志</small></div>
    <AgentQuestionList run={run} hasFixed={false} />
  </div>;
}

// Agent 在第几次调用拿到了证据（去重、按顺序），例如 [1, 3]。
function agentHitCalls(question: EvalQuestion) {
  const calls = new Set<number>();
  for (const evidence of question.agent?.evidence ?? []) for (const where of evidence.where) calls.add(where.call);
  return [...calls].sort((a, b) => a - b);
}

function AgentQuestionList({ run, hasFixed }: { run: EvalRun; hasFixed: boolean }) {
  const questions = run.questions ?? [];
  const [typeFilter, setTypeFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const types: string[] = [];
  for (const question of questions) if (!types.includes(question.type)) types.push(question.type);
  const resultOptions: [string, string][] = hasFixed
    ? [["all", "全部"], ["agent_only", COMPARE_LABELS.agent_only], ["fixed_only", COMPARE_LABELS.fixed_only], ["neither", COMPARE_LABELS.neither], ["both", COMPARE_LABELS.both], ["unanswerable", "无法回答的题"]]
    : [["all", "全部"], ["problem", "只看有问题"], ["good", "只看通过"]];
  const visible = questions.filter((question) => {
    if (typeFilter !== "all" && question.type !== typeFilter) return false;
    if (resultFilter === "all") return true;
    if (resultFilter === "unanswerable") return !question.answerable;
    if (resultFilter === "problem") return agentVerdict(question).key !== "good";
    if (resultFilter === "good") return agentVerdict(question).key === "good";
    return question.compare === resultFilter;
  });
  const layout = hasFixed ? "" : "is-agent-only";
  // 表头吸顶后加阴影：在表头前放一个 1px 的标记，标记滚到表头上方，说明表头已经贴在顶部了。
  // 页面的滚动可能发生在某个内层容器里，所以在捕获阶段监听所有滚动。
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    function check() {
      if (!sentinel.current || !header.current) return;
      setStuck(sentinel.current.getBoundingClientRect().top < header.current.getBoundingClientRect().top - 1);
    }
    check();
    document.addEventListener("scroll", check, true);
    window.addEventListener("resize", check);
    return () => {
      document.removeEventListener("scroll", check, true);
      window.removeEventListener("resize", check);
    };
  }, []);
  return <div>
    <div className="ev-filters">
      <Chips value={typeFilter} options={[["all", "全部题型"], ...types.map((type): [string, string] => [type, type])]} onChange={setTypeFilter} />
      <Chips value={resultFilter} options={resultOptions} onChange={setResultFilter} />
      <span className="ev-filter-count">{visible.length} / {questions.length} 题</span>
    </div>
    {/* 表头固定在顶部：题目多、展开详情后往下翻，仍然知道每一列是什么。 */}
    <div ref={sentinel} className="ag-sticky-sentinel" aria-hidden="true" />
    <div ref={header} className={`ag-q-columns ${layout} ${stuck ? "is-stuck" : ""}`} aria-hidden="true"><span>编号</span><span>问题</span>{hasFixed && <><span>固定流程</span><span>固定流程耗时</span></>}<span>Agent</span><span>Agent 检索次数</span><span>Agent 耗时</span><span /></div>
    <div className="ev-question-list">{visible.map((question) => {
      const open = expanded === question.id;
      const agent = question.agent;
      const hitCalls = agentHitCalls(question);
      return <article className={`ev-question ${open ? "is-open" : ""}`} key={question.id}>
        <button className={`ag-q-head ${layout}`} aria-expanded={open} onClick={() => setExpanded(open ? null : question.id)}>
          <span className="ev-qid">{question.id}</span>
          <span className="ev-question-text">{question.question}<small>{question.type}{question.evidence_count > 1 ? ` · ${question.evidence_count} 条证据` : ""}{question.compare ? ` · ${COMPARE_LABELS[question.compare]}` : ""}</small></span>
          {hasFixed && <><Verdict verdict={fixedVerdict(question)} /><span className="ag-num">{formatMs(question.latency_ms)}</span></>}
          <span className="ag-verdict-cell"><Verdict verdict={agentVerdict(question)} />{hitCalls.length > 0 && <small>第 {hitCalls.join("、")} 次调用命中</small>}</span>
          <span className="ag-num">{agent ? `${agent.searches} 次` : "—"}</span>
          <span className="ag-num">{agent ? formatMs(agent.latency_ms) : "—"}</span>
          <span className="collapse-icon">{open ? "−" : "＋"}</span>
        </button>
        {open && <QuestionDetail question={question} hasFixed={hasFixed} />}
      </article>;
    })}</div>
  </div>;
}

function Chips({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <div className="ev-chips" role="group">{options.map(([key, label]) => <button key={key} className={value === key ? "active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>{label}</button>)}</div>;
}

// 分块 id 很长（UUID），页面上只显示前 8 位，鼠标悬停看完整 id。
function shortChunk(chunkId: string | null | undefined) {
  return chunkId ? chunkId.slice(0, 8) : "—";
}

// 一个分块：编号做成标签，命中证据的标签有背景色；点标签才显示内容。
type ChunkItem = { key: string; id: string; chunkId?: string | null; title: string | null; heading: string | null; text: string; relevance?: number | null; low?: boolean; hit: boolean };

function ChunkTabs({ items, empty }: { items: ChunkItem[]; empty: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (items.length === 0) return <p className="ag-muted">{empty}</p>;
  const current = items.find((item) => item.key === selected) ?? null;
  return <div className="ag-chunks">
    <div className="ag-chunk-tabs" role="tablist">{items.map((item) => <button key={item.key} type="button" role="tab" aria-selected={selected === item.key}
      className={`ag-chunk-tab ${item.hit ? "is-hit" : ""} ${selected === item.key ? "is-active" : ""}`}
      title={item.hit ? "这个分块包含证据" : item.title ?? ""} onClick={() => setSelected(selected === item.key ? null : item.key)}>{item.id}</button>)}</div>
    {current && <div className={`ag-chunk-body ${current.hit ? "is-hit" : ""}`}>
      <div className="ag-chunk-meta"><strong>{current.id}</strong>{current.chunkId && <code title={current.chunkId}>分块 {shortChunk(current.chunkId)}</code>}{current.title ?? "—"}{current.heading ? ` · ${current.heading}` : ""}{current.relevance !== undefined && current.relevance !== null && <small> · 相关性 {current.relevance.toFixed(2)}{current.low ? "（较低）" : ""}</small>}{current.hit && <span className="ag-hit">含证据</span>}</div>
      <p>{current.text}</p>
    </div>}
  </div>;
}

// 展开后：先说每条证据在哪个分块（两边各自的编号，Agent 还标第几次调用），下面左右两栏只列分块编号。
function QuestionDetail({ question, hasFixed }: { question: EvalQuestion; hasFixed: boolean }) {
  const agent = question.agent;
  return <div className="ev-question-body">
    {agent?.error && <p className="ev-lost-hint">Agent 运行失败：{agent.error}</p>}
    {question.answerable ? <div className="ag-evidence-list">{(agent?.evidence ?? []).map((evidence, index) => {
      const fixed = question.evidence?.[index];
      const fixedFound = fixed?.status === "returned";
      const chunkIds = evidence.chunk_ids?.length ? evidence.chunk_ids : fixed?.chunk_id ? [fixed.chunk_id] : [];
      return <div className="ag-evidence" key={index}>
        <p>证据 {index + 1}：“{evidence.text}”</p>
        <span className="ag-evidence-chunk">所属分块 {chunkIds.length ? chunkIds.map((chunkId) => <code key={chunkId} title={chunkId}>{shortChunk(chunkId)}</code>) : "知识库里没找到"}</span>
        {hasFixed && <span className={fixedFound ? "is-hit" : "is-miss"}>固定流程：{fixedFound ? `在 ${fixed?.source_id ?? "—"}` : "没拿到"}</span>}
        <span className={evidence.found ? "is-hit" : "is-miss"}>Agent：{evidence.found ? evidence.where.map((item) => `第 ${item.call} 次调用的 ${item.evidence_id ?? "—"}`).join("、") : "没拿到"}</span>
      </div>;
    })}</div> : <p className="ev-muted-note">这道题知识库里没有答案，没有预设证据；拿到的资料越少越好（拿到了模型可能硬凑答案）。</p>}
    <div className={`ag-columns ${hasFixed ? "" : "is-single"}`}>
      {hasFixed && <FixedLog question={question} />}
      {agent && <AgentLog question={question} />}
    </div>
  </div>;
}

function FixedLog({ question }: { question: EvalQuestion }) {
  const hitSources = new Set((question.evidence ?? []).filter((item) => item.status === "returned").map((item) => item.source_id));
  const items: ChunkItem[] = (question.sources ?? []).map((source) => ({ key: source.id, id: source.id, chunkId: (source as { chunk_id?: string }).chunk_id ?? null, title: source.title,
    heading: source.heading ?? null, text: source.text, hit: hitSources.has(source.id) }));
  return <section className="ag-log">
    <div className="ag-log-title">固定流程<small>检索 1 次 · 耗时 {formatMs(question.latency_ms)}</small></div>
    <div className="ag-call">
      <div className="ag-call-head"><span className="ag-tool">检索</span>{question.queries.map((query) => <code key={query}>{query}</code>)}
        <span className="ag-tag">混合检索</span><span className="ag-tag">耗时 {formatMs(question.latency_ms)}</span>{hitSources.size > 0 && <span className="ag-hit">命中</span>}</div>
      <ChunkTabs items={items} empty="过滤后没有分块。" />
    </div>
  </section>;
}

function AgentLog({ question }: { question: EvalQuestion }) {
  const agent = question.agent!;
  return <section className="ag-log">
    <div className="ag-log-title">Agent<small>检索 {agent.searches} 次 · {agent.rounds} 轮 · {agent.prompt_tokens} token · 耗时 {formatMs(agent.latency_ms)} · {STOP_LABELS[agent.stop_reason ?? ""] ?? agent.stop_reason ?? "—"}</small></div>
    {agent.question_sent !== question.question && <div className="ag-call-meta">实际提问（多轮追问按规则补全）：{agent.question_sent}</div>}
    {agent.calls.length === 0 && <p className="ag-muted">没有调用任何工具，直接回答了。</p>}
    {agent.calls.map((call) => <AgentCall key={call.call} call={call} />)}
  </section>;
}

function AgentCall({ call }: { call: EvalAgentCall }) {
  const status = CALL_STATUS[call.status] ?? call.status;
  const hit = call.hits.length > 0;
  let items: ChunkItem[] = [];
  if (call.results) items = call.results.map((result) => ({ key: `${call.call}-${result.evidence_id}`, id: result.evidence_id, chunkId: result.chunk_id, title: result.title,
    heading: result.heading ?? null, text: result.text, relevance: result.relevance, low: result.low_relevance, hit: result.hits.length > 0 }));
  else if (call.name === "read_context" && call.text) items = [{ key: `${call.call}-read`, id: `${call.source_id ?? ""} ${call.direction === "before" ? "前文" : "后文"}`,
    title: null, heading: null, text: call.text, hit: (call.read_hits ?? []).length > 0 }];
  return <div className={`ag-call ${call.status !== "ok" ? "is-off" : ""} ${hit ? "is-hit" : ""}`}>
    <div className="ag-call-head">
      <span className="ag-tool">第 {call.call} 次 · {TOOL_LABELS[call.name] ?? call.name}</span>
      {call.name === "search_knowledge" && call.query !== undefined ? <><code>{call.query}</code>
        <span className="ag-tag">{SEARCH_MODE_LABELS[call.mode ?? ""] ?? call.mode}</span><span className="ag-tag">Top K {call.top_k}</span></>
        : call.name === "read_context" && call.source_id ? <span>{call.source_id} 的{call.direction === "before" ? "前文" : "后文"}</span>
          : <code>{JSON.stringify(call.arguments)}</code>}
      {call.duration_ms !== undefined && call.duration_ms !== null && <span className="ag-tag">耗时 {formatMs(call.duration_ms)}</span>}
      {hit && <span className="ag-hit">命中证据 {call.hits.map((index) => index + 1).join("、")}</span>}
    </div>
    {status && <div className="ag-call-meta">{status}{call.error ? `：${call.error}` : ""}</div>}
    {call.note && call.status !== "ok" && <div className="ag-call-meta">{call.note}</div>}
    {(call.results || call.name === "read_context") && <ChunkTabs items={items} empty={call.results ? "没有返回分块（空检索）。" : "没有读到内容。"} />}
  </div>;
}
