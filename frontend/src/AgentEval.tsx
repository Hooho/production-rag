import { useEffect, useRef, useState } from "react";
import { type EvalAgentCall, type EvalCompareKey, type EvalMode, type EvalQuestion, type EvalRun, type EvalRunBrief, type EvalSpecialQuestion, type EvalSpecialSection, type EvalSummary } from "./api";
import { formatDuration as formatMs } from "./format";

// Agent 检索评测的结果页（后端 app/evaluation/agent_retrieval.py）。
// Agent 每道题用新会话跑一遍，只看它最后拿到的资料里有没有证据（最后命中），口径和固定流程的「交给模型的资料命中率」一致
// （两边都算父块扩展拼进来的相邻分片，Agent 另外加上读前后文读到的）；
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

// 一道题的检索词是谁给的。
export function rewriteLabel(question: { rewrite?: EvalQuestion["rewrite"]; query_source?: string }) {
  const classifier = question.rewrite?.classifier ?? question.query_source;
  if (classifier === "llm") return question.rewrite?.cached ? "大模型改写（来自改写缓存）" : "大模型改写";
  if (classifier === "small_model") return "本地小模型只分类不改写，用原问题检索";
  if (classifier === "rewrite_cache") return "来自改写缓存";
  return "规则（未调用大模型）";
}

