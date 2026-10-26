import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChunkOriginalDialog, type ChunkOriginal } from "./ChunkOriginalDialog";
import { type EvalAgentCall, type EvalCompareKey, type EvalConfig, type EvalMaterial, type EvalMode, type EvalRetry, type EvalQuestion, type EvalRun, type EvalRunBrief, type EvalSpecialQuestion, type EvalSpecialSection, type EvalSummary } from "./api";
import { evidenceLabel, formatDuration as formatMs } from "./format";
import { SourceTag, Tag, TypeStats, TypeTag, typeHues, type TypeStat } from "./Tag";
import type { Tone } from "./tags";
import { SCORE_RULE, bandsText, formatPoints, questionScore, summarizeScores } from "./score";

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
  agent_only: "Agent 找到，固定流程没有",
  fixed_only: "固定流程找到，Agent 没有：重点看",
  neither: "两边都没拿全",
  both: "两边都拿全了",
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
  if (!question.answerable) return agent.returned === 0 ? { key: "good", label: "没拿到资料 · 100 分" } : { key: "warn", label: `拿到 ${agent.returned} 段 · -20 分` };
  // 写出拿到几条证据：「命中 3 / 3」「部分 1 / 3」「未命中 0 / 3」。
  const total = agent.evidence.length || question.evidence_count;
  const found = agent.evidence.length ? agent.evidence.filter((item) => item.found).length : Math.round((agent.recall ?? 0) * total);
  return countVerdict(found, total);
}

// 后面带上这题的得分（规则见 score.ts）。
function countVerdict(found: number, total: number) {
  const score = questionScore(true, found, total);
  const count = `${found} / ${total}${score === null ? "" : ` · ${score} 分`}`;
  if (total > 0 && found >= total) return { key: "good", label: `命中 ${count}` };
  if (found > 0) return { key: "warn", label: `部分 ${count}` };
  return { key: "bad", label: `未命中 ${count}` };
}

// 一道题的检索词是谁给的。
export function rewriteLabel(question: { rewrite?: EvalQuestion["rewrite"]; query_source?: string }) {
  const classifier = question.rewrite?.classifier ?? question.query_source;
  if (classifier === "llm") return question.rewrite?.cached ? "大模型改写（来自改写缓存）" : "大模型改写";
  if (classifier === "small_model") return "本地小模型只分类不改写，用原问题检索";
  if (classifier === "rewrite_cache") return "来自改写缓存";
  // 没用上大模型：写出原因（大模型调用失败、输出格式不对、命中规则……），这时只用原问题检索一路。
  const reason = question.rewrite?.fallback_reason;
  return reason ? `没用上大模型改写：${reason}，只用原问题检索` : "没用上大模型改写，只用原问题检索（这次评测没记原因）";
}

function fixedVerdict(question: EvalQuestion) {
  if (!question.stages) return { key: "none", label: "—" };
  if (!question.answerable) return question.returned === 0 || question.cleared ? { key: "good", label: `${question.cleared ? "被清空，没拿到资料" : "没拿到资料"} · 100 分` } : { key: "warn", label: `拿到 ${question.sufficiency?.source_count ?? question.returned} 段 · -20 分` };
  // 被充分性判断清空：模型什么资料都拿不到。
  if (question.cleared) return { key: "bad", label: `被清空 0 / ${question.evidence_count} · ${questionScore(true, 0, question.evidence_count)} 分` };
  // 和 Agent 比较时按「最终交给模型的资料」（含父块扩展、补充检索）算；旧记录没有，用过滤后 Recall。
  const recall = question.given_recall ?? question.stages.final.recall ?? 0;
  const total = question.evidence_count;
  return countVerdict(question.given_hits ?? Math.round(recall * total), total);
}

function Verdict({ verdict }: { verdict: { key: string; label: string } }) {
  if (verdict.key === "none") return <span className="ag-muted">—</span>;
  return <span className={`ev-verdict is-${verdict.key}`}><b>{verdict.key === "good" ? "✓" : verdict.key === "warn" ? "◐" : "✕"}</b>{verdict.label}</span>;
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="ev-card"><span className="ev-card-label">{label}</span><strong className="ev-card-value">{value}</strong>{note && <div className="ev-card-explanation"><span>{note}</span></div>}</div>;
}

// 两种模式的大卡片：左边固定流程、右边 Agent，每张卡片放这个模式的全部指标，同一行左右对齐好比较。
// 分三块：结果（通过、证据命中、扩展命中）、过程（检索次数、耗时……）、配置。数字都从逐题结果现算，调参评测和专项共用。
type ModeCell = { value: string; note?: string; best?: boolean };
type ModeRow = { group: "result" | "process" | "config"; label: string; fixed?: ModeCell; agent?: ModeCell };

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function ratio(part: number, total: number) {
  return total ? `${part} / ${total} · ${Math.round((part / total) * 100)}%` : "—";
}

// 交给模型的资料：后端记的段数、字数、token；旧记录按保存下来的来源正文现算（token 用和后端同一种估算）。
const WIDE_CHARS = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
function textTokens(text: string) {
  const wide = (text.match(WIDE_CHARS) ?? []).length;
  return wide + Math.ceil((text.length - wide) / 4);
}

function fixedMaterial(question: EvalQuestion): EvalMaterial | null {
  if (question.material) return question.material;
  if (!question.stages) return null;
  if (question.cleared) return { count: 0, chars: 0, tokens: 0 };
  const sources = question.retry?.used && question.retry.sources ? question.retry.sources : question.sources;
  if (!sources) return null;
  return {
    count: sources.length, chars: sources.reduce((sum, source) => sum + (source.text ?? "").length, 0),
    tokens: sources.reduce((sum, source) => sum + textTokens(source.text ?? ""), 0)
  };
}

function agentMaterial(question: EvalQuestion): EvalMaterial | null {
  return question.agent?.material ?? null;
}

function MaterialLine({ material }: { material: EvalMaterial | null }) {
  if (!material) return null;
  return <div className="ag-material"><span className="ag-tool">交给模型的资料</span>
    <span><b>{material.count}</b> 段 · {material.chars.toLocaleString()} 字 · 约 {material.tokens.toLocaleString()} token</span></div>;
}

// 证据命中情况：每条证据一个结果标签（检索命中 / 父块扩展命中 / 读前后文拿到 / 被过滤 / 没召回 / 没拿到），后面写细节。
type EvidenceStatusRow = { label: string; tone: "success" | "danger" | "neutral" | "info"; dashed?: boolean; detail: string };

// 每张卡片的第一块：证据命中情况，每条证据一个结果标签加细节；下面「详情」按钮展开这张卡片原来的检索过程。
function EvidenceStatus({ rows, expanded, onToggle, children }: { rows: EvidenceStatusRow[]; expanded: boolean; onToggle: () => void; children?: ReactNode }) {
  return <div className="ag-evidence-status">
    <div className="ag-tool">证据命中情况</div>
    {rows.length > 0 ? <ul>{rows.map((row, index) => <li key={index}>
      <span className="ag-evidence-name">证据 {index + 1}</span>
      <Tag tone={row.tone} size="sm" outline={row.dashed} className={row.dashed ? "is-dashed" : undefined}>{row.label}</Tag>
      {row.detail && <small>{row.detail}</small>}
    </li>)}</ul> : <p className="ag-muted">没有答案的题，不看证据。</p>}
    {children}
    <button type="button" className="secondary-button ag-detail-button" aria-expanded={expanded} onClick={onToggle}>{expanded ? "收起详情" : "详情"}</button>
  </div>;
}

// 证据命中情况（两边各一列）：从逐题结果算出每条证据的结果标签和细节。
// 固定流程按最后交给模型的资料算（补充检索、被清空都考虑），没拿到的写丢在哪一步；Agent 重点写第几轮拿到的。
function chunkItemsOf(sources: EvalQuestion["sources"] | EvalRetry["sources"] | undefined) {
  return (sources ?? []).map((source) => {
    const extra = source as { id: string; chunk_id?: string | null; position?: number | null; parent_chunk_ids?: string[] };
    return {
      id: extra.id, chunkId: extra.chunk_id ?? null, position: extra.position ?? null,
      parts: extra.parent_chunk_ids ?? (extra.chunk_id ? [extra.chunk_id] : [])
    };
  });
}

function evidenceChunkLists(question: EvalQuestion) {
  return (question.agent?.evidence ?? []).length
    ? (question.agent?.evidence ?? []).map((item) => item.chunk_ids ?? [])
    : (question.evidence ?? []).map((item) => (item.chunk_id ? [item.chunk_id] : []));
}

