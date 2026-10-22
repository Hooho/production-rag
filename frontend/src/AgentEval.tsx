import { useState } from "react";
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
    <p className="ev-muted-note">同一套题，固定流程和 Agent 各跑一遍，比较的是<strong>最后拿到的资料里有没有题目预设的证据</strong>，判断方法相同。Agent 的回答这一步不评分。{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答。</p>
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
    <p className="ev-muted-note">Agent 每道题用一个新会话跑一遍，自己决定查几次、用什么词。这里只看它<strong>最后拿到的资料</strong>里有没有题目预设的证据（所有检索结果和读到的前后文合在一起）。Agent 的回答照样生成，但这一步不评分。{config && <> 本次配置：工具预算 {config.tool_budget} 次 · 超时 {config.timeout} 秒 · 提示词版本 {config.prompt_version}{config.model ? ` · ${config.model}` : ""}。</>}</p>
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
  return <div>
    <div className="ev-filters">
      <Chips value={typeFilter} options={[["all", "全部题型"], ...types.map((type): [string, string] => [type, type])]} onChange={setTypeFilter} />
      <Chips value={resultFilter} options={resultOptions} onChange={setResultFilter} />
      <span className="ev-filter-count">{visible.length} / {questions.length} 题</span>
    </div>
    <div className={`ag-q-columns ${hasFixed ? "" : "is-agent-only"}`} aria-hidden="true"><span>编号</span><span>问题</span>{hasFixed && <span>固定流程</span>}<span>Agent</span><span>检索次数</span><span>Agent 耗时</span><span /></div>
    <div className="ev-question-list">{visible.map((question) => {
      const open = expanded === question.id;
      const agent = question.agent;
      return <article className={`ev-question ${open ? "is-open" : ""}`} key={question.id}>
        <button className={`ag-q-head ${hasFixed ? "" : "is-agent-only"}`} aria-expanded={open} onClick={() => setExpanded(open ? null : question.id)}>
          <span className="ev-qid">{question.id}</span>
          <span className="ev-question-text">{question.question}<small>{question.type}{question.evidence_count > 1 ? ` · ${question.evidence_count} 条证据` : ""}{question.compare ? ` · ${COMPARE_LABELS[question.compare]}` : ""}</small></span>
          {hasFixed && <Verdict verdict={fixedVerdict(question)} />}
          <Verdict verdict={agentVerdict(question)} />
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

// 展开后：先列出题目预设的证据，每条注明两边各在哪里拿到；下面左右两栏是两边的检索日志。
function QuestionDetail({ question, hasFixed }: { question: EvalQuestion; hasFixed: boolean }) {
  const agent = question.agent;
  return <div className="ev-question-body">
    {agent?.error && <p className="ev-lost-hint">Agent 运行失败：{agent.error}</p>}
    {question.answerable ? <div className="ag-evidence-list">{(agent?.evidence ?? []).map((evidence, index) => {
      const fixed = question.evidence?.[index];
      const fixedFound = fixed?.status === "returned";
      return <div className="ag-evidence" key={index}>
        <p>证据 {index + 1}：“{evidence.text}”</p>
        {hasFixed && <span className={fixedFound ? "is-hit" : "is-miss"}>固定流程：{fixedFound ? `来源 ${fixed?.source_id ?? "—"}` : "没拿到"}</span>}
        <span className={evidence.found ? "is-hit" : "is-miss"}>Agent：{evidence.found ? evidence.where.map((item) => `第 ${item.call} 次调用 · ${item.evidence_id ?? "—"}`).join("、") : "没拿到"}</span>
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
  const sources = question.sources ?? [];
  return <section className="ag-log">
    <div className="ag-log-title">固定流程<small>检索一次 · 耗时 {formatMs(question.latency_ms)}</small></div>
    <div className="ag-call">
      <div className="ag-call-head"><span className="ag-tool">检索</span><span>检索词 {question.queries.map((query) => <code key={query}>{query}</code>)}</span></div>
      <div className="ag-call-meta">重排问题 <code>{question.rerank_query}</code> · {question.query_source === "rewrite_cache" ? "来自改写缓存" : "规则改写（未调用大模型）"}</div>
      {sources.length === 0 ? <p className="ag-muted">过滤后没有资料。</p> : sources.map((source) => <ResultItem key={source.id} id={source.id} title={source.title} heading={source.heading ?? null} text={source.text} hit={hitSources.has(source.id)} />)}
    </div>
  </section>;
}

function AgentLog({ question }: { question: EvalQuestion }) {
  const agent = question.agent!;
  return <section className="ag-log">
    <div className="ag-log-title">Agent<small>{agent.rounds} 轮 · 工具调用 {agent.tool_calls} 次 · 输入 {agent.prompt_tokens} token · 耗时 {formatMs(agent.latency_ms)} · {STOP_LABELS[agent.stop_reason ?? ""] ?? agent.stop_reason ?? "—"}</small></div>
    {agent.question_sent !== question.question && <div className="ag-call-meta">实际提问（多轮追问按规则补全）：{agent.question_sent}</div>}
    {agent.calls.length === 0 && <p className="ag-muted">没有调用任何工具，直接回答了。</p>}
    {agent.calls.map((call) => <AgentCall key={call.call} call={call} />)}
    <details className="ag-answer"><summary>Agent 的回答（这一步不评分）</summary><p>{agent.answer || "（没有回答）"}</p></details>
  </section>;
}

function AgentCall({ call }: { call: EvalAgentCall }) {
  const status = CALL_STATUS[call.status] ?? call.status;
  return <div className={`ag-call ${call.status !== "ok" ? "is-off" : ""}`}>
    <div className="ag-call-head">
      <span className="ag-tool">第 {call.call} 次 · {TOOL_LABELS[call.name] ?? call.name}</span>
      {call.name === "search_knowledge" && call.query !== undefined ? <span><code>{call.query}</code><small> {call.mode} · top_k {call.top_k}</small></span>
        : call.name === "read_context" && call.source_id ? <span>{call.source_id} 的{call.direction === "before" ? "前文" : "后文"}</span>
          : <span><code>{JSON.stringify(call.arguments)}</code></span>}
      {call.round !== null && <small className="ag-muted">第 {call.round} 轮</small>}
      {call.hits.length > 0 && <span className="ag-hit">命中证据 {call.hits.map((index) => index + 1).join("、")}</span>}
    </div>
    {status && <div className="ag-call-meta">{status}{call.error ? `：${call.error}` : ""}</div>}
    {call.note && call.status !== "ok" && <div className="ag-call-meta">{call.note}</div>}
    {call.results && (call.results.length === 0 ? <p className="ag-muted">没有返回资料（空检索）。</p>
      : call.results.map((result) => <ResultItem key={`${call.call}-${result.evidence_id}`} id={result.evidence_id} title={result.title} heading={result.heading ?? null} text={result.text} hit={result.hits.length > 0} relevance={result.relevance} low={result.low_relevance} />))}
    {call.name === "read_context" && call.text && <ClampText text={call.text} hit={(call.read_hits ?? []).length > 0} />}
  </div>;
}

function ResultItem({ id, title, heading, text, hit, relevance, low }: { id: string; title: string | null; heading: string | null; text: string; hit: boolean; relevance?: number | null; low?: boolean }) {
  return <div className={`ag-result ${hit ? "is-hit" : ""}`}>
    <div className="ag-result-head"><strong>{id}</strong><span>{title ?? "—"}{heading ? ` · ${heading}` : ""}</span>{relevance !== undefined && relevance !== null && <small>相关性 {relevance.toFixed(2)}{low ? "（较低）" : ""}</small>}{hit && <span className="ag-hit">含证据</span>}</div>
    <ClampText text={text} />
  </div>;
}

function ClampText({ text, hit }: { text: string; hit?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 120;
  return <div className={`ag-text ${hit ? "is-hit" : ""}`}>
    <p className={open || !long ? "is-open" : ""}>{text}</p>
    {long && <button type="button" className="ev-leak-toggle" onClick={() => setOpen(!open)}>{open ? "收起" : "展开更多"}<span aria-hidden="true">{open ? "↑" : "↓"}</span></button>}
  </div>;
}