function fixedVerdict(question: EvalQuestion) {
  if (!question.stages) return { key: "none", label: "—" };
  if (!question.answerable) return question.returned === 0 || question.cleared ? { key: "good", label: question.cleared ? "被清空，没拿到资料" : "没拿到资料" } : { key: "warn", label: `拿到 ${question.sufficiency?.source_count ?? question.returned} 段` };
  // 被充分性判断清空：模型什么资料都拿不到。
  if (question.cleared) return { key: "bad", label: "被清空" };
  // 和 Agent 比较时按「最终交给模型的资料」（含父块扩展、补充检索）算；旧记录没有，用过滤后 Recall。
  const recall = question.given_recall ?? question.stages.final.recall ?? 0;
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
    ["资料命中率", percent(summary.recall_given ?? summary.recall_final), percent(summary.agent_recall), "能回答的题里，最后交给模型的资料包含的证据比例。两边都算父块扩展拼进来的相邻分片：固定流程是充分性判断之后最终交给模型的（可能用了补充检索，被判资料不足就清空），Agent 是所有检索结果加上读前后文读到的"],
    ["误杀率", percent(summary.false_reject_rate), percent(summary.agent_false_reject_rate), "能回答的题里，一段资料都没拿到的比例（越低越好）"],
    ["漏放率", percent(summary.false_accept_rate), percent(summary.agent_false_accept_rate), "无法回答的题里，仍然拿到了资料的比例（越低越好）"],
    ["平均检索次数", summary.retry_rate !== undefined && summary.retry_rate !== null ? number(1 + summary.retry_rate) : "1", number(summary.agent_avg_searches), "固定流程每题检索一次，充分性判断觉得不够时再补充检索一次；Agent 自己决定查几次"],
    ["平均无新增检索", "—", number(summary.agent_avg_wasted_searches), `Agent 的检索里，一个新分块都没拿到的次数（反复拿回同一批分块，越低越好）；占全部检索 ${percent(summary.agent_wasted_rate)}`],
    summary.flow_latency_avg_ms !== undefined && summary.flow_latency_avg_ms !== null
      ? ["平均耗时", formatMs(summary.flow_latency_avg_ms), formatMs(summary.agent_latency_avg_ms), "固定流程算改写、检索、充分性判断和补充检索（改写用了缓存时按当时实际花的时间）；Agent 包括它所有轮次的模型调用和写回答，固定流程没算写回答那一次"]
      : ["平均耗时", formatMs(summary.latency_avg_ms), formatMs(summary.agent_latency_avg_ms), "口径不同：这次固定流程只算检索（召回 + 重排，旧口径），没算意图识别、充分性判断和写回答；Agent 包括它所有轮次的模型调用和写回答"],
    ["平均输入 token", "—", number(summary.agent_avg_prompt_tokens, 0), "固定流程改写和充分性判断的 token 没有记录（每题 1～3 次大模型调用）；Agent 是所有轮次加起来的"],
  ];
  return <div className="ev-overview ag-eval">
    <p className="ev-muted-note">同一套题，固定流程和 Agent 各跑一遍，比较的是<strong>最后交给模型的资料里有没有题目预设的证据</strong>，判断方法相同（都算父块扩展拼进来的相邻分片）。{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答。</p>
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
        <td>{type}</td><td className="num">{row.count ?? row.agent_count ?? "—"}</td><td className="num">{percent(row.recall_given ?? row.recall_final)}</td>
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
      <Card label="无新增检索" value={number(summary.agent_avg_wasted_searches)} note={`一个新分块都没拿到的检索，占全部检索 ${percent(summary.agent_wasted_rate)}（越低越好）`} />
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

// 每次调用新拿到了哪些分块（之前的调用没拿到过的），以及一个新分块都没拿到的检索有几次。
// 后端从这次起会记 new_chunks / wasted_searches；旧记录没有，就按每次调用的 chunk_ids 现算，结果一样。
function freshness(question: EvalQuestion) {
  const seen = new Set<string>();
  const perCall = new Map<number, Set<string>>();
  let wasted = 0;
  for (const call of question.agent?.calls ?? []) {
    const fresh = new Set(call.chunk_ids.filter((chunkId) => !seen.has(chunkId)));
    fresh.forEach((chunkId) => seen.add(chunkId));
    perCall.set(call.call, fresh);
    if (call.name === "search_knowledge" && (call.status === "ok" || call.status === "error") && (call.new_chunks ?? fresh.size) === 0) wasted += 1;
  }
  return { perCall, wasted: question.agent?.wasted_searches ?? wasted };
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
          <span className="ev-question-text">{question.question}<small>{question.type}{question.evidence_count > 1 ? ` · ${question.evidence_count} 条证据` : ""}{question.compare ? ` · ${COMPARE_LABELS[question.compare]}` : ""}{question.note ? ` · ${question.note}` : ""}</small></span>
          {hasFixed && <><Verdict verdict={fixedVerdict(question)} /><span className="ag-num">{formatMs(question.flow_latency_ms ?? question.latency_ms)}</span></>}
          <span className="ag-verdict-cell"><Verdict verdict={agentVerdict(question)} />{hitCalls.length > 0 && <small>第 {hitCalls.join("、")} 次调用命中</small>}</span>
          <span className="ag-num ag-search-cell">{agent ? `${agent.searches} 次` : "—"}{agent && freshness(question).wasted > 0 && <small>{freshness(question).wasted} 次无新增</small>}</span>
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

// 分块编号：分块在文档里的序号，显示成「第 N 片」，和知识库页面一致，不随检索变化。
// S1、S2 只是某一次检索返回结果的顺序编号（交给模型引用用），每次检索都从 S1 开始，不能拿来对照。
// 旧记录没有序号时，从分块 id 取：分块 id 是「文档 id:序号」（app/storage.py），冒号后面就是序号；
// 原来取 id 的前 8 位，那其实是文档 id，同一份文档的分块全都一样。
function chunkLabel(position: number | null | undefined, chunkId?: string | null) {
  if (typeof position === "number") return `第 ${position + 1} 片`;
  const index = chunkId?.match(/:(\d+)$/)?.[1];
  if (index !== undefined) return `第 ${Number(index) + 1} 片`;
  return chunkId ?? "—";
}

// 一个分块：编号做成标签，命中证据的标签有背景色；点标签才显示内容。
type ChunkItem = { key: string; id: string; chunkId?: string | null; position?: number | null; parts?: string[]; evidenceParts?: Set<string>; fresh?: boolean; title: string | null; heading: string | null; text: string; relevance?: number | null; low?: boolean; hit: boolean };

// 父块扩展：检索命中的是一片，父块扩展会把同一父块里相邻的几片一起拼进来交给模型。
// 拼进来的那几片标成「扩展」（虚线框），方便看出证据是检索直接命中的，还是靠扩展带进来的。
function extendedParts(item: ChunkItem) {
  return (item.parts ?? []).filter((chunkId) => chunkId !== item.chunkId);
}

function chunkIndex(chunkId: string) {
  const index = Number(chunkId.match(/:(\d+)$/)?.[1]);
  return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

function PartsRow({ item }: { item: ChunkItem }) {
  const parts = [...(item.parts ?? [])].sort((a, b) => chunkIndex(a) - chunkIndex(b));
  return <div className="ag-parts">
    <span>交给模型的是这几片拼起来的内容：</span>
    {parts.map((chunkId) => {
      const extended = chunkId !== item.chunkId;
      const evidence = item.evidenceParts?.has(chunkId);
      return <span key={chunkId} title={chunkId} className={`ag-part ${extended ? "is-ext" : "is-main"} ${evidence ? "is-hit" : ""}`}>
        {chunkLabel(null, chunkId)}<small>{extended ? "扩展" : "检索命中"}{evidence ? " · 含证据" : ""}</small></span>;
    })}
  </div>;
}

function ChunkTabs({ items, empty }: { items: ChunkItem[]; empty: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (items.length === 0) return <p className="ag-muted">{empty}</p>;
  const current = items.find((item) => item.key === selected) ?? null;
  return <div className="ag-chunks">
    <div className="ag-chunk-tabs" role="tablist">{items.map((item) => <button key={item.key} type="button" role="tab" aria-selected={selected === item.key}
      className={`ag-chunk-tab ${item.hit ? "is-hit" : ""} ${item.fresh ? "is-new" : ""} ${selected === item.key ? "is-active" : ""}`}
      title={[item.hit ? (extendedParts(item).some((chunkId) => item.evidenceParts?.has(chunkId)) && !(item.chunkId && item.evidenceParts?.has(item.chunkId)) ? "证据在父块扩展拼进来的分片里" : "这个分块包含证据") : item.title ?? "",
        extendedParts(item).length ? `父块扩展还拼进了 ${extendedParts(item).map((chunkId) => chunkLabel(null, chunkId)).join("、")}` : "",
        item.fresh ? "这次调用新拿到的（前面的调用没拿到过）" : ""].filter(Boolean).join("；")} onClick={() => setSelected(selected === item.key ? null : item.key)}>
      {chunkLabel(item.position, item.chunkId)}<small>{item.id}</small>{extendedParts(item).length > 0 && <em className="ag-ext-badge">+扩展 {extendedParts(item).length} 片</em>}</button>)}</div>
    {current && <div className={`ag-chunk-body ${current.hit ? "is-hit" : ""}`}>
      <div className="ag-chunk-meta"><strong>{chunkLabel(current.position, current.chunkId)}</strong><small>本次检索的 {current.id}</small>{current.title ?? "—"}{current.heading ? ` · ${current.heading}` : ""}{current.relevance !== undefined && current.relevance !== null && <small> · 相关性 {current.relevance.toFixed(2)}{current.low ? "（较低）" : ""}</small>}{current.hit && <span className="ag-hit">含证据</span>}</div>
      {extendedParts(current).length > 0 && <PartsRow item={current} />}
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
      const fixedFound = fixed?.given ?? fixed?.status === "returned";
      const chunkIds = evidence.chunk_ids?.length ? evidence.chunk_ids : fixed?.chunk_id ? [fixed.chunk_id] : [];
      return <div className="ag-evidence" key={index}>
        <p>证据 {index + 1}：“{evidence.text}”</p>
        <span className="ag-evidence-chunk">所在分块 {chunkIds.length ? chunkIds.map((chunkId, order) => <code key={chunkId} title={chunkId}>{chunkLabel(evidence.positions?.[order], chunkId)}</code>) : "知识库里没找到"}</span>
        {hasFixed && <span className={fixedFound ? "is-hit" : "is-miss"}>固定流程：{fixedFound ? `拿到了${fixed?.first_given === false ? "（补充检索拿到的）" : fixed?.source_id ? `（本次检索的 ${fixed.source_id}）` : "（在父块拼进来的相邻分片里）"}` : question.cleared && fixed?.first_given ? "第一次检索拿到了，但被充分性判断清空了" : "没拿到"}</span>}
        <span className={evidence.found ? "is-hit" : "is-miss"}>Agent：{evidence.found ? `拿到了（${evidence.where.map((item) => `第 ${item.call} 次调用的 ${item.evidence_id ?? "—"}`).join("、")}）` : "没拿到"}</span>
      </div>;
    })}</div> : <p className="ev-muted-note">这道题知识库里没有答案，没有预设证据；拿到的资料越少越好（拿到了模型可能硬凑答案）。</p>}
    <p className="ag-muted ag-numbering-note">「第 N 片」是分块在文档里的编号，固定不变；小字的 S1、S2 是某一次检索返回结果的顺序（每次检索都从 S1 开始），只在那一次检索里有意义。绿色的分块包含证据；Agent 那边红框的分块是这次调用新拿到的（前面的调用没拿到过）。标了「+扩展 N 片」的分块，父块扩展还把相邻的几片一起拼进来交给了模型，点开能看到哪几片是扩展的、证据在哪一片。</p>
    <div className={`ag-columns ${hasFixed ? "" : "is-single"}`}>
      {hasFixed && <FixedLog question={question} />}
      {agent && <AgentLog question={question} />}
    </div>
  </div>;
}

function FixedLog({ question }: { question: EvalQuestion }) {
  // 证据所在的分片（Agent 记的所在分块，或固定流程命中的分片）；来源是父块，父块里任何一片含证据都算命中。
  const evidenceChunks = new Set<string>();
  for (const item of question.agent?.evidence ?? []) for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  for (const item of question.evidence ?? []) if (item.chunk_id) evidenceChunks.add(item.chunk_id);
  const hitSources = new Set((question.evidence ?? []).filter((item) => item.status === "returned").map((item) => item.source_id));
  const items: ChunkItem[] = (question.sources ?? []).map((source) => {
    const extra = source as { chunk_id?: string; position?: number | null; parent_chunk_ids?: string[] };
    const parts = extra.parent_chunk_ids ?? (extra.chunk_id ? [extra.chunk_id] : []);
    return { key: source.id, id: source.id, chunkId: extra.chunk_id ?? null, position: extra.position ?? null, parts, title: source.title,
      heading: source.heading ?? null, text: source.text, evidenceParts: new Set(parts.filter((chunkId) => evidenceChunks.has(chunkId))),
      hit: hitSources.has(source.id) || parts.some((chunkId) => evidenceChunks.has(chunkId)) };
  });
  // 补充检索的来源：父块里任何一片含证据都算命中。
  const retry = question.retry;
  const retryItems: ChunkItem[] = (retry?.sources ?? []).map((source) => {
    const parts = source.parent_chunk_ids ?? (source.chunk_id ? [source.chunk_id] : []);
    return { key: `retry-${source.id}`, id: source.id, chunkId: source.chunk_id ?? null, position: source.position ?? null, parts, title: source.title,
      heading: source.heading ?? null, text: source.text, evidenceParts: new Set(parts.filter((chunkId) => evidenceChunks.has(chunkId))),
      hit: parts.some((chunkId) => evidenceChunks.has(chunkId)) };
  });
  const sufficiency = question.sufficiency;
  const searches = 1 + (sufficiency?.retried ? 1 : 0);
  const usedRetry = Boolean(sufficiency?.retry_used);
  return <section className="ag-log">
    <div className="ag-log-title">固定流程<small>检索 {searches} 次{sufficiency?.checked ? ` · 判断 ${sufficiency.calls ?? 1} 次` : ""} · 耗时 {formatMs(question.flow_latency_ms ?? question.latency_ms)}</small></div>
    {question.rewrite && <div className="ag-flow-step"><span className="ag-tool">改写</span><span>{rewriteLabel(question)}</span>
      {question.rewrite.duration_ms !== undefined && question.rewrite.classifier === "llm" && <span className="ag-tag">耗时 {formatMs(question.rewrite.duration_ms)}{question.rewrite.cached ? "（缓存，当时）" : ""}</span>}
      {question.rerank_query && question.rerank_query !== question.question && <span>补全后的问题 <code>{question.rerank_query}</code></span>}</div>}
    <div className={`ag-call ${usedRetry ? "is-unused" : ""}`}>
      <div className="ag-call-head"><span className="ag-tool">{sufficiency?.retried ? "第 1 次 · " : ""}检索</span>{question.queries.map((query) => <code key={query}>{query}</code>)}
        <span className="ag-tag">混合检索</span><span className="ag-tag">耗时 {formatMs(question.latency_ms)}</span>{items.some((item) => item.hit) && <span className="ag-hit">命中</span>}
        {usedRetry && <span className="ag-tag">没采用（换成了补充检索的结果）</span>}</div>
      <ChunkTabs items={items} empty="过滤后没有分块。" />
    </div>
    {sufficiency && <SufficiencySteps question={question} />}
    {retry && <div className={`ag-call ${usedRetry ? "" : "is-unused"}`}>
      <div className="ag-call-head"><span className="ag-tool">第 2 次 · 补充检索</span>{question.queries.map((query) => <code key={query}>{query}</code>)}{sufficiency?.retry_query && <code>+ {sufficiency.retry_query}</code>}
        <span className="ag-tag">返回 {retry.returned} 段</span>{retryItems.some((item) => item.hit) && <span className="ag-hit">命中</span>}
        <span className="ag-tag">{usedRetry ? "采用了" : "没变好，沿用第一次的"}</span></div>
      {retry.sources ? <ChunkTabs items={retryItems} empty="补充检索没有返回分块。" /> : <p className="ag-muted">这次评测没有保存补充检索的分块。</p>}
    </div>}
    {question.cleared && <div className="ag-flow-cleared">判断为资料不足，来源已清空：线上这道题会直接拒答，模型什么资料都拿不到。</div>}
  </section>;
}

const VERDICT_LABELS: Record<string, string> = { sufficient: "够了", partial: "只够一部分", insufficient: "不够" };

// 充分性判断：每次判断的结论和缺什么（补充检索后会再判断一次）。
function SufficiencySteps({ question }: { question: EvalQuestion }) {
  const sufficiency = question.sufficiency!;
  if (!sufficiency.checked) return <div className="ag-flow-step"><span className="ag-tool">充分性判断</span><span className="ag-muted">{question.returned === 0 ? "第一次检索没有来源，不用判断" : "没有做（需要真实大模型，并打开「检索充分性判断」开关）"}</span></div>;
  const judgements = sufficiency.judgements?.length ? sufficiency.judgements : [{ verdict: sufficiency.verdict ?? "", missing: typeof sufficiency.missing === "string" ? sufficiency.missing : "", rewrite_query: sufficiency.retry_query ?? "" }];
  return <>{judgements.map((judgement, index) => <div key={index} className={`ag-flow-step is-judge is-${judgement.verdict}`}>
    <span className="ag-tool">{judgements.length > 1 ? `第 ${index + 1} 次判断` : "充分性判断"}</span>
    <strong>{VERDICT_LABELS[judgement.verdict] ?? judgement.verdict}</strong>
    {judgement.missing && <span>缺：{judgement.missing}</span>}
    {index === 0 && judgement.rewrite_query && judgement.verdict !== "sufficient" && <span>补充检索词 <code>{judgement.rewrite_query}</code></span>}
  </div>)}</>;
}

function AgentLog({ question }: { question: EvalQuestion }) {
  const agent = question.agent!;
  const fresh = freshness(question);
  const evidenceChunks = new Set<string>();
  for (const item of agent.evidence ?? []) for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  return <section className="ag-log">
    <div className="ag-log-title">Agent<small>检索 {agent.searches} 次{fresh.wasted > 0 ? `（${fresh.wasted} 次无新增）` : ""} · {agent.rounds} 轮 · {agent.prompt_tokens} token · 耗时 {formatMs(agent.latency_ms)} · {STOP_LABELS[agent.stop_reason ?? ""] ?? agent.stop_reason ?? "—"}</small></div>
    {agent.question_sent !== question.question && <div className="ag-call-meta">实际提问（多轮追问按规则补全）：{agent.question_sent}</div>}
    {agent.calls.length === 0 && <p className="ag-muted">没有调用任何工具，直接回答了。</p>}
    {agent.calls.map((call) => <AgentCall key={call.call} call={call} fresh={fresh.perCall.get(call.call) ?? new Set()} evidenceChunks={evidenceChunks} />)}
  </section>;
}

function AgentCall({ call, fresh, evidenceChunks }: { call: EvalAgentCall; fresh: Set<string>; evidenceChunks: Set<string> }) {
  const status = CALL_STATUS[call.status] ?? call.status;
  const hit = call.hits.length > 0;
  const executed = call.status === "ok" || call.status === "error";
  const newCount = call.new_chunks ?? fresh.size;
  let items: ChunkItem[] = [];
  if (call.results) items = call.results.map((result) => ({ key: `${call.call}-${result.evidence_id}`, id: result.evidence_id, chunkId: result.chunk_id, position: result.position ?? null, parts: result.parent_chunk_ids, evidenceParts: new Set((result.parent_chunk_ids ?? []).filter((chunkId) => evidenceChunks.has(chunkId))), title: result.title,
    heading: result.heading ?? null, text: result.text, relevance: result.relevance, low: result.low_relevance, hit: result.hits.length > 0,
    fresh: Boolean(result.chunk_id) && fresh.has(result.chunk_id as string) }));
  else if (call.name === "read_context" && call.text) items = [{ key: `${call.call}-read`, id: `${call.source_id ?? ""} ${call.direction === "before" ? "前文" : "后文"}`,
    position: call.positions?.length ? call.positions[0] : null, chunkId: call.chunk_ids[0] ?? null,
    fresh: call.chunk_ids.some((chunkId) => fresh.has(chunkId)),
    title: null, heading: null, text: call.text, hit: (call.read_hits ?? []).length > 0 }];
  return <div className={`ag-call ${call.status !== "ok" ? "is-off" : ""} ${hit ? "is-hit" : ""}`}>
    <div className="ag-call-head">
      <span className="ag-tool">第 {call.call} 次 · {TOOL_LABELS[call.name] ?? call.name}</span>
      {call.name === "search_knowledge" && call.query !== undefined ? <><code>{call.query}</code>
        <span className="ag-tag">{SEARCH_MODE_LABELS[call.mode ?? ""] ?? call.mode}</span><span className="ag-tag">Top K {call.top_k}</span></>
        : call.name === "read_context" && call.source_id ? <span>{call.source_id} 的{call.direction === "before" ? "前文" : "后文"}</span>
          : <code>{JSON.stringify(call.arguments)}</code>}
      {call.duration_ms !== undefined && call.duration_ms !== null && <span className="ag-tag">耗时 {formatMs(call.duration_ms)}</span>}
      {executed && (call.name === "search_knowledge" || call.name === "read_context") && (newCount > 0
        ? <span className="ag-tag is-new">新增 {newCount} 片</span>
        : <span className="ag-tag is-waste" title="这次拿回的分块，前面的调用都已经拿到过">无新增</span>)}
      {hit && <span className="ag-hit">命中证据 {call.hits.map((index) => index + 1).join("、")}</span>}
    </div>
    {status && <div className="ag-call-meta">{status}{call.error ? `：${call.error}` : ""}</div>}
    {call.note && call.status !== "ok" && <div className="ag-call-meta">{call.note}</div>}
    {(call.results || call.name === "read_context") && <ChunkTabs items={items} empty={call.results ? "没有返回分块（空检索）。" : "没有读到内容。"} />}
  </div>;
}

// ---------- 专项评测里的 Agent ----------

// 和上次比：上次没通过、这次通过算新通过，反过来算新失败；上次没跑过这个模式就不标。
function change(now: boolean | undefined, before: boolean | null | undefined) {
  if (now === undefined || before === undefined || before === null || before === now) return null;
  return now ? "新通过" : "新失败";
}

// 专项的一道题转成调参评测逐题对比用的格式，复用同一个列表和左右两栏的检索日志。
function fromSpecial(question: EvalSpecialQuestion, hasFixed: boolean): EvalQuestion {
  const notes = [hasFixed ? change(question.fixed_passed, question.previous_passed) && `固定流程${change(question.fixed_passed, question.previous_passed)}` : null,
    change(question.agent_passed, question.previous_agent_passed) && `Agent ${change(question.agent_passed, question.previous_agent_passed)}`].filter(Boolean);
  const recall = question.recall_final ?? (question.fixed_passed ? 1 : 0);
  return {
    id: question.id, question: question.question, type: "专项", answerable: true,
    evidence_count: question.evidence_count ?? question.agent?.evidence.length ?? 0,
    stages: (hasFixed ? { pool: { recall, rr: 0, rank: null }, top: { recall, rr: 0, rank: null }, final: { recall, rr: 0, rank: null } } : undefined) as EvalQuestion["stages"],
    lost_stage: question.lost_stage ?? null,
    evidence: (question.fixed_evidence ?? []).map((item) => ({ ...item, rrf_rank: null, rerank_rank: null, rerank_probability: null, status: item.status ?? "not_recalled" })),
    given_recall: question.given_recall,
    returned: question.returned ?? 0, max_probability: null, latency_ms: question.latency_ms ?? 0,
    queries: question.queries ?? [], rerank_query: question.rerank_query ?? "", query_source: question.rewrite?.classifier ?? "rule",
    first_given_recall: question.first_given_recall, rewrite: question.rewrite, retry: question.retry, cleared: question.cleared,
    flow_latency_ms: question.flow_latency_ms, sufficiency: question.sufficiency ?? undefined,
    sources: question.sources, agent: question.agent, compare: question.compare, note: notes.join(" · ") || undefined,
  };
}

// 检索方式的专项勾了 Agent 时的结果：两边的通过数（和上次比）、对比分类，下面是逐题对比列表。
export function SpecialAgentResults({ section }: { section: EvalSpecialSection }) {
  const modes = section.modes ?? ["fixed"];
  const hasFixed = modes.includes("fixed");
  const questions = section.questions.map((question) => fromSpecial(question, hasFixed));
  const fixedPassed = section.questions.filter((question) => question.fixed_passed ?? (hasFixed && question.passed)).length;
  const agentPassed = section.agent_passed ?? section.questions.filter((question) => question.agent_passed).length;
  const counts = { both: 0, fixed_only: 0, agent_only: 0, neither: 0 } as Record<EvalCompareKey, number>;
  for (const question of section.questions) if (question.compare) counts[question.compare] += 1;
  const newly = (key: "previous_passed" | "previous_agent_passed", now: "fixed_passed" | "agent_passed") => {
    let better = 0, worse = 0;
    for (const question of section.questions) {
      const result = change(question[now], question[key]);
      if (result === "新通过") better += 1;
      if (result === "新失败") worse += 1;
    }
    return { better, worse };
  };
  const fixedChange = newly("previous_passed", "fixed_passed");
  const agentChange = newly("previous_agent_passed", "agent_passed");
  const run = { questions, config: { split: null, suites: [], modes } } as unknown as EvalRun;
  return <div className="ev-overview ag-eval ag-special">
    {hasFixed && section.search_mode && section.search_mode !== "hybrid" && <p className="ev-settings-diff">这个专项设置了「{section.search_mode_label}」：固定流程按这个设置检索，Agent 每次检索自己选方式，两边比的不是同一件事。比较两种模式时，专项请用混合检索。</p>}
    <div className="ev-cards">
      {hasFixed && <Card label="固定流程通过" value={`${fixedPassed} / ${section.count}`} note={section.previous ? `和上次（${section.previous.passed} / ${section.previous.count}）比：新通过 ${fixedChange.better}，新失败 ${fixedChange.worse}` : "这是第一次用固定流程跑这个专项"} />}
      <Card label="Agent 通过" value={`${agentPassed} / ${section.count}`} note={section.previous_agent ? `和上次（${section.previous_agent.passed ?? "—"} / ${section.previous_agent.count}）比：新通过 ${agentChange.better}，新失败 ${agentChange.worse}` : "这是第一次用 Agent 跑这个专项"} />
      {hasFixed && (Object.keys(COMPARE_LABELS) as EvalCompareKey[]).map((key) => <Card key={key} label={COMPARE_LABELS[key]} value={`${counts[key]} 题`} note={COMPARE_HINTS[key]} />)}
    </div>
    <p className="ev-muted-note">证据全部拿到算通过：固定流程看过滤后交给回答模型的来源，Agent 看它所有检索结果和读前后文读到的；两边都算父块扩展拼进来的相邻分片。{section.agent && <> Agent 配置：工具预算 {section.agent.tool_budget} 次 · 超时 {section.agent.timeout} 秒 · 提示词版本 {section.agent.prompt_version}。</>}</p>
    <AgentQuestionList run={run} hasFixed={hasFixed} />
  </div>;
}