function fixedEvidenceRows(question: EvalQuestion, config: EvalRun["config"]): EvidenceStatusRow[] {
  const evidenceLists = evidenceChunkLists(question);
  const total = question.answerable ? evidenceLists.length : 0;
  const items = chunkItemsOf(question.sources);
  const retry = question.retry;
  const retryItems = chunkItemsOf(retry?.sources);
  const usedRetry = Boolean(question.sufficiency?.retry_used);
  return Array.from({ length: total }, (_, evidence): EvidenceStatusRow => {
    const fixed = question.evidence?.[evidence];
    if (question.cleared) return { label: "被过滤", tone: "danger", detail: "（被充分性判断清空，线上会直接拒答）" };
    const finalItems = usedRetry ? retryItems : items;
    const chunkIds = evidenceLists[evidence] ?? [];
    const carrier = finalItems.find((item) => (item.parts ?? []).some((chunkId) => chunkIds.includes(chunkId)));
    const from = usedRetry ? "补充检索的" : "";
    if (carrier) {
      const direct = carrier.chunkId ? chunkIds.includes(carrier.chunkId) : true;
      return direct ? { label: "检索命中", tone: "success", detail: `${from}${carrier.id} ${chunkLabel(carrier.position, carrier.chunkId)}` }
        : { label: "父块扩展命中", tone: "success", dashed: true, detail: `${from}${carrier.id} ${chunkLabel(carrier.position, carrier.chunkId)} 拼进来的相邻分片里` };
    }
    const row = lostRow(fixed, config);
    return retry ? { ...row, detail: `${row.detail}${usedRetry ? "；补充检索也没拿到" : "；补充检索没采用"}` } : row;
  });
}

function agentEvidenceRows(question: EvalQuestion): EvidenceStatusRow[] {
  const agent = question.agent;
  if (!agent || !question.answerable) return [];
  return agent.evidence.map((evidence): EvidenceStatusRow => {
    // 重点是第几轮拿到的：按轮列出，每轮写第几次检索的哪一段；第一次拿到的那一轮放最前面。
    const rounds = new Map<number | null, string[]>();
    for (const item of evidence.where) {
      const round = agent.calls.find((call) => call.call === item.call)?.round ?? null;
      rounds.set(round, [...(rounds.get(round) ?? []), `第 ${item.call} 次的 ${item.evidence_id ?? "—"}`]);
    }
    const where = [...rounds.entries()].map(([round, calls]) => `第 ${round ?? "—"} 轮（${calls.join("、")}）`).join("；");
    const firstRound = [...rounds.keys()][0];
    if (!evidence.found) return { label: "没拿到", tone: "neutral", detail: "每次检索留下的资料里都没有" };
    const head = `第 ${firstRound ?? "—"} 轮`;
    if (evidence.via === "context") return { label: `${head}读前后文拿到`, tone: "info", detail: where };
    if (evidence.via === "extension") return { label: `${head}父块扩展命中`, tone: "success", dashed: true, detail: where };
    return { label: `${head}检索命中`, tone: "success", detail: where };
  });
}

// 固定流程没交给模型的证据：丢在哪一步（第一次检索的记录）。没召回单独一类，其余都算被过滤，括号里写原因。
function lostRow(fixed: EvalQuestion["evidence"][number] | undefined, config: EvalRun["config"]): EvidenceStatusRow {
  const outcome = mergeOutcome(fixed, false, config);
  if (!fixed || fixed.status === "not_recalled") return { label: "没召回", tone: "neutral", detail: "每一路都没召回" };
  return { label: "被过滤", tone: "danger", detail: `（${outcome.text.replace(/，被过滤$/, "")}）` };
}

// 固定流程一道题命中几条证据：按最后交给模型的资料算，被清空算 0。
function fixedHits(question: EvalQuestion) {
  if (question.cleared) return 0;
  if (question.given_hits !== undefined && question.given_hits !== null) return question.given_hits;
  if (question.evidence.some((item) => item.given !== undefined)) return question.evidence.filter((item) => item.given).length;
  return Math.round((question.given_recall ?? question.stages?.final.recall ?? 0) * question.evidence_count);
}

function fixedExtHits(question: EvalQuestion) {
  if (question.cleared) return 0;
  return question.ext_hits ?? question.evidence.filter((item) => item.given && item.via === "extension").length;
}

function modeRows(questions: EvalQuestion[], config: EvalConfig | undefined, hasFixed: boolean, hasAgent: boolean): ModeRow[] {
  const answerable = questions.filter((question) => question.answerable);
  const unanswerable = questions.filter((question) => !question.answerable);
  const evidenceTotal = answerable.reduce((sum, question) => sum + question.evidence_count, 0);
  const rows: ModeRow[] = [];
  let fixed: Record<string, number> = {};
  let agent: Record<string, number> = {};
  if (hasFixed) {
    const ran = answerable.filter((question) => question.stages);
    const hits = ran.map(fixedHits);
    fixed = {
      passed: ran.filter((question, index) => question.evidence_count > 0 && hits[index] >= question.evidence_count).length,
      count: ran.length, hits: hits.reduce((sum, value) => sum + value, 0), ext: ran.reduce((sum, question) => sum + fixedExtHits(question), 0),
      direct: ran.reduce((sum, question, index) => sum + hits[index] - fixedExtHits(question), 0),
      retried: questions.filter((question) => question.retry?.used).length, cleared: answerable.filter((question) => question.cleared).length,
      rejected: ran.filter((question) => question.cleared || question.returned === 0).length,
      accepted: unanswerable.filter((question) => question.stages && !question.cleared && question.returned > 0).length,
    };
  }
  if (hasAgent) {
    const ran = answerable.filter((question) => question.agent);
    const found = ran.map((question) => question.agent!.evidence.filter((item) => item.found).length);
    const all = questions.filter((question) => question.agent).map((question) => question.agent!);
    const searches = all.reduce((sum, item) => sum + item.searches, 0);
    agent = {
      passed: ran.filter((question, index) => question.evidence_count > 0 && found[index] >= (question.agent!.evidence.length || question.evidence_count)).length,
      count: ran.length, hits: found.reduce((sum, value) => sum + value, 0),
      ext: ran.reduce((sum, question) => sum + question.agent!.evidence.filter((item) => item.found && item.via === "extension").length, 0),
      context: ran.reduce((sum, question) => sum + question.agent!.evidence.filter((item) => item.found && item.via === "context").length, 0),
      direct: ran.reduce((sum, question) => sum + question.agent!.evidence.filter((item) => item.found && item.via === "direct").length, 0),
      searches, wasted: all.reduce((sum, item) => sum + (item.wasted_searches ?? 0), 0), forced: all.filter((item) => item.forced).length,
      failed: all.filter((item) => item.status !== "completed").length,
      rejected: ran.filter((question) => question.agent!.returned === 0).length,
      accepted: unanswerable.filter((question) => question.agent && question.agent.returned > 0).length,
    };
  }
  const both = hasFixed && hasAgent;
  // 两边都跑时，通过数、证据命中多的一边打 ✓。
  const best = (key: string, side: "fixed" | "agent") => both && (side === "fixed" ? fixed[key] > agent[key] : agent[key] > fixed[key]);
  const pick = (fixedCell: ModeCell | undefined, agentCell: ModeCell | undefined) => ({ fixed: hasFixed ? fixedCell : undefined, agent: hasAgent ? agentCell : undefined });
  // 得分：每题满分 100，没拿全最高 90，一条没找到按证据条数扣分；下面一行是分档计数。
  const fixedScore = summarizeScores(questions.filter((question) => question.stages).map((question) =>
    [question.answerable, question.answerable ? fixedHits(question) : 0, question.evidence_count, question.cleared ? 0 : question.returned]));
  const agentScore = summarizeScores(questions.filter((question) => question.agent && question.agent.status === "completed").map((question) =>
    [question.answerable, question.agent!.evidence.filter((item) => item.found).length, question.agent!.evidence.length || question.evidence_count, question.agent!.returned]));
  const scoreBest = (side: "fixed" | "agent") => both && fixedScore.score !== null && agentScore.score !== null
    && (side === "fixed" ? fixedScore.score > agentScore.score : agentScore.score > fixedScore.score);
  rows.push({
    group: "result", label: "得分", ...pick(
      { value: formatPoints(fixedScore.score), note: bandsText(fixedScore.bands), best: scoreBest("fixed") },
      { value: formatPoints(agentScore.score), note: bandsText(agentScore.bands), best: scoreBest("agent") })
  });
  rows.push({
    group: "result", label: "通过", ...pick(
      { value: `${fixed.passed} / ${fixed.count}`, note: "证据全拿到的题", best: best("passed", "fixed") },
      { value: `${agent.passed} / ${agent.count}`, note: agent.failed ? `证据全拿到的题 · 运行失败 ${agent.failed} 题` : "证据全拿到的题", best: best("passed", "agent") })
  });
  rows.push({
    group: "result", label: "证据命中", ...pick(
      { value: ratio(fixed.hits, evidenceTotal), note: "最后交给模型的资料里有的证据", best: best("hits", "fixed") },
      { value: ratio(agent.hits, evidenceTotal), note: "Agent 拿到的资料里有的证据", best: best("hits", "agent") })
  });
  // 每条证据是检索命中那一片里拿到的，还是父块扩展拼进来的（via）：加扩展命中统计之前跑的评测没有记，显示「—」而不是 0。
  const fixedVia = answerable.some((question) => question.ext_hits !== undefined && question.ext_hits !== null || question.evidence.some((item) => item.via !== undefined && item.via !== null));
  const agentVia = answerable.some((question) => (question.agent?.evidence ?? []).some((item) => item.via !== undefined && item.via !== null));
  const noVia = { value: "—", note: "这次评测没记录（加扩展命中统计之前跑的），重跑后才有" };
  // 检索命中：证据命中里去掉靠扩展（和读前后文）拿到的，只算检索本身命中的；没有 via 记录的旧评测显示「—」。
  rows.push({
    group: "result", label: "检索命中", ...pick(
      fixedVia ? { value: ratio(fixed.direct, evidenceTotal), note: "不算父块扩展，检索本身命中的证据", best: best("direct", "fixed") } : noVia,
      agentVia ? { value: ratio(agent.direct, evidenceTotal), note: "不算父块扩展和读前后文，检索本身命中的证据", best: best("direct", "agent") } : noVia)
  });
  rows.push({
    group: "result", label: "扩展命中", ...pick(
      fixedVia ? { value: `${fixed.ext} 条`, note: "只在父块扩展的分片里" } : noVia,
      agentVia ? { value: `${agent.ext} 条`, note: agent.context ? `只在父块扩展的分片里 · 读前后文 ${agent.context} 条` : "只在父块扩展的分片里" } : noVia)
  });
  if (unanswerable.length) {
    rows.push({
      group: "result", label: "误杀", ...pick(
        { value: `${fixed.rejected} 题`, note: `${fixed.count} 道有答案的题一段资料都没拿到` },
        { value: `${agent.rejected} 题`, note: `${agent.count} 道有答案的题一段资料都没拿到` })
    });
    rows.push({
      group: "result", label: "漏放", ...pick(
        { value: `${fixed.accepted} 题`, note: `${unanswerable.length} 道没答案的题还拿到了资料` },
        { value: `${agent.accepted} 题`, note: `${unanswerable.length} 道没答案的题还拿到了资料` })
    });
  }
  const flowLatency = avg(questions.filter((question) => question.stages).map((question) => question.flow_latency_ms ?? question.latency_ms));
  const agentRuns = questions.filter((question) => question.agent).map((question) => question.agent!);
  const fixedCount = questions.filter((question) => question.stages).length;
  // 交给模型的资料：固定流程是最后留下的那几段，Agent 是资料池里全部（每次检索留下的累加）。
  const averageMaterial = (items: (EvalMaterial | null)[]) => {
    const known = items.filter((item): item is EvalMaterial => item !== null);
    return known.length ? { count: avg(known.map((item) => item.count))!, chars: avg(known.map((item) => item.chars))!, tokens: avg(known.map((item) => item.tokens))! } : null;
  };
  const fixedGiven = averageMaterial(questions.filter((question) => question.stages).map(fixedMaterial));
  const agentGiven = averageMaterial(questions.filter((question) => question.agent).map(agentMaterial));
  const materialCell = (value: ReturnType<typeof averageMaterial>, note: string) => value
    ? { value: `平均 ${number(value.count)} 段 · 约 ${Math.round(value.tokens).toLocaleString()} token`, note: `约 ${Math.round(value.chars).toLocaleString()} 字；${note}` }
    : { value: "—", note: "这次评测没记录，重跑后才有" };
  rows.push({
    group: "process", label: "资料量", ...pick(
      materialCell(fixedGiven, "交给模型的是最后留下的那几段"),
      materialCell(agentGiven, "交给模型的是资料池里全部，每次检索留下的累加"))
  });
  rows.push({
    group: "process", label: "检索", ...pick(
      { value: `平均 ${number(fixedCount ? 1 + fixed.retried / fixedCount : null)} 次`, note: `补充检索 ${fixed.retried} 题${fixed.cleared ? ` · 被清空 ${fixed.cleared} 题` : ""}` },
      { value: `平均 ${number(avg(agentRuns.map((item) => item.searches)))} 次`, note: agent.searches ? `无新增 ${agent.wasted} 次，占 ${Math.round((agent.wasted / agent.searches) * 100)}%` : undefined })
  });
  if (hasAgent) rows.push({
    group: "process", label: "轮数", ...pick(
      { value: "—", note: "固定流程没有轮次" },
      { value: `平均 ${number(avg(agentRuns.map((item) => item.rounds)))} 轮`, note: `强制回答 ${agent.forced} 题` })
  });
  rows.push({
    group: "process", label: "耗时", ...pick(
      { value: `平均 ${formatMs(flowLatency)}`, note: "改写 + 检索 + 充分性判断，不含写回答" },
      agentRuns.some((item) => item.search_ms !== undefined)
        ? { value: `平均 ${formatMs(avg(agentRuns.map((item) => item.search_ms ?? 0)))}`, note: `只算检索；写回答另需 ${formatMs(avg(agentRuns.map((item) => item.answer_ms ?? 0)))}，合计 ${formatMs(avg(agentRuns.map((item) => item.latency_ms)))}` }
        : { value: `平均 ${formatMs(avg(agentRuns.map((item) => item.latency_ms)))}`, note: "含写回答（旧记录分不开）" })
  });
  if (hasAgent) rows.push({
    group: "process", label: "输入 token", ...pick(
      { value: "—", note: "没记录" },
      { value: `平均 ${number(avg(agentRuns.map((item) => item.prompt_tokens)), 0)}` })
  });
  const flow = config?.flow;
  const rewrite = flow ? flow.rewrite_cached + flow.rewrite_fresh : 0;
  const agentConfig = config?.agent;
  rows.push({
    group: "config", label: "配置", ...pick(
      // 检索参数两边共用（写在卡片上方），这里只放各自独有的：固定流程是改写和充分性判断，Agent 是预算、超时和提示词。
      { value: flow ? `大模型改写${flow.sufficiency ? " + 充分性判断" : "（充分性判断未启用）"}` : "—", note: rewrite ? `改写 ${rewrite} 题，${flow!.rewrite_cached} 题来自缓存${flow?.model ? ` · ${flow.model}` : ""}` : undefined },
      { value: agentConfig ? `预算 ${agentConfig.tool_budget} 次 · 超时 ${agentConfig.timeout} 秒` : "—", note: agentConfig ? `提示词 ${agentConfig.prompt_version}${agentConfig.model ? ` · ${agentConfig.model}` : ""}` : undefined })
  });
  return rows;
}

function ModeCards({ questions, config, hasFixed, hasAgent }: { questions: EvalQuestion[]; config?: EvalConfig; hasFixed: boolean; hasAgent: boolean }) {
  const rows = modeRows(questions, config, hasFixed, hasAgent);
  const card = (side: "fixed" | "agent", title: string) => <section className="ag-mode-card">
    <h4>{title}</h4>
    {rows.map((row, index) => {
      const cell = row[side];
      if (!cell) return null;
      return <div key={row.label} className={`ag-mode-row is-${row.group}${index > 0 && rows[index - 1].group !== row.group ? " is-break" : ""}`}>
        <span className="ag-mode-label">{row.label}</span>
        <span className="ag-mode-value"><b>{cell.value}</b>{cell.best && <Tag tone="success" size="sm">{row.label === "得分" ? "✓ 更高" : "✓ 更多"}</Tag>}{cell.note && <small>{cell.note}</small>}</span>
      </div>;
    })}
  </section>;
  return <>
    <p className="ev-muted-note">得分：{SCORE_RULE}；无法回答的题拿到资料扣 20。</p>
    {config && <p className="ev-muted-note">{hasFixed && hasAgent ? "两边共用的检索参数" : "检索参数"}：{fixedParams(config).join(" · ")}。{hasAgent ? "Agent 每次检索也走这一套，只是可以自己选检索方式、少取几段。" : ""}</p>}
    <div className={`ag-mode-cards${hasFixed && hasAgent ? " is-two" : ""}`}>
      {hasFixed && card("fixed", "固定流程")}
      {hasAgent && card("agent", "Agent")}
    </div>
  </>;
}

// 两边都跑时，能回答的题按两边是否命中分成四类，一行标签。
function CompareLine({ counts }: { counts: Record<EvalCompareKey, number> }) {
  const tones: Record<EvalCompareKey, Tone> = { agent_only: "info", fixed_only: "warning", neither: "danger", both: "success" };
  return <div className="ag-compare-line"><span>逐题对比</span>
    {(Object.keys(COMPARE_LABELS) as EvalCompareKey[]).map((key) => <Tag key={key} tone={tones[key]} title={COMPARE_HINTS[key]}>{COMPARE_LABELS[key]} {counts[key] ?? 0}</Tag>)}
  </div>;
}

// 「对比」页签（固定流程和 Agent 一起跑时默认打开）：两边的核心指标左右并排，下面是逐题对比，点开看两边的检索日志。
export function ComparePanel({ run }: { run: EvalRun }) {
  const summary: EvalSummary = run.summary ?? {};
  return <div className="ev-overview ag-eval">
    <p className="ev-muted-note">{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答，比的是最后交给模型的资料里有没有证据。</p>
    <ModeCards questions={run.questions ?? []} config={run.config} hasFixed hasAgent />
    {run.comparison && <CompareLine counts={run.comparison} />}
    <div className="ev-section-title">按题目类型<small>得分和资料命中率</small></div>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th>题型</th><th className="num">题数</th><th className="num">固定流程得分</th><th className="num">Agent 得分</th><th className="num">固定流程命中率</th><th className="num">Agent 命中率</th><th className="num">固定流程资料</th><th className="num">Agent 资料</th><th className="num">Agent 平均检索次数</th></tr></thead>
      <tbody>{Object.entries(run.by_type ?? {}).map(([type, row]) => <tr key={type}>
        <td>{type}</td><td className="num">{row.count ?? row.agent_count ?? "—"}</td>
        <td className="num">{formatPoints(row.score)}</td><td className="num">{formatPoints(row.agent_score)}</td><td className="num">{percent(row.recall_given ?? row.recall_final)}</td>
        <td className="num">{percent(row.agent_recall)}</td>
        <td className="num">{row.material_avg_count === undefined || row.material_avg_count === null ? "—" : `${number(row.material_avg_count)} 段 · 约 ${Math.round(row.material_avg_tokens ?? 0).toLocaleString()} token`}</td>
        <td className="num">{row.agent_material_avg_count === undefined || row.agent_material_avg_count === null ? "—" : `${number(row.agent_material_avg_count)} 段 · 约 ${Math.round(row.agent_material_avg_tokens ?? 0).toLocaleString()} token`}</td>
        <td className="num">{number(row.agent_avg_searches)}</td>
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
  // 卡片说明写成「共 N 条证据，有 X 条……」「N 道……题，有 X 道……」，和固定流程的卡片同一种写法。
  const agentQuestions = (run.questions ?? []).filter((question) => question.agent);
  const answerable = agentQuestions.filter((question) => question.answerable);
  const unanswerable = agentQuestions.filter((question) => !question.answerable);
  const evidenceTotal = answerable.reduce((sum, question) => sum + (question.agent?.evidence ?? []).length, 0);
  const evidenceFound = answerable.reduce((sum, question) => sum + (question.agent?.evidence ?? []).filter((item) => item.found).length, 0);
  const rejected = answerable.filter((question) => (question.agent?.returned ?? 0) === 0).length;
  // 扩展命中：Agent 拿到的证据里，只在父块扩展拼进来的分片里的（读前后文拿到的单独算）。
  const viaCount = (kind: string) => answerable.reduce((sum, question) => sum + (question.agent?.evidence ?? []).filter((item) => item.found && item.via === kind).length, 0);
  const hasVia = answerable.some((question) => (question.agent?.evidence ?? []).some((item) => item.via !== undefined));
  const accepted = unanswerable.filter((question) => (question.agent?.returned ?? 0) > 0).length;
  return <div className="ev-overview ag-eval">
    <p className="ev-muted-note">只看 Agent 最后拿到的资料里有没有证据。{config && <> 工具预算 {config.tool_budget} 次 · 超时 {config.timeout} 秒 · 提示词 {config.prompt_version}{config.model ? ` · ${config.model}` : ""}</>}</p>
    <div className="ev-section-title">命中<small>{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答</small></div>
    <div className="ev-cards">
      <Card label="得分" value={formatPoints(summary.agent_score)} note={summary.agent_score_bands ? bandsText(summary.agent_score_bands as unknown as Record<string, number>) : SCORE_RULE} />
      <Card label="资料命中率" value={percent(summary.agent_recall)} note={agentQuestions.length ? `共 ${evidenceTotal} 条证据，Agent 找到的资料里有 ${evidenceFound} 条` : "Agent 找到资料，包含题目的证据的比例"} />
      <Card label="检索命中率" value={hasVia ? percent(summary.agent_direct_recall) : "—"} note={hasVia ? `共 ${evidenceTotal} 条证据，有 ${viaCount("direct")} 条是检索本身命中的（不算扩展和读前后文）` : "这次评测没记录（加扩展命中统计之前跑的），重跑后才有"} />
      <Card label="扩展命中率" value={percent(summary.agent_ext_hit_rate)} note={hasVia ? `拿到的 ${evidenceFound} 条证据里，有 ${viaCount("extension")} 条在扩展的分片里${viaCount("context") ? `，${viaCount("context")} 条靠读前后文` : ""}` : "拿到的证据里，只在父块扩展拼进来的分片里的比例"} />
      <Card label="误杀率" value={percent(summary.agent_false_reject_rate)} note={agentQuestions.length ? `${answerable.length} 道有答案的题，有 ${rejected} 道一段资料都没拿到` : "有答案却没拿到资料"} />
      <Card label="漏放率" value={percent(summary.agent_false_accept_rate)} note={agentQuestions.length ? `${unanswerable.length} 道没答案的题，有 ${accepted} 道还拿到了资料` : "没答案却拿到资料"} />
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
      <Card label="检索耗时" value={formatMs(summary.agent_search_latency_avg_ms ?? summary.agent_latency_avg_ms)} note={summary.agent_search_latency_avg_ms !== undefined && summary.agent_search_latency_avg_ms !== null ? `不含写回答；写回答另需 ${formatMs(summary.agent_answer_latency_avg_ms)}，合计 ${formatMs(summary.agent_latency_avg_ms)}` : `含写回答（旧记录分不开）· P95 ${formatMs(summary.agent_latency_p95_ms)}`} />
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

function AgentQuestionList({ run, hasFixed }: { run: EvalRun; hasFixed: boolean }) {
  const questions = run.questions ?? [];
  const [typeFilter, setTypeFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  // 每道题各自展开 / 收起，可以同时展开好几道对照着看。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const types: string[] = [];
  for (const question of questions) if (!types.includes(question.type)) types.push(question.type);
  const hues = typeHues(types);
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
    <div ref={header} className={`ag-q-columns ${layout} ${stuck ? "is-stuck" : ""}`} aria-hidden="true"><span>编号</span><span>问题</span>{hasFixed && <><span>固定流程</span><span>固定流程耗时</span></>}<span>Agent</span><span>Agent 检索次数</span><span>Agent 检索耗时</span><span /></div>
    <div className="ev-question-list">{visible.map((question) => {
      const open = expanded.has(question.id);
      const agent = question.agent;
      return <article className={`ev-question ${open ? "is-open" : ""}`} key={question.id}>
        <button className={`ag-q-head ${layout}`} aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(question.id); else next.add(question.id); return next; })}>
          <span className="ev-qid" title={question.id}>{question.seq ?? question.id}</span>
          <span className="ev-question-text">{question.question}<small><TypeTag type={question.type} hues={hues} />{question.evidence_count > 1 ? ` ${question.evidence_count} 条证据` : ""}{question.compare ? ` · ${COMPARE_LABELS[question.compare]}` : ""}{question.note ? ` · ${question.note}` : ""}</small></span>
          {hasFixed && <><Verdict verdict={fixedVerdict(question)} /><span className="ag-num">{formatMs(question.flow_latency_ms ?? question.latency_ms)}</span></>}
          <span className="ag-verdict-cell"><Verdict verdict={agentVerdict(question)} /></span>
          <span className="ag-num ag-search-cell">{agent ? `${agent.searches} 次` : "—"}</span>
          <span className="ag-num">{agent ? formatMs(agent.search_ms ?? agent.latency_ms) : "—"}</span>
          <span className="collapse-icon">{open ? "−" : "＋"}</span>
        </button>
        {open && <QuestionDetail question={question} hasFixed={hasFixed} params={fixedParams(run.config)} config={run.config} />}
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

// 一个分块：命中证据的标签有背景色；点标签打开共用的原文浮窗。
type ChunkItem = { key: string; id: string; chunkId?: string | null; position?: number | null; parts?: string[]; evidenceParts?: Set<string>; fresh?: boolean; snapshotNote?: string; title: string | null; heading: string | null; text: string; relevance?: number | null; low?: boolean; hit: boolean };

// 父块扩展：检索命中的是一片，父块扩展会把同一父块里相邻的几片一起拼进来交给模型。
// 拼进来的那几片标成「扩展」（虚线框），方便看出证据是检索直接命中的，还是靠扩展带进来的。
function extendedParts(item: ChunkItem) {
  return (item.parts ?? []).filter((chunkId) => chunkId !== item.chunkId);
}

// 证据是不是只在父块扩展拼进来的分片里（检索命中的那一片本身不含证据）。
function hitByExtension(item: ChunkItem) {
  return item.hit && extendedParts(item).some((chunkId) => item.evidenceParts?.has(chunkId)) && !(item.chunkId && item.evidenceParts?.has(item.chunkId));
}

function ChunkTabs({ items, empty, question }: { items: ChunkItem[]; empty: string; question: EvalQuestion }) {
  const [selected, setSelected] = useState<ChunkOriginal | null>(null);
  if (items.length === 0) return <p className="ag-muted">{empty}</p>;
  const groups = [
    { label: "命中", items: items.filter((item) => item.hit) },
    { label: "新增", items: items.filter((item) => item.fresh) },
    { label: items.some((item) => item.fresh !== undefined) ? "已有" : "未命中", items: items.filter((item) => !item.hit && !item.fresh) }
  ];
  return <div className="ag-chunks">
    <ul className="ag-chunk-groups">{groups.filter((group) => group.items.length).map((group) => <li key={group.label}>
      <span className="ag-chunk-group-label">{group.label}：</span>
      <span className="ag-chunk-group-sources">{group.items.map((item) => <SourceTag key={item.key} id={item.id}
        title={[chunkLabel(item.position, item.chunkId), item.title, hitByExtension(item) ? "证据在扩展分片中" : "", "点击查看原文"].filter(Boolean).join(" · ")}
        onClick={() => {
          const ids = item.parts?.length ? item.parts : item.chunkId ? [item.chunkId] : [];
          const texts = question.agent?.evidence.length ? question.agent.evidence : question.evidence;
          const hits = question.answerable ? evidenceChunkLists(question).flatMap((chunks, index) => chunks.some((id) => ids.includes(id)) ? [index] : []) : [];
          setSelected({ label: chunkLabel(item.position, item.chunkId), sources: [item], evidence: hits.map((index) => ({ number: index + 1, text: texts[index]?.text ?? "" })) });
        }} />)}</span>
    </li>)}</ul>
    <ChunkOriginalDialog value={selected} onClose={() => setSelected(null)} />
  </div>;
}

// 按来源编号分组，每组内合并同一分片；不同来源可能覆盖同一个分片。
function FinalDelivery({ question, items, unavailable = false }: { question: EvalQuestion; items: ChunkItem[]; unavailable?: boolean }) {
  const [selected, setSelected] = useState<ChunkOriginal | null>(null);
  const lists = question.answerable ? evidenceChunkLists(question) : [];
  const evidence = question.agent?.evidence.length ? question.agent.evidence : question.evidence;
  type Row = { chunkId: string | null; position?: number | null; sources: ChunkItem[]; hits: number[] };
  const groups = new Map<string, Map<string, Row>>();
  const chunks = new Set<string>();
  for (const item of items) {
    const rows = groups.get(item.id) ?? new Map<string, Row>();
    for (const chunkId of item.parts?.length ? item.parts : [item.chunkId ?? null]) {
      const key = chunkId ?? item.key;
      chunks.add(key);
      const row = rows.get(key) ?? { chunkId, position: chunkId === item.chunkId ? item.position : null, sources: [],
        hits: lists.flatMap((ids, index) => chunkId && ids.includes(chunkId) ? [index] : []) };
      if (!row.sources.some((source) => source.key === item.key)) row.sources.push(item);
      rows.set(key, row);
    }
    groups.set(item.id, rows);
  }
  return <details className="ag-delivery">
    <summary><span className="ag-tool">最终交付情况</span><small>{groups.size} 条来源 · {chunks.size} 个分片（含扩展）</small></summary>
    {unavailable ? <p className="ag-muted">这次评测没有保存最终交付资料。</p> : groups.size === 0 ? <p className="ag-muted">{question.cleared ? "资料已清空，没有最终交付。" : "没有最终交付资料。"}</p> : <ul className="ag-delivery-groups">
      {[...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([id, rows]) => <li className="ag-delivery-group" key={id}>
        <div className="ag-delivery-group-head"><SourceTag id={id} /><small>{rows.size} 个分片</small></div>
        <blockquote className="ag-delivery-quote"><ul>
          {[...rows].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([key, row]) => {
            const direct = row.sources.some((item) => !item.key.startsWith("context-") && item.chunkId === row.chunkId);
            const extended = !direct && row.sources.some((item) => !item.key.startsWith("context-"));
            return <li key={key}><button type="button" className={`ag-delivery-row ${row.hits.length ? "" : "is-non-evidence"}`} aria-haspopup="dialog" onClick={() => setSelected({ label: chunkLabel(row.position, row.chunkId), sources: row.sources, evidence: row.hits.map((index) => ({ number: index + 1, text: evidence[index]?.text ?? "" })) })}>
              <strong>{row.chunkId ? chunkLabel(row.position, row.chunkId).replace(/第 (\d+) 片/, "第$1分片") : "资料"}</strong>
              <Tag size="sm" tone={direct ? "success" : "info"} outline={extended} className={extended ? "is-dashed" : undefined}>{direct ? "检索命中" : extended ? "扩展命中" : "读前后文"}</Tag>
              <Tag size="sm" tone={row.hits.length ? "success" : "neutral"} className={row.hits.length ? undefined : "ag-non-evidence"}>{row.hits.length ? `证据 ${row.hits.map((index) => index + 1).join("、")}` : "非证据"}</Tag><small>查看原文 →</small>
            </button></li>;
          })}
        </ul></blockquote>
      </li>)}
    </ul>}
    <ChunkOriginalDialog value={selected} onClose={() => setSelected(null)} />
  </details>;
}

function agentDelivery(question: EvalQuestion): ChunkItem[] {
  const items = new Map<string, ChunkItem>();
  for (const call of question.agent?.calls ?? []) {
    for (const result of call.results ?? []) {
      // Agent 的 S 编号全程稳定；重复检索不会重复交付同一条资料。
      if (!items.has(result.evidence_id)) items.set(result.evidence_id, {
        key: result.evidence_id, id: result.evidence_id, chunkId: result.chunk_id, position: result.position,
        parts: result.parent_chunk_ids, title: result.title, heading: result.heading ?? null,
        text: result.text, hit: result.hits.length > 0, snapshotNote: call.full_text ? undefined : "历史记录仅保存正文摘要，可能不完整。"
      });
    }
    if (call.name === "read_context" && call.chunk_ids.length) items.set(`context-${call.call}`, {
      key: `context-${call.call}`, id: call.source_id ?? "—", chunkId: null, parts: call.chunk_ids,
      title: "读前后文", heading: null, text: call.text ?? "", hit: Boolean(call.read_hits?.length), snapshotNote: call.full_text ? undefined : "历史记录仅保存正文摘要，可能不完整。"
    });
  }
  return [...items.values()];
}

// Agent 某次调用的某个结果是不是靠父块扩展才含这条证据：结果检索命中的分片不在证据所在分片里。
function viaExtension(agent: EvalQuestion["agent"], where: { call: number; evidence_id: string | null }, chunkIds?: string[]) {
  if (!chunkIds?.length) return false;
  const result = agent?.calls.find((call) => call.call === where.call)?.results?.find((item) => item.evidence_id === where.evidence_id);
  return Boolean(result?.chunk_id) && !chunkIds.includes(result!.chunk_id as string);
}

// 展开后：先说每条证据在哪个分块（两边各自的编号，Agent 还标第几次调用），下面左右两栏只列分块编号。
// 固定流程的检索参数（一行显示）：检索方式、候选池、返回段数、相关度阈值；专项只知道检索方式。
function fixedParams(config: EvalRun["config"] & { search_label?: string }) {
  const parts = [config.search_label ?? "混合检索"];
  if (config.pool_size) parts.push(`候选池 ${config.pool_size}`);
  if (config.return_limit) parts.push(`返回 ${config.return_limit} 段`);
  if (config.reranked === false) parts.push("不重排");
  else if (typeof config.min_score === "number") parts.push(`阈值 ${config.min_score.toFixed(2)}`);
  return parts;
}

// 这批分块命中了第几条证据（从 0 开始）：证据所在的分片出现在某个分块（含父块扩展拼进来的分片）里就算。
function hitEvidence(items: ChunkItem[], evidenceLists: string[][]) {
  const given = new Set(items.flatMap((item) => item.parts?.length ? item.parts : item.chunkId ? [item.chunkId] : []));
  return evidenceLists.flatMap((chunkIds, index) => (chunkIds.some((chunkId) => given.has(chunkId)) ? [index] : []));
}

// 标题行上的结果：命中了哪几条证据，或者没命中。
function HitTag({ hits, total }: { hits: number[]; total: number }) {
  if (total === 0) return null;
  return hits.length ? <Tag tone="success" dot>命中证据 {hits.map((index) => index + 1).join("、")}</Tag> : <Tag outline plain>没命中证据</Tag>;
}

// 第一次检索里，一条证据合并之后的去向：交给模型了，或者丢在哪一步（没召回 / 没进候选池 / 重排分低于阈值 / 超出返回段数）。
function mergeOutcome(fixed: EvalQuestion["evidence"][number] | undefined, given: boolean, config: EvalRun["config"]) {
  if (given) return { ok: true, text: "交给模型了" };
  const score = typeof fixed?.rerank_probability === "number" ? `重排分 ${fixed.rerank_probability.toFixed(2)}` : "";
  switch (fixed?.status) {
    case "not_recalled": case undefined: return { ok: false, text: "每一路都没召回" };
    case "not_in_pool": return { ok: false, text: `合并后排第 ${fixed.rrf_rank ?? "—"} 名，没进候选池（前 ${config.pool_size ?? "—"} 段）` };
    case "filtered_low_score": return { ok: false, text: `进了重排，${score ? `${score}，` : "重排分"}低于阈值 ${typeof config.min_score === "number" ? config.min_score.toFixed(2) : "—"}，被过滤` };
    case "beyond_limit": return { ok: false, text: `${score ? `${score}，` : ""}重排第 ${fixed.rerank_rank ?? "—"} 名，超出返回的 ${config.return_limit ?? "—"} 段` };
    default: return { ok: false, text: "进了候选池，但没交给模型" };
  }
}

function QuestionDetail({ question, hasFixed, params, config }: { question: EvalQuestion; hasFixed: boolean; params: string[]; config: EvalRun["config"] }) {
  const agent = question.agent;
  // 上面只列证据原文和所在分块；两边各自拿没拿到、怎么拿到的，看下面两张卡片里的「证据命中情况」。
  const texts = (agent?.evidence ?? []).length ? agent!.evidence : question.evidence;
  return <div className="ev-question-body">
    {agent?.error && <p className="ev-lost-hint">Agent 运行失败：{agent.error}</p>}
    {question.answerable ? <div className="ag-evidence-list">{texts.map((evidence, index) => {
      const fixedChunk = question.evidence?.[index]?.chunk_id;
      const chunkIds = "chunk_ids" in evidence && evidence.chunk_ids?.length ? evidence.chunk_ids : fixedChunk ? [fixedChunk] : [];
      const positions = "positions" in evidence ? evidence.positions : undefined;
      return <div className="ag-evidence" key={index}>
        <p>证据 {index + 1}：“{evidenceLabel(evidence.text)}”</p>
        <span className="ag-evidence-chunk">所在分块 {chunkIds.length ? chunkIds.map((chunkId, order) => <code key={chunkId} title={chunkId}>{chunkLabel(positions?.[order], chunkId)}</code>) : "知识库里没找到"}</span>
      </div>;
    })}</div> : <p className="ev-muted-note">没有答案的题，拿到的资料越少越好。</p>}
    <div className={`ag-columns ${hasFixed ? "" : "is-single"}`}>
      {hasFixed && <FixedLog question={question} params={params} config={config} />}
      {agent && <AgentLog question={question} />}
    </div>
  </div>;
}

function FixedLog({ question, params, config }: { question: EvalQuestion; params: string[]; config: EvalRun["config"] }) {
  const [expanded, setExpanded] = useState(false);
  // 证据所在的分片（Agent 记的所在分块，或固定流程命中的分片）；来源是父块，父块里任何一片含证据都算命中。
  const evidenceChunks = new Set<string>();
  for (const item of question.agent?.evidence ?? []) for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  for (const item of question.evidence ?? []) if (item.chunk_id) evidenceChunks.add(item.chunk_id);
  const hitSources = new Set((question.evidence ?? []).filter((item) => item.status === "returned").map((item) => item.source_id));
  const items: ChunkItem[] = (question.sources ?? []).map((source) => {
    const extra = source as { chunk_id?: string; position?: number | null; parent_chunk_ids?: string[] };
    const parts = extra.parent_chunk_ids ?? (extra.chunk_id ? [extra.chunk_id] : []);
    return {
      key: source.id, id: source.id, chunkId: extra.chunk_id ?? null, position: extra.position ?? null, parts, title: source.title,
      heading: source.heading ?? null, text: source.text, evidenceParts: new Set(parts.filter((chunkId) => evidenceChunks.has(chunkId))),
      hit: hitSources.has(source.id) || parts.some((chunkId) => evidenceChunks.has(chunkId))
    };
  });
  // 补充检索的来源：父块里任何一片含证据都算命中。
  const retry = question.retry;
  const retryItems: ChunkItem[] = (retry?.sources ?? []).map((source) => {
    const parts = source.parent_chunk_ids ?? (source.chunk_id ? [source.chunk_id] : []);
    return {
      key: `retry-${source.id}`, id: source.id, chunkId: source.chunk_id ?? null, position: source.position ?? null, parts, title: source.title,
      heading: source.heading ?? null, text: source.text, evidenceParts: new Set(parts.filter((chunkId) => evidenceChunks.has(chunkId))),
      hit: parts.some((chunkId) => evidenceChunks.has(chunkId))
    };
  });
  const sufficiency = question.sufficiency;
  const searches = 1 + (sufficiency?.retried ? 1 : 0);
  const usedRetry = Boolean(sufficiency?.retry_used);
  // 每条证据所在的分片（Agent 记的所在分块，旧记录用固定流程命中的分片），用来算每次检索命中了第几条证据。
  const evidenceLists = (question.agent?.evidence ?? []).length
    ? (question.agent?.evidence ?? []).map((item) => item.chunk_ids ?? [])
    : (question.evidence ?? []).map((item) => (item.chunk_id ? [item.chunk_id] : []));
  const total = question.answerable ? evidenceLists.length : 0;
  const queries = question.queries ?? [];
  // 按扩展查询里的顺序排每一路（旧记录没有 query_routes 时是空的，退回只列检索词）。
  const routes = [...(question.query_routes ?? [])].sort((a, b) => queries.indexOf(a.query) - queries.indexOf(b.query));
  return <section className="ag-log">
    <div className="ag-log-title">固定流程<small>检索 {searches} 次{sufficiency?.checked ? ` · 判断 ${sufficiency.calls ?? 1} 次` : ""} · 耗时 {formatMs(question.flow_latency_ms ?? question.latency_ms)}</small></div>
    <EvidenceStatus rows={fixedEvidenceRows(question, config)} expanded={expanded} onToggle={() => setExpanded(!expanded)}>
      <FinalDelivery question={question} items={question.cleared ? [] : usedRetry ? retryItems : items} unavailable={!question.cleared && (usedRetry ? !retry?.sources : !question.sources)} />
    </EvidenceStatus>
    {expanded && <p className="ag-muted ag-numbering-note">命中：含证据的来源；S1、S2 是本次检索的来源编号，点击查看原文。</p>}
    {expanded && <>
      {question.rewrite && <div className="ag-flow-step is-block">
        <div className="ag-step-head"><span className="ag-tool">改写</span><span>{rewriteLabel(question)}</span>
          {question.rewrite.duration_ms !== undefined && question.rewrite.classifier === "llm" && <Tag outline plain>耗时 {formatMs(question.rewrite.duration_ms)}{question.rewrite.cached ? "（缓存，当时）" : ""}</Tag>}</div>
        {question.rerank_query && question.rerank_query !== question.question && <div className="ag-step-row"><span className="ag-row-label">补全后的问题</span><span>{question.rerank_query}</span></div>}
        <div className="ag-step-row"><span className="ag-row-label">扩展查询（{queries.length} 路）</span>
          {routes.length ? <span className="ag-muted">每一路分别检索，见下方检索</span>
            : <div><ul className="ag-query-list">{queries.map((query) => <li key={query}>{query}</li>)}</ul>
              {queries.length > 1 && <small className="ag-muted">每一路分别检索，结果合并后再重排</small>}</div>}</div>
      </div>}
      <div className={`ag-call ${usedRetry ? "is-unused" : ""}`}>
        <div className="ag-call-head"><span className="ag-tool">{sufficiency?.retried ? "第 1 次 · " : ""}检索</span>
          <Tag outline plain>耗时 {formatMs(question.latency_ms)}</Tag><HitTag hits={hitEvidence(items, evidenceLists)} total={total} />
          {usedRetry && <Tag outline plain>没采用（换成了补充检索的结果）</Tag>}</div>
        {!question.rewrite && !routes.length && <ul className="ag-query-list">{queries.map((query) => <li key={query}>{query}</li>)}</ul>}
        <div className="ag-call-params">{params.join(" · ")}</div>
        {/* 每一路检索词分别检索（和 Agent 同一轮同时发出的几次检索对应），再合并、重排、过滤成最后的结果。 */}
        {/* 只有 1 路时不再套一层「检索」框（外面已经是检索这一步），直接列这一路。 */}
        {routes.length > 0 && <div className={routes.length > 1 ? "ag-round is-parallel" : "ag-single-route"}>
          {routes.length > 1 && <div className="ag-round-head">同时检索 {routes.length} 路<Tag size="sm" tone="warning">每路分别检索，合并后重排</Tag></div>}
          {routes.map((route, index) => <div className="ag-route" key={route.query}>
            <div className="ag-call-head"><span className="ag-tool">第 {index + 1} 路</span>
              <Tag outline plain>召回 {route.recalled} 段</Tag><Tag outline plain>留到最后 {route.kept} 段</Tag></div>
            <div className="ag-call-query">{route.query}</div>
            {/* 这一路召回到了哪几条证据、各排第几（向量、关键词两张排名表）。 */}
            {total > 0 && <ul className="ag-evidence-trace">{Array.from({ length: total }, (_, evidence) => {
              const best = route.best.find((item) => item.evidence === evidence);
              const ranks = [best?.dense ? `向量第 ${best.dense} 名` : "", best?.keyword ? `关键词第 ${best.keyword} 名` : ""].filter(Boolean).join("、");
              return route.evidence.includes(evidence)
                ? <li key={evidence} className="is-hit"><b>✓</b>证据 {evidence + 1}<small>召回到了{ranks ? ` · ${ranks}` : ""}</small></li>
                : <li key={evidence} className="is-miss"><b>—</b>证据 {evidence + 1}<small>这一路没召回</small></li>;
            })}</ul>}
          </div>)}
        </div>}
        {routes.length > 0 && <div className="ag-merge-label">合并 → 前 {config.pool_size ?? "—"} 段进重排 → 过阈值 {typeof config.min_score === "number" ? config.min_score.toFixed(2) : "—"} → 最多 {config.return_limit ?? "—"} 段交给模型</div>}
        <ChunkTabs question={question} items={items} empty="过滤后没有分块。" />
      </div>
      {sufficiency && <SufficiencySteps question={question} part="first" />}
      {retry && <div className={`ag-call ${usedRetry ? "" : "is-unused"}`}>
        <div className="ag-call-head"><span className="ag-tool">第 2 次 · 补充检索</span>
          <HitTag hits={hitEvidence(retryItems, evidenceLists)} total={total} /><Tag outline plain>{usedRetry ? "采用了" : "没变好，沿用第一次的"}</Tag></div>
        <ul className="ag-query-list">{queries.map((query) => <li key={query}>{query}</li>)}{sufficiency?.retry_query && <li className="is-added">{sufficiency.retry_query}<small>补充的</small></li>}</ul>
        <div className="ag-call-params">{params.join(" · ")} · 返回 {retry.returned} 段</div>
        {retry.sources ? <ChunkTabs question={question} items={retryItems} empty="补充检索没有返回分块。" /> : <p className="ag-muted">这次评测没有保存补充检索的分块。</p>}
      </div>}
      {sufficiency && retry && <SufficiencySteps question={question} part="rest" />}
      {question.cleared && <div className="ag-flow-cleared">判断资料不足，已清空：线上会直接拒答。</div>}
      <MaterialLine material={fixedMaterial(question)} />
    </>}
  </section>;
}

const VERDICT_LABELS: Record<string, string> = { sufficient: "够了", partial: "只够一部分", insufficient: "不够" };

// 充分性判断：每次判断的结论和缺什么。补充检索后会再判断一次，按发生的顺序放：
// part="first" 放在第一次检索后面（没有补充检索时放全部），part="rest" 放在补充检索后面。
function SufficiencySteps({ question, part }: { question: EvalQuestion; part: "first" | "rest" }) {
  const sufficiency = question.sufficiency!;
  if (part === "rest" && !sufficiency.checked) return null;
  if (!sufficiency.checked) return <div className="ag-flow-step"><span className="ag-tool">充分性判断</span><span className="ag-muted">{question.returned === 0 ? "第一次检索没有来源，不用判断" : "没做（要真实大模型并打开充分性判断）"}</span></div>;
  const judgements = sufficiency.judgements?.length ? sufficiency.judgements : [{ verdict: sufficiency.verdict ?? "", missing: typeof sufficiency.missing === "string" ? sufficiency.missing : "", rewrite_query: sufficiency.retry_query ?? "" }];
  const start = part === "rest" ? 1 : 0;
  const end = part === "first" && question.retry ? 1 : judgements.length;
  return <>{judgements.slice(start, end).map((judgement, offset) => ({ judgement, index: start + offset })).map(({ judgement, index }) => <div key={index} className={`ag-flow-step is-judge is-${judgement.verdict}`}>
    <span className="ag-tool">{judgements.length > 1 ? `第 ${index + 1} 次判断` : "充分性判断"}</span>
    <strong>{VERDICT_LABELS[judgement.verdict] ?? judgement.verdict}</strong>
    {judgement.missing && <span>缺：{judgement.missing}</span>}
    {judgement.error && <span className="ag-warn">{judgement.error}</span>}
    {index === 0 && judgement.rewrite_query && judgement.verdict !== "sufficient" && <span>补充检索词 <code>{judgement.rewrite_query}</code></span>}
  </div>)}</>;
}

// （资料池逐段列表已去掉，只显示段数；证据怎么拿到的看「证据命中情况」。）
function AgentLog({ question }: { question: EvalQuestion }) {
  const [expanded, setExpanded] = useState(false);
  const agent = question.agent!;
  const rounds = agent.round_logs?.length
    ? agent.round_logs.map((record) => ({ ...record, calls: agent.calls.filter((call) => call.round === record.round) }))
    : groupByRound(agent.calls).map(([round, calls]) => ({ round, calls, kind: "normal", reasoning: null, content: "", error: null }));
  const fresh = freshness(question);
  const evidenceChunks = new Set<string>();
  for (const item of agent.evidence ?? []) for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  return <section className="ag-log">
    <div className="ag-log-title">Agent<small>检索 {agent.searches} 次{fresh.wasted > 0 ? `（${fresh.wasted} 次无新增）` : ""} · {agent.rounds} 轮 · {agent.prompt_tokens} token · {agent.search_ms !== undefined ? `检索 ${formatMs(agent.search_ms)} + 写回答 ${formatMs(agent.answer_ms)}` : `耗时 ${formatMs(agent.latency_ms)}`} · {STOP_LABELS[agent.stop_reason ?? ""] ?? agent.stop_reason ?? "—"}</small></div>
    <EvidenceStatus rows={agentEvidenceRows(question)} expanded={expanded} onToggle={() => setExpanded(!expanded)}>
      <FinalDelivery question={question} items={agentDelivery(question)} />
    </EvidenceStatus>
    {expanded && <p className="ag-muted ag-numbering-note">命中：含证据的来源；新增：本次新拿到的来源（可能同时命中）；已有：之前拿到且未命中的来源。点击编号查看原文。</p>}
    {expanded && <>
      {agent.question_sent !== question.question && <div className="ag-call-meta">实际提问（多轮追问按规则补全）：{agent.question_sent}</div>}
      {agent.calls.length === 0 && <p className="ag-muted">没有调用任何工具，直接回答了。</p>}
      {/* 按轮分组：同一轮里模型同时发出的几次调用放在一个框里，它们彼此看不到对方的结果。 */}
      {rounds.map(({ round, calls, kind, reasoning, content, error }, index) => <details key={`${round}-${index}`} open={index === 0} className={`ag-round ag-collapsible-round ${calls.length > 1 ? "is-parallel" : ""}`}>
        <summary className="ag-round-head">第 {round ?? "—"} 轮{calls.length > 1 ? <Tag size="sm" tone="warning">同时发出 {calls.length} 次，彼此看不到结果</Tag> : null}<span className="ag-round-toggle" aria-hidden="true" /></summary>
        {reasoning ? <details className="ag-round-reasoning ag-reasoning-collapse">
          <summary><span className="ag-tool">Agent 推理过程</span><span className="ag-reasoning-toggle" aria-hidden="true" />
            <span className="ag-round-text ag-reasoning-preview">{reasoning}</span>
          </summary>
          <div className="ag-round-text">{reasoning}</div>
        </details> : <div className="ag-round-reasoning"><div className="ag-tool">Agent 推理过程</div>
          <p className="ag-muted">{reasoning === null ? "这条历史记录没有保存本轮推理过程。" : "模型未返回本轮推理过程。"}</p>
        </div>}
        {error && <p className="ag-warn">本轮出错：{error}</p>}
        {kind === "forced" && <p className="ag-muted">{agent.stop_reason === "timeout" ? "时间到了" : "工具预算用完"}，不带工具直接回答。</p>}
        {content && <details className="ag-round-output"><summary>{calls.length ? "本轮模型说明" : "本轮回答"}</summary><div className="ag-round-text">{content}</div></details>}
        {calls.map((call) => <AgentCall question={question} key={call.call} call={call} fresh={fresh.perCall.get(call.call) ?? new Set()} evidenceChunks={evidenceChunks} />)}
      </details>)}
      {/* 预算用完或超时后，程序再让模型跑一轮不带工具的，直接写回答；这一轮没有检索。 */}
      {agent.forced && !agent.round_logs?.length && <details className="ag-round ag-collapsible-round" open={rounds.length === 0}><summary className="ag-round-head">第 {agent.rounds} 轮<span className="ag-round-toggle" aria-hidden="true" /></summary><p className="ag-muted">{agent.stop_reason === "timeout" ? "时间到了" : "工具预算用完"}，不带工具直接回答，没有检索。这条历史记录没有保存本轮推理过程。</p></details>}
      <MaterialLine material={agentMaterial(question)} />
    </>}
  </section>;
}

// 把调用按轮次分组（保持原来的顺序）；旧记录没有轮次时每次调用单独一组。
function groupByRound(calls: EvalAgentCall[]) {
  const groups: [number | null, EvalAgentCall[]][] = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && call.round !== null && call.round !== undefined && last[0] === call.round) last[1].push(call);
    else groups.push([call.round ?? null, [call]]);
  }
  return groups;
}

function AgentCall({ call, fresh, evidenceChunks, question }: { question: EvalQuestion; call: EvalAgentCall; fresh: Set<string>; evidenceChunks: Set<string> }) {
  const status = CALL_STATUS[call.status] ?? call.status;
  const hit = call.hits.length > 0;
  const executed = call.status === "ok" || call.status === "error";
  const newCount = call.new_chunks ?? fresh.size;
  let items: ChunkItem[] = [];
  if (call.results) items = call.results.map((result) => ({
    key: `${call.call}-${result.evidence_id}`, id: result.evidence_id, chunkId: result.chunk_id, position: result.position ?? null, parts: result.parent_chunk_ids, evidenceParts: new Set((result.parent_chunk_ids ?? []).filter((chunkId) => evidenceChunks.has(chunkId))), title: result.title,
    heading: result.heading ?? null, text: result.text, relevance: result.relevance, low: result.low_relevance, hit: result.hits.length > 0,
    fresh: Boolean(result.chunk_id) && fresh.has(result.chunk_id as string),
    snapshotNote: call.full_text ? undefined : "历史记录仅保存正文摘要，可能不完整。"
  }));
  else if (call.name === "read_context" && call.text) items = [{
    key: `${call.call}-read`, id: `${call.source_id ?? ""} ${call.direction === "before" ? "前文" : "后文"}`,
    position: call.positions?.length ? call.positions[0] : null, chunkId: call.chunk_ids[0] ?? null,
    fresh: call.chunk_ids.some((chunkId) => fresh.has(chunkId)),
    title: null, heading: null, text: call.text, hit: (call.read_hits ?? []).length > 0,
    snapshotNote: call.full_text ? undefined : "历史记录仅保存正文摘要，可能不完整。"
  }];
  return <div className={`ag-call ${call.status !== "ok" ? "is-off" : ""} ${hit ? "is-hit" : ""}`}>
    {/* 标题行放结果（耗时、命中、新增）；下面一行是检索的问题，再下一行是参数。 */}
    <div className="ag-call-head">
      <span className="ag-tool">第 {call.call} 次 · {TOOL_LABELS[call.name] ?? call.name}</span>
      {call.duration_ms !== undefined && call.duration_ms !== null && <Tag outline plain>耗时 {formatMs(call.duration_ms)}</Tag>}
      {hit ? <Tag tone="success" dot>命中证据 {call.hits.map((index) => index + 1).join("、")}</Tag>
        : executed && (call.name === "search_knowledge" || call.name === "read_context") ? <Tag outline plain>没命中证据</Tag> : null}
      {executed && (call.name === "search_knowledge" || call.name === "read_context") && (newCount > 0
        ? <Tag>新增 {newCount} 片</Tag>
        : <Tag tone="warning" title="这次拿回的分块，前面的调用都已经拿到过">无新增</Tag>)}
    </div>
    {call.name === "search_knowledge" && call.query !== undefined ? <>
      <div className="ag-call-query">{call.query}</div>
      <div className="ag-call-params">{SEARCH_MODE_LABELS[call.mode ?? ""] ?? call.mode} · Top K {call.top_k}</div></>
      : call.name === "read_context" && call.source_id ? <div className="ag-call-query">{call.source_id} 的{call.direction === "before" ? "前文" : "后文"}</div>
        : <div className="ag-call-query"><code>{JSON.stringify(call.arguments)}</code></div>}
    {status && <div className="ag-call-meta">{status}{call.error ? `：${call.error}` : ""}</div>}
    {call.note && call.status !== "ok" && <div className="ag-call-meta">{call.note}</div>}
    {(call.results || call.name === "read_context") && <ChunkTabs question={question} items={items} empty={call.results ? "没有返回分块（空检索）。" : "没有读到内容。"} />}
  </div>;
}

// ---------- 专项评测里的 Agent ----------

// 和上次比：上次没通过、这次通过算新通过，反过来算新失败；上次没跑过这个模式就不标。
function change(now: boolean | undefined, before: boolean | null | undefined) {
  if (now === undefined || before === undefined || before === null || before === now) return null;
  return now ? "新通过" : "新失败";
}

// 专项的一道题转成调参评测逐题对比用的格式，复用同一个列表和左右两栏的检索日志。
function fromSpecial(question: EvalSpecialQuestion, hasFixed: boolean, seq: number): EvalQuestion {
  const notes = [hasFixed ? change(question.fixed_passed, question.previous_passed) && `固定流程${change(question.fixed_passed, question.previous_passed)}` : null,
  change(question.agent_passed, question.previous_agent_passed) && `Agent ${change(question.agent_passed, question.previous_agent_passed)}`].filter(Boolean);
  const recall = question.recall_final ?? (question.fixed_passed ? 1 : 0);
  return {
    id: question.id, seq, question: question.question, type: question.type ?? "未分类", answerable: true,
    evidence_count: question.evidence_count ?? question.agent?.evidence.length ?? 0,
    stages: (hasFixed ? { pool: { recall, rr: 0, rank: null }, top: { recall, rr: 0, rank: null }, final: { recall, rr: 0, rank: null } } : undefined) as EvalQuestion["stages"],
    lost_stage: question.lost_stage ?? null,
    evidence: (question.fixed_evidence ?? []).map((item) => ({
      ...item, rrf_rank: item.rrf_rank ?? null, rerank_rank: item.rerank_rank ?? null,
      rerank_probability: item.rerank_probability ?? null, status: item.status ?? "not_recalled"
    })),
    given_recall: question.given_recall,
    returned: question.returned ?? 0, max_probability: null, latency_ms: question.latency_ms ?? 0,
    queries: question.queries ?? [], rerank_query: question.rerank_query ?? "", query_source: question.rewrite?.classifier ?? "rule",
    first_given_recall: question.first_given_recall, given_hits: question.given_hits, ext_hits: question.ext_hits, rewrite: question.rewrite, retry: question.retry, cleared: question.cleared,
    flow_latency_ms: question.flow_latency_ms, material: question.material, sufficiency: question.sufficiency ?? undefined, query_routes: question.query_routes,
    sources: question.sources, agent: question.agent, compare: question.compare, note: notes.join(" · ") || undefined,
  };
}

// 按类型统计：从逐题结果现算（通过数、证据命中条数、得分），旧记录后端没存证据命中和得分也能显示。
function specialTypeStats(questions: EvalSpecialQuestion[], hasFixed: boolean, hasAgent: boolean): TypeStat[] | null {
  const groups = new Map<string, TypeStat & { fixedScores: number[]; agentScores: number[]; fixedMaterials: EvalMaterial[]; agentMaterials: EvalMaterial[] }>();
  for (const question of questions) {
    if (!question.type) continue;
    const group = groups.get(question.type) ?? { type: question.type, count: 0, passed: 0, fixedScores: [], agentScores: [], fixedMaterials: [], agentMaterials: [] };
    if (hasFixed && question.material) group.fixedMaterials.push(question.material);
    else if (hasFixed && question.cleared) group.fixedMaterials.push({ count: 0, chars: 0, tokens: 0 });
    else if (hasFixed && question.sources) group.fixedMaterials.push({
      count: question.sources.length, chars: 0,
      tokens: question.sources.reduce((sum, source) => sum + textTokens(source.text ?? ""), 0)
    });
    if (hasAgent && question.agent?.material) group.agentMaterials.push(question.agent.material);
    groups.set(question.type, group);
    const total = question.evidence_count ?? question.fixed_evidence?.length ?? question.agent?.evidence.length ?? 0;
    group.count += 1;
    group.passed += question.passed ? 1 : 0;
    group.evidence_total = (group.evidence_total ?? 0) + total;
    if (hasFixed) {
      const hits = question.cleared ? 0 : question.fixed_evidence?.length ? question.fixed_evidence.filter((item) => item.given).length : question.given_hits ?? 0;
      group.fixed_passed = (group.fixed_passed ?? 0) + (question.fixed_passed ? 1 : 0);
      group.fixed_hits = (group.fixed_hits ?? 0) + hits;
      const score = questionScore(true, hits, total);
      if (score !== null) group.fixedScores.push(score);
    }
    if (hasAgent && question.agent) {
      const hits = question.agent.evidence.filter((item) => item.found).length;
      group.agent_passed = (group.agent_passed ?? 0) + (question.agent_passed ? 1 : 0);
      group.agent_hits = (group.agent_hits ?? 0) + hits;
      const score = questionScore(true, hits, question.agent.evidence.length || total);
      if (score !== null) group.agentScores.push(score);
    }
  }
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  const stats = [...groups.values()].map(({ fixedScores, agentScores, fixedMaterials, agentMaterials, ...group }) => ({
    ...group,
    fixed_score: average(fixedScores), agent_score: average(agentScores),
    fixed_material_count: average(fixedMaterials.map((item) => item.count)), fixed_material_tokens: average(fixedMaterials.map((item) => item.tokens)),
    agent_material_count: average(agentMaterials.map((item) => item.count)), agent_material_tokens: average(agentMaterials.map((item) => item.tokens))
  }));
  return stats.length ? stats : null;
}

// 检索方式的专项勾了 Agent 时的结果：两边的通过数（和上次比）、对比分类，下面是逐题对比列表。
export function SpecialAgentResults({ section }: { section: EvalSpecialSection }) {
  const modes = section.modes ?? ["fixed"];
  const hasFixed = modes.includes("fixed");
  const questions = section.questions.map((question, index) => fromSpecial(question, hasFixed, index + 1));
  const counts = { both: 0, fixed_only: 0, agent_only: 0, neither: 0 } as Record<EvalCompareKey, number>;
  for (const question of section.questions) if (question.compare) counts[question.compare] += 1;
  const run = { questions, config: { ...section.run_config, split: null, suites: [], modes, search_label: section.search_mode_label } } as unknown as EvalRun;
  const typeStats = specialTypeStats(section.questions, hasFixed, modes.includes("agent"));
  return <div className="ev-overview ag-eval ag-special">
    {hasFixed && section.search_mode && section.search_mode !== "hybrid" && <p className="ev-settings-diff">这个专项设置了「{section.search_mode_label}」，和 Agent 比不公平，请用混合检索。</p>}
    <ModeCards questions={questions} config={{ ...section.run_config, agent: section.agent ?? section.run_config?.agent, search_label: section.search_mode_label } as EvalConfig} hasFixed={hasFixed} hasAgent={modes.includes("agent")} />
    {hasFixed && <CompareLine counts={counts} />}
    {typeStats && <><div className="ev-section-title">按类型<small>哪类题 Agent 更强、哪类固定流程就够了</small></div>
      <TypeStats stats={typeStats} hues={typeHues(section.questions.map((question) => question.type))} both={hasFixed} /></>}
    <AgentQuestionList run={run} hasFixed={hasFixed} />
  </div>;
}
