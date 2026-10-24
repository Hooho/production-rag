import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { addEvalDatasetItem, addEvalDatasetPair, compareEvalRuns, listEvalSuites, startSpecialRun, type EvalSuiteBrief, deleteEvalRun, generateEvalDatasetItems, getEvalDataset, getEvalRun, listEvalRuns, reviewEvalDatasetItem, startEvalRun, type EvalComparison, type EvalComparisonRow, type EvalDataset, type EvalHistoryMetrics, type EvalItem, type EvalParaphraseAnalysis, type EvalQuestion, type EvalRun, type EvalRunBrief, type EvalMode, type EvalSufficiency, type EvalSuite, type EvalSummary, type EvalLimitPoint, type EvalSweepPoint, type RetrievalDiagnosticsData } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import Regression from "./Regression";
import Special, { SpecialSection } from "./Special";
import { EvidenceDetails } from "./EvidenceChunks";
import "./Special.css";
// 耗时格式化移到公共文件，知识库、问答、设置页共用同一套规则。
import { durationTitle, formatDuration as formatMs, formatDurationDelta } from "./format";
import { AgentPanel, ComparePanel, modesLabel, rewriteLabel, runModes } from "./AgentEval";
import { HueTag, Tag } from "./Tag";
import { runStatus } from "./tags";
import { settingLabel } from "./SystemSettings";

export type EvaluationSection = "history" | "dataset" | "special" | "regression";
type TopTab = EvaluationSection;
type DetailTab = "overview" | "questions" | "sweep" | "variants";
// 勾了 Agent 的检索评测：第一层按模式分页签（对比、固定流程、Agent），固定流程里再分原来的四个子页签。
type ModeTab = "compare" | "fixed" | "agent";
const MODE_TAB_LABELS: Record<ModeTab, string> = { compare: "对比", fixed: "固定流程", agent: "Agent" };
// memory 是以前单独的多轮对话评测，现在并入专项评测集，只用来显示旧记录。
type EvalKind = "retrieval" | "generation" | "memory" | "special";
type LaunchKind = "retrieval" | "generation";
const KIND_LABELS: Record<EvalKind, string> = { retrieval: "检索", generation: "生成", memory: "多轮对话", special: "专项" };

// 评测页面单独成一个文件：App.tsx 已有一千多行且还在频繁修改，评测页面有六个子视图，放在一起会让两边的改动互相冲突。
// 检索诊断面板由 App 以参数传入，直接复用问答页面同一个组件，避免两份实现各自演化。
type ShowToast = (kind: "success" | "error", message: string) => void;
type Props = {
  Diagnostics: ComponentType<{ data: RetrievalDiagnosticsData }>;
  section: EvaluationSection;
  // 巡检复测集页签里打开的评测集，来自地址 /eval/regression/<编号>。
  setId?: string;
  // 专项评测集页签里打开的专项，来自地址 /eval/special/<编号>。
  suiteId?: string;
  onNavigate: (path: string) => void;
  onToast: ShowToast;
};

const TOP_TAB_LABELS: Record<TopTab, string> = {
  history: "历史评测记录",
  dataset: "调参评测集",
  special: "专项评测集",
  regression: "巡检复测集",
};
const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  overview: "总览",
  questions: "逐题明细",
  sweep: "阈值与段数",
  variants: "消融与参数",
};
const SPLIT_LABELS: Record<string, string> = { dev: "开发集", holdout: "留出集", all: "全部题目" };
// 丢失阶段的说明：告诉读者该去优化哪一环。
const LOST_LABELS: Record<string, { label: string; hint: string }> = {
  recall: { label: "未进候选池", hint: "证据没进候选池：查检索词、分块或召回" },
  rerank: { label: "重排后掉出前列", hint: "重排把证据排到了返回数量之外" },
  threshold: { label: "被阈值误杀", hint: "重排分数低于阈值被丢弃，阈值可能偏高" },
};
const EVIDENCE_STATUS: Record<string, string> = {
  returned: "已返回", beyond_limit: "超出返回数", filtered_low_score: "低于阈值", in_pool: "候选池", not_in_pool: "未进重排", not_recalled: "未召回",
};
// 操作栏直接解释每个实验开关，用户能在勾选前知道实验目的和会运行的变体。
// 实验组只比第一次检索：用基线同一批检索词，只换检索参数。
const SUITE_DESCRIPTIONS: Record<string, string> = {
  ablation: "每次去掉一种检索组件，看它贡献多少",
  params: "只换候选池大小或多查询融合方式",
};
// 题型筛选说明跟随当前选项变化，帮助用户在题目卡片前理解这一组题检验的能力。
const DATASET_TYPE_DESCRIPTIONS: Record<string, string> = {
  all: "全部题型。",
  事实: "直接问语料里的事实，看能不能找回原文。",
  同义改写: "换个说法问同一件事，看检索能不能认出来。",
  关键词: "短的关键词式问题，看关键词检索。",
  多轮追问: "接着上一轮追问，看能不能补全问题。",
  无法回答: "语料里没有答案，看能不能正确拒答。",
};
// 题目卡片补充每道题的评测目标，避免用户只能看到类型名称却不知道这道题具体在测什么。
const DATASET_TYPE_CARD_DETAILS: Record<string, string> = {
  事实: "能不能找回原文证据。",
  同义改写: "换了说法还能不能找到。",
  关键词: "靠专有名词能不能找到。",
  多轮追问: "能不能接上上一轮补全问题。",
  无法回答: "应该拒答，不返回误导性来源。",
};

// 根据已完成和总检索次数计算进度百分比。
function progressPercent(run: EvalRunBrief) {
  if (!run.progress || !run.progress.total) return 0;
  return Math.round((run.progress.done / run.progress.total) * 100);
}

// 把"x / y 次检索"拆开解释：总次数 = 题数 × 配置组数（基线 + 勾选的实验组），并指出当前正在跑哪一组。
// 以前只显示 16 / 77，看不出 77 从哪来，也不知道进度条为什么比题数走得慢。
// 后端按"先跑完基线，再依次跑各实验组"的顺序推进，所以用已完成次数除以题数就能算出当前组。
function progressBreakdown(run: EvalRunBrief, suites: EvalSuite[]) {
  const total = run.progress?.total ?? 0;
  if (!total) return "";
  const groups = ["基线（当前线上配置）"];
  const parts: string[] = [];
  for (const suite of suites) {
    if (!run.config.suites.includes(suite.key)) continue;
    parts.push(`${suite.label}（${suite.variants.length} 组）`);
    for (const variant of suite.variants) groups.push(variant);
  }
  const questions = Math.round(total / groups.length);
  const splitLabel = SPLIT_LABELS[run.config.split ?? ""] ?? run.config.split;
  const groupText = parts.length ? `${parts.join("和")}，再加上基线，一共 ${groups.length} 组配置` : "只跑基线（当前线上配置），1 组配置";
  const done = run.progress?.done ?? 0;
  const index = Math.min(groups.length - 1, Math.floor(done / Math.max(1, questions)));
  const current = done >= total ? "" : `；正在运行第 ${index + 1} 组“${groups[index]}”，本组已完成 ${done - index * questions} / ${questions} 题`;
  return `${splitLabel}有 ${questions} 道题；${groupText}；每组配置都要把 ${questions} 道题各检索一遍：${questions} × ${groups.length} = ${total}${current}。`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number | null | undefined, digits = 3) {
  if (value === null || value === undefined) return "—";
  return value.toFixed(digits);
}


function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

const SUFFICIENCY_LABELS: Record<string, string> = {
  sufficient: "资料充分",
  partial: "资料部分充分",
  insufficient: "资料不足",
};

// 统一补充检索结果中的缺失信息格式，兼容历史数据可能保存为字符串或数组的情况。
function sufficiencyMissingText(value: EvalSufficiency["missing"]) {
  if (Array.isArray(value)) return value.join("、");
  return value || "";
}

type SufficiencyStats = {
  observed: number;
  checked: number;
  sufficient: number;
  partial: number;
  insufficient: number;
  retried: number;
  retryQuestions: number;
  retryFinalChunks: number;
};

// 汇总生成评测保存的充分性结论；补充检索后的 chunk 数只统计触发过补检的题，避免和首次检索混在一起。
function summarizeSufficiency(run: EvalRun): SufficiencyStats | null {
  const stats: SufficiencyStats = { observed: 0, checked: 0, sufficient: 0, partial: 0, insufficient: 0, retried: 0, retryQuestions: 0, retryFinalChunks: 0 };
  for (const question of run.questions ?? []) {
    const sufficiency = question.sufficiency;
    if (!sufficiency) continue;
    stats.observed += 1;
    if (!sufficiency.checked) continue;
    stats.checked += 1;
    if (sufficiency.verdict === "sufficient") stats.sufficient += 1;
    if (sufficiency.verdict === "partial") stats.partial += 1;
    if (sufficiency.verdict === "insufficient") stats.insufficient += 1;
    if (sufficiency.retried) {
      stats.retried += 1;
      if (typeof sufficiency.source_count === "number") {
        stats.retryQuestions += 1;
        stats.retryFinalChunks += sufficiency.source_count;
      }
    }
  }
  return stats.observed > 0 ? stats : null;
}

type HistoryEvidenceStats = {
  answerableQuestions: number;
  unanswerableQuestions: number;
  evidenceTotal: number;
  poolChunks: number;
  poolHits: number;
  topTotal: number;
  topChunks: number;
  topHits: number;
  finalRemaining: number;
  finalAnswerableChunks: number;
  finalHits: number;
  falseRejectQuestions: number;
  falseAcceptQuestions: number;
  givenHits?: number | null;
  agentHits?: number | null;
  clearedQuestions?: number | null;
  extHits?: number | null;
};

// 从完整评测逐题结果统计真实证据数量，说明文字与页面上的汇总百分比使用同一批数据。
function historyStageHits(question: EvalQuestion, stage: "pool" | "top" | "final") {
  if (!question.answerable || !question.evidence_count) return 0;
  return Math.round((question.stages[stage].recall ?? 0) * question.evidence_count);
}

// 汇总历史记录中实际命中的证据和剩余 chunk，避免用固定示例解释不同评测。
function summarizeHistoryEvidence(run: EvalRun): HistoryEvidenceStats | null {
  if (!run.questions) return null;
  const answerable = run.questions.filter((question) => question.answerable);
  const unanswerable = run.questions.filter((question) => !question.answerable);
  const returnLimit = run.config.return_limit ?? 6;
  let evidenceTotal = 0;
  let poolChunks = 0;
  let poolHits = 0;
  let topTotal = 0;
  let topChunks = 0;
  let topHits = 0;
  let finalRemaining = 0;
  let finalAnswerableChunks = 0;
  let finalHits = 0;
  for (const question of run.questions) {
    const poolSize = question.pool?.length ?? run.config.pool_size ?? 0;
    topTotal += Math.min(poolSize, returnLimit);
    finalRemaining += question.returned;
    if (question.answerable) {
      evidenceTotal += question.evidence_count;
      poolChunks += poolSize;
      poolHits += historyStageHits(question, "pool");
      topChunks += Math.min(poolSize, returnLimit);
      topHits += historyStageHits(question, "top");
      finalAnswerableChunks += question.returned;
      finalHits += historyStageHits(question, "final");
    }
  }
  return {
    answerableQuestions: answerable.length,
    unanswerableQuestions: unanswerable.length,
    evidenceTotal,
    poolChunks,
    poolHits,
    topTotal,
    topChunks,
    topHits,
    finalRemaining,
    finalAnswerableChunks,
    finalHits,
    falseRejectQuestions: answerable.filter((question) => question.returned === 0).length,
    falseAcceptQuestions: unanswerable.filter((question) => question.returned > 0).length,
    givenHits: answerable.some((question) => question.given_recall !== undefined && question.given_recall !== null)
      ? answerable.reduce((sum, question) => sum + (question.given_hits ?? Math.round((question.given_recall ?? 0) * question.evidence_count)), 0) : null,
    extHits: answerable.some((question) => question.ext_hits !== undefined && question.ext_hits !== null)
      ? answerable.reduce((sum, question) => sum + (question.ext_hits ?? 0), 0) : null,
    agentHits: answerable.some((question) => question.agent) ? answerable.reduce((sum, question) => sum + (question.agent?.evidence ?? []).filter((item) => item.found).length, 0) : null,
    clearedQuestions: answerable.some((question) => question.cleared !== undefined) ? answerable.filter((question) => question.cleared).length : null,
  };
}

// 指标卡片下面的一句说明：统一写成「共 N 条证据，有 X 条……」「N 道……题，有 X 道……」，分母、分子、条件都写清楚。
// 评测记录展开的卡片和详情页总览的卡片共用。没有逐题统计（旧记录）时返回 null，调用方退回通用说明。
function metricSentence(key: string, stats: HistoryEvidenceStats | null, config: EvalRunBrief["config"]) {
  if (key.startsWith("mrr")) return "1 = 每题第 1 段就是证据，0.5 ≈ 平均排第 2";
  if (!stats) return null;
  const evidence = `共 ${stats.evidenceTotal} 条证据`;
  switch (key) {
    case "recall_given": return stats.givenHits === null || stats.givenHits === undefined ? null : `${evidence}，最后交给大模型的资料里有 ${stats.givenHits} 条`;
    case "agent_recall": return stats.agentHits === null || stats.agentHits === undefined ? null : `${evidence}，Agent 找到的资料里有 ${stats.agentHits} 条`;
    case "ext_hit_rate": {
      if (stats.extHits === null || stats.extHits === undefined || stats.givenHits === null || stats.givenHits === undefined) return null;
      const without = stats.evidenceTotal ? formatPercent((stats.givenHits - stats.extHits) / stats.evidenceTotal) : "—";
      return `拿到的 ${stats.givenHits} 条证据里，有 ${stats.extHits} 条在扩展的分片里；不扩展的话命中率 ${without}`;
    }
    case "wrong_clear_rate": return stats.clearedQuestions === null || stats.clearedQuestions === undefined ? null : `${stats.answerableQuestions} 道有答案的题，有 ${stats.clearedQuestions} 道被判资料不足、清空了`;
    case "recall_pool": return `${evidence}，有 ${stats.poolHits} 条进了候选池（每题前 ${config.pool_size ?? "—"} 段）`;
    case "recall_top": return `${evidence}，有 ${stats.topHits} 条排进了重排后的前 ${config.return_limit ?? 6} 段`;
    case "recall_final": return `${evidence}，有 ${stats.finalHits} 条过了阈值（过滤后一共剩 ${stats.finalRemaining} 段）`;
    case "false_reject_rate": return `${stats.answerableQuestions} 道有答案的题，有 ${stats.falseRejectQuestions} 道一段资料都没拿到`;
    case "false_accept_rate": return `${stats.unanswerableQuestions} 道没答案的题，有 ${stats.falseAcceptQuestions} 道还拿到了资料`;
    default: return null;
  }
}

// 列表接口返回蛇形命名，详情页沿用原有驼峰命名；这里集中转换，历史页不需要再拉取详情。
function historyEvidenceStats(metrics: EvalHistoryMetrics | null | undefined): HistoryEvidenceStats | null {
  if (!metrics) return null;
  return {
    answerableQuestions: metrics.answerable_questions,
    unanswerableQuestions: metrics.unanswerable_questions,
    evidenceTotal: metrics.evidence_total,
    poolChunks: metrics.pool_chunks,
    poolHits: metrics.pool_hits,
    topTotal: metrics.top_total,
    topChunks: metrics.top_chunks,
    topHits: metrics.top_hits,
    finalRemaining: metrics.final_remaining,
    finalAnswerableChunks: metrics.final_answerable_chunks,
    finalHits: metrics.final_hits,
    falseRejectQuestions: metrics.false_reject_questions,
    falseAcceptQuestions: metrics.false_accept_questions,
    givenHits: metrics.given_hits,
    agentHits: metrics.agent_hits,
    clearedQuestions: metrics.cleared_questions,
    extHits: metrics.ext_hits,
  };
}

// 每个指标的显示方式：比例用百分比，MRR 用小数，耗时用时分秒。
function formatMetric(key: string, value: number | null | undefined) {
  if (key.startsWith("mrr")) return formatScore(value);
  if (key === "rescued_count") return value === null || value === undefined ? "—" : `${value} 题`;
  if (key === "avg_judge_calls") return value === null || value === undefined ? "—" : `${value.toFixed(2)} 次`;
  if (key.includes("_ms")) return formatMs(value);
  return formatPercent(value);
}

// 指标名里带上本次评测实际的 K 值（候选池大小、返回数量），读者不用再去翻配置。
function metricLabel(key: string, run: EvalRunBrief) {
  const pool = run.config.pool_size ?? 20;
  const top = run.config.return_limit ?? 6;
  const labels: Record<string, string> = {
    recall_pool: `召回 Recall@${pool}`, recall_top: `重排 Recall@${top}`, recall_final: "过滤后 Recall", recall_given: "固定流程资料命中率",
    recall_given_first: "第一次检索交给模型的资料命中率", ext_hit_rate: "扩展命中率", rescued_count: "补充检索救回", wrong_clear_rate: "误清空率",
    right_clear_rate: "正确清空率", retry_rate: "补充检索比例", avg_judge_calls: "平均判断次数", flow_latency_avg_ms: "完整检索平均耗时",
    mrr_pool: `召回 MRR@${pool}`, mrr_top: `重排 MRR@${top}`, mrr_final: "过滤后 MRR",
    false_reject_rate: "误杀率", false_accept_rate: "漏放率", latency_avg_ms: "平均耗时", latency_p95_ms: "P95 耗时",
    faithfulness: "忠实度", correctness: "正确性", refusal_accuracy: "拒答正确率", citation_validity: "引用有效性",
  };
  return labels[key] ?? key;
}

// 生成指标的卡片说明和表格提示统一使用确认后的文案，避免同一指标在不同位置出现两套解释。
const GENERATION_METRIC_EXPLANATIONS: Record<string, string> = {
  faithfulness: "回答的内容都有资料依据。",
  correctness: "和标准答案要点一致。",
  refusal_accuracy: "系统判断所有题目的回答/拒答决定都正确。",
  citation_validity: "引用的资料能支撑对应内容。",
};

// 完整检索流程（改写 → 检索 → 充分性判断 → 补充检索）的指标说明，和线上用户实际拿到的资料一致。
const FLOW_METRIC_EXPLANATIONS: Record<string, string> = {
  recall_given_first: "判断之前，第一次检索的资料里有证据的比例。",
  recall_given: "最后交给大模型写答案的资料里，包含题目的证据的比例",
  rescued_count: "补充检索后拿到更多证据的题。",
  wrong_clear_rate: "有答案却被判资料不足、清空的比例，越低越好。",
  right_clear_rate: "没答案、被清空的比例，越高越好。",
  retry_rate: "触发补充检索的比例。",
  avg_judge_calls: "每题平均判断几次。",
  flow_latency_avg_ms: "改写 + 检索 + 判断 + 补充检索。",
  ext_hit_rate: "拿到的证据里，只在父块扩展拼进来的分片里的比例",
};

const METRIC_HINTS: Record<string, string> = {
  recall_pool: "证据进了候选池的比例",
  recall_top: "重排后前几名里证据的比例",
  recall_final: "阈值过滤后证据的比例",
  mrr_pool: "越接近 1，证据排得越靠前",
  mrr_top: "越接近 1，证据排得越靠前",
  mrr_final: "越接近 1，证据排得越靠前",
  false_reject_rate: "有答案的题一段资料都没拿到，越低越好",
  false_accept_rate: "没答案的题仍拿到资料，越低越好",
  latency_avg_ms: "召回 + 重排",
  ...GENERATION_METRIC_EXPLANATIONS,
};

// 根据当前评测的逐题结果生成卡片说明，展示真实 chunk 数量而不是固定示例。
function metricCardDetails(metricKey: string, run: EvalRun, value: number | null | undefined) {
  const sentence = metricSentence(metricKey, summarizeHistoryEvidence(run), run.config);
  if (sentence) return [sentence];
  const explanation = GENERATION_METRIC_EXPLANATIONS[metricKey] ?? FLOW_METRIC_EXPLANATIONS[metricKey] ?? METRIC_HINTS[metricKey];
  if (explanation && !["faithfulness", "correctness", "refusal_accuracy", "citation_validity"].includes(metricKey)) return [explanation];

  const questions = run.questions ?? [];
  const judgedQuestions: EvalQuestion[] = [];
  for (const question of questions) {
    if (question.judgement) judgedQuestions.push(question);
  }
  if (judgedQuestions.length > 0) {
    if (metricKey === "refusal_accuracy") {
      let correctDecisions = 0;
      for (const question of judgedQuestions) {
        const shouldRefuse = !question.answerable;
        if (question.judgement?.refused === shouldRefuse) correctDecisions += 1;
      }
      return [`${correctDecisions} / ${judgedQuestions.length} 道判断正确`];
    }
    if (["faithfulness", "correctness", "citation_validity"].includes(metricKey)) {
      return [`${judgedQuestions.length} 道题的平均分`];
    }
  }
  if (["faithfulness", "correctness", "refusal_accuracy", "citation_validity"].includes(metricKey)) {
    return ["本次评测暂无逐题大模型评审数据。"];
  }
  return ["本次评测暂无逐题数据。"];
}

const TAB_PATHS: Record<TopTab, string> = { history: "/eval/runs", dataset: "/eval/dataset", special: "/eval/special", regression: "/eval/regression" };

function Evaluation({ onToast, Diagnostics, section, setId, suiteId, onNavigate }: Props) {
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [runs, setRuns] = useState<EvalRunBrief[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [dataset, setDataset] = useState<EvalDataset | null>(null);
  const [runsLoading, setRunsLoading] = useState(true);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [error, setError] = useState("");
  // 发起评测：调参（开发集 / 留出集）或专项（勾选几个专项一起跑）。
  const [launchMode, setLaunchMode] = useState<"tuning" | "special">("tuning");
  const [specialSuites, setSpecialSuites] = useState<EvalSuiteBrief[] | null>(null);
  const [pickedSuites, setPickedSuites] = useState<string[]>([]);
  const [compareMemory, setCompareMemory] = useState(false);
  const [launchKind, setLaunchKind] = useState<LaunchKind>("retrieval");
  const [launchSplit, setLaunchSplit] = useState("dev");
  const [launchSuites, setLaunchSuites] = useState<string[]>([]);
  // 检索评测跑哪些模式：固定流程、Agent，至少勾一个；只勾 Agent 时实验组（消融、参数对比）不跑。
  const [launchModes, setLaunchModes] = useState<EvalMode[]>(["fixed"]);
  // 专项也能选模式：只对检索方式的专项生效，回答和多轮对话方式照常只跑固定流程。
  const [specialModes, setSpecialModes] = useState<EvalMode[]>(["fixed"]);
  const [launching, setLaunching] = useState(false);

  // 刷新评测列表时不再自动打开某条记录，让页面首次进入先展示历史表格。
  async function refreshRuns() {
    const data = await listEvalRuns();
    setRuns(data.runs);
    setRunning(data.running);
    setSuites(data.suites);
    setSelectedId((current) => {
      if (current && data.runs.some((item) => item.id === current)) return current;
      return null;
    });
    return data;
  }

  useEffect(() => {
    refreshRuns().catch((reason: Error) => setError(reason.message)).finally(() => setRunsLoading(false));
    getEvalDataset().then(setDataset).catch((reason: Error) => setError(reason.message)).finally(() => setDatasetLoading(false));
  }, []);

  // 顶部页签现在由 URL 决定；离开历史记录时清掉详情状态，返回时从独立列表路由开始，避免显示上一个路由的旧记录。
  useEffect(() => {
    setSelectedId(null);
    setRun(null);
    setComparison(null);
    setDetailTab("overview");
  }, [section]);

  // 有评测在运行时每两秒刷新进度；运行结束后重新读取当前选中的结果。
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      refreshRuns().then((data) => {
        if (!data.running && selectedId) {
          getEvalRun(selectedId).then(setRun).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, selectedId]);

  // 选中的评测变化时读取完整结果，并自动和上一次同类评测对比。
  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    getEvalRun(selectedId).then((data) => {
      if (cancelled) return;
      setRun(data);
      if (data.previous_id && data.status === "completed") {
        compareEvalRuns(data.previous_id, data.id).then((result) => { if (!cancelled) setComparison(result); }).catch(() => setComparison(null));
      } else {
        setComparison(null);
      }
    }).catch((reason: Error) => setError(reason.message));
    return () => { cancelled = true; };
  }, [selectedId, runs.find((item) => item.id === selectedId)?.status]);

  // 切到「专项」时读取专项列表（专项页签里可能刚新建过，每次切换都重新读）。
  useEffect(() => {
    if (section !== "history" || launchMode !== "special") return;
    listEvalSuites().then((data) => setSpecialSuites(data.items)).catch((reason: Error) => setError(reason.message));
  }, [section, launchMode]);

  async function launch() {
    setLaunching(true);
    setError("");
    try {
      if (launchMode === "special") {
        const started = await startSpecialRun(pickedSuites, compareMemory, specialModes);
        setSelectedId(started.id);
        await refreshRuns();
        onToast("success", "专项评测已启动。");
        return;
      }
      const modes: EvalMode[] = launchKind === "retrieval" ? launchModes : ["fixed"];
      const suites = launchKind !== "retrieval" || !modes.includes("fixed") ? [] : launchSuites;
      const started = await startEvalRun(launchKind, launchSplit, suites, modes);
      setSelectedId(started.id);
      setDetailTab("overview");
      await refreshRuns();
      // 评测进度继续留在页面内；Toast 只确认启动结果，避免把持续状态变成短暂提示。
      onToast("success", `${KIND_LABELS[launchKind]}评测已启动。`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  // 删除后刷新历史列表，并清理可能仍指向该记录的详情状态，避免页面继续显示已删除内容。
  async function removeRun(runId: string) {
    try {
      await deleteEvalRun(runId);
      if (selectedId === runId) {
        setSelectedId(null);
        setRun(null);
        setComparison(null);
      }
      await refreshRuns();
      onToast("success", "评测记录已删除。");
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  // 生成评测只跑基线；切换到生成时清空已选的检索实验，避免把无效组合提交给后端。
  function changeLaunchKind(kind: LaunchKind) {
    setLaunchKind(kind);
    if (kind !== "retrieval") setLaunchSuites([]);
  }

  function toggleMode(mode: EvalMode) {
    setLaunchModes((items) => {
      const next = items.includes(mode) ? items.filter((item) => item !== mode) : [...items, mode];
      if (!next.includes("fixed")) setLaunchSuites([]);
      return next;
    });
  }

  function toggleSuite(key: string) {
    setLaunchSuites((items) => (items.includes(key) ? items.filter((item) => item !== key) : [...items, key]));
  }

  const runningRun = runs.find((item) => item.id === running) ?? null;
  const questionCount = run?.questions?.length ?? 0;
  // 调参评测集题数随题目增删变化，运行时计算后展示，避免操作栏的题数和实际可选范围不一致。
  const splitCounts = useMemo(() => {
    const counts = { dev: 0, holdout: 0 };
    for (const item of dataset?.items ?? []) {
      // 操作栏只显示真正可运行的题数，待审核草稿不会误导用户以为已经纳入评测。
      if (item.reviewed !== true) continue;
      if (item.split === "dev") counts.dev += 1;
      if (item.split === "holdout") counts.holdout += 1;
    }
    return counts;
  }, [dataset]);
  const detailCounts: Record<DetailTab, string | number> = {
    overview: "", questions: questionCount || "", sweep: run?.sweep?.length ? "" : "", variants: run?.variants?.length || "",
  };
  const agentLaunch = launchMode === "tuning" && launchKind === "retrieval" && launchModes.includes("agent");

  return <section className="ev-root">
    <div className="ev-heading">
      <div><h2>评测</h2><p>改动后跑一遍，看指标变好还是变差。</p></div>
    </div>
    <div className="document-detail-tabs ev-tabs ev-top-tabs" role="tablist">
      {(Object.keys(TOP_TAB_LABELS) as TopTab[]).map((key) => <button key={key} role="tab" aria-selected={section === key} className={section === key ? "active" : ""} onClick={() => onNavigate(TAB_PATHS[key])}>{TOP_TAB_LABELS[key]}{(key === "history" || key === "dataset") && <span>{key === "history" ? runs.length : dataset?.reviewed_count ?? dataset?.items.filter((item) => item.reviewed === true).length ?? ""}</span>}</button>)}
    </div>
    {section === "history" && <>
      {/* 操作区只属于历史记录，评测集 Tab 保持为题目管理入口。 */}
      <div className="ev-launch">
        <div className="ev-launch-title">操作：发起{launchMode === "special" ? "专项" : KIND_LABELS[launchKind]}评测<small>{launchKind === "generation" && launchMode !== "special" ? "会调用大模型，有少量费用" : agentLaunch ? "Agent 每题调用大模型几轮，较慢" : "会调用大模型"}</small></div>
        <div className="ev-launch-options">
          <div className="ev-launch-option is-stacked">
            <div className="sp-mode" role="radiogroup" aria-label="评测目的">
              <button type="button" role="radio" aria-checked={launchMode === "tuning"} className={launchMode === "tuning" ? "is-selected" : ""} onClick={() => setLaunchMode("tuning")}>调参</button>
              <button type="button" role="radio" aria-checked={launchMode === "special"} className={launchMode === "special" ? "is-selected" : ""} onClick={() => setLaunchMode("special")}>专项</button>
            </div>
            <Hint text={launchMode === "special" ? "检查某个方向的问题，不计入调参分数；每个专项单独出结果。" : "用开发集或留出集比较参数好坏。"} />
          </div>
          {launchMode === "special" ? <div className="ev-launch-option sp-pick-option">
            {specialSuites === null ? <span className="ev-muted-note">正在读取专项…</span>
              : specialSuites.length === 0 ? <span className="ev-muted-note">还没有专项，先到「专项评测集」新建。</span>
              : <ul className="sp-pick-list">{specialSuites.map((suite) => <li key={suite.id}>
                <label><input type="checkbox" checked={pickedSuites.includes(suite.id)} disabled={suite.item_count === 0} onChange={() => setPickedSuites((items) => items.includes(suite.id) ? items.filter((item) => item !== suite.id) : [...items, suite.id])} />
                  <span className="sp-pick-text"><span className="sp-pick-name">{suite.name}<HueTag size="sm" label={suite.method_label} />{suite.method !== "dialogue" && <Tag size="sm" outline plain>{suite.search_mode_label}</Tag>}<em>{suite.item_count} 题</em></span>{suite.description && <small>{suite.description}</small>}</span></label>
              </li>)}</ul>}
            {specialSuites?.some((suite) => suite.method === "retrieval" && pickedSuites.includes(suite.id)) && <div className="sp-mode-line">
              <span className="ev-option-title">运行模式</span>
              <label className={`ev-radio-option ${specialModes.includes("fixed") ? "is-selected" : ""}`}><input type="checkbox" checked={specialModes.includes("fixed")} onChange={() => setSpecialModes((items) => items.includes("fixed") ? items.filter((item) => item !== "fixed") : ["fixed", ...items])} />固定流程</label>
              <label className={`ev-radio-option ${specialModes.includes("agent") ? "is-selected" : ""}`}><input type="checkbox" checked={specialModes.includes("agent")} onChange={() => setSpecialModes((items) => items.includes("agent") ? items.filter((item) => item !== "agent") : [...items, "agent"])} />Agent</label>
              <span className="ev-option-description is-below ev-hint"><span className="ev-info-icon" aria-hidden="true">i</span>只对检索方式的专项生效。{specialModes.includes("agent") && specialSuites.some((suite) => suite.method === "retrieval" && suite.search_mode !== "hybrid" && pickedSuites.includes(suite.id)) ? "选中的专项有不是混合检索的，和 Agent 比不公平。" : ""}</span>
            </div>}
            {specialSuites?.some((suite) => suite.method === "dialogue" && pickedSuites.includes(suite.id)) && <div className="sp-switch-line">
              <button type="button" role="switch" aria-checked={compareMemory} className={`sp-switch ${compareMemory ? "is-on" : ""}`} onClick={() => setCompareMemory(!compareMemory)}><span /></button>
              <span>对比记忆参数：压缩阈值、保留条数各调大调小再跑，共 5 组，大模型调用是 5 倍。</span>
            </div>}
          </div> : <>
          <div className="ev-launch-option is-stacked">
            <fieldset className="ev-radio-field">
              <legend><span className="ev-option-title">评测类型</span></legend>
              <div className="ev-radio-options" role="radiogroup" aria-label="评测类型">
                <label className={`ev-radio-option ${launchKind === "retrieval" ? "is-selected" : ""}`}><input type="radio" name="eval-kind" value="retrieval" checked={launchKind === "retrieval"} onChange={() => changeLaunchKind("retrieval")} />检索评测</label>
                <label className={`ev-radio-option ${launchKind === "generation" ? "is-selected" : ""}`}><input type="radio" name="eval-kind" value="generation" checked={launchKind === "generation"} onChange={() => changeLaunchKind("generation")} />生成评测</label>
              </div>
              <Hint text={launchKind === "generation" ? "检索后生成回答，由评审模型打分。" : "改写 → 检索 → 充分性判断 → 补充检索，和线上一致。"} />
            </fieldset>
          </div>
          {launchKind === "retrieval" && <div className="ev-launch-option is-stacked">
            <fieldset className="ev-radio-field">
              <legend><span className="ev-option-title">运行模式</span></legend>
              <div className="ev-radio-options" role="group" aria-label="运行模式">
                <label className={`ev-radio-option ${launchModes.includes("fixed") ? "is-selected" : ""}`}><input type="checkbox" checked={launchModes.includes("fixed")} onChange={() => toggleMode("fixed")} />固定流程</label>
                <label className={`ev-radio-option ${launchModes.includes("agent") ? "is-selected" : ""}`}><input type="checkbox" checked={launchModes.includes("agent")} onChange={() => toggleMode("agent")} />Agent</label>
              </div>
              <Hint text={launchModes.length === 0 ? "至少勾一个。" : launchModes.length === 2 ? "两边逐题对比，点开看各自的检索日志。" : launchModes.includes("agent") ? "只看 Agent 最后拿到的资料；实验组不跑。" : ""} />
            </fieldset>
          </div>}
          <div className="ev-launch-option is-stacked">
            <fieldset className="ev-radio-field">
              <legend><span className="ev-option-title">题目范围</span></legend>
              <div className="ev-radio-options" role="radiogroup" aria-label="题目范围">
                <label className={`ev-radio-option ${launchSplit === "dev" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="dev" checked={launchSplit === "dev"} onChange={() => setLaunchSplit("dev")} />开发集（日常调参）</label>
                <label className={`ev-radio-option ${launchSplit === "holdout" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="holdout" checked={launchSplit === "holdout"} onChange={() => setLaunchSplit("holdout")} />留出集（最终验证）</label>
                <label className={`ev-radio-option ${launchSplit === "all" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="all" checked={launchSplit === "all"} onChange={() => setLaunchSplit("all")} />全部题目</label>
              </div>
              <Hint text={launchSplit === "dev" ? `${splitCounts.dev || "—"} 题，调参时用。` : launchSplit === "holdout" ? `${splitCounts.holdout || "—"} 题，调参完成后验证。` : `${splitCounts.dev + splitCounts.holdout || "—"} 题，看总体，不用来定参数。`} />
            </fieldset>
          </div>
          {/* 生成评测只跑基线，先在界面层禁用检索实验组选项，避免用户提交无效组合。 */}
          {suites.map((suite) => {
            const suiteOff = launchKind !== "retrieval" || !launchModes.includes("fixed");
            const suiteDescription = launchKind !== "retrieval"
              ? "只有检索评测能跑。"
              : !launchModes.includes("fixed") ? "要勾选固定流程才能跑。"
              : `${SUITE_DESCRIPTIONS[suite.key] ?? "和基线对比"}：${suite.variants.join("、")}。`;
            const suiteClass = suiteOff ? "ev-check is-disabled" : "ev-check";
            return <div className="ev-launch-option is-stacked" key={suite.key}>
              <label className={suiteClass} title={launchKind !== "retrieval" ? "只有检索评测能运行这组实验" : suite.variants.join("、")}><input type="checkbox" disabled={suiteOff} checked={launchSuites.includes(suite.key)} onChange={() => toggleSuite(suite.key)} />{suite.label}<small>{suite.variants.length} 组</small></label>
              <Hint text={suiteDescription} />
            </div>;
          })}
          </>}
        </div>
        <div className="ev-launch-actions">
          <button className="primary-button" disabled={launching || Boolean(running) || (launchMode === "special" && (pickedSuites.length === 0 || specialModes.length === 0)) || (launchMode === "tuning" && launchKind === "retrieval" && launchModes.length === 0)} onClick={() => void launch()}>{running ? "评测进行中…" : launching ? "正在启动…" : "开始评测"}</button>
        </div>
        {runningRun && <div className="ev-progress" aria-live="polite"><div className="ev-progress-track"><div className="ev-progress-fill" style={{ width: `${progressPercent(runningRun)}%` }} /></div><span>{runningRun.progress?.done ?? 0} / {runningRun.progress?.total || "…"} {runningRun.kind === "special" ? "题" : "次检索"}</span></div>}
        {runningRun && runningRun.kind !== "special" && progressBreakdown(runningRun, suites) && <p className="ev-progress-note">{progressBreakdown(runningRun, suites)}</p>}
      </div>
    </>}
    {error && <div className="error-banner">{error}</div>}
    {section === "regression" ? <Regression setId={setId ?? null} onNavigate={onNavigate} onToast={onToast} /> : section === "special" ? <Special suiteId={suiteId ?? null} onNavigate={onNavigate} onToast={onToast} /> : section === "dataset" ? datasetLoading ? <DatasetSkeleton /> : <DatasetBrowser dataset={dataset} onToast={onToast} onSaved={async () => { setDataset(await getEvalDataset()); }} /> : runsLoading ? <RunHistorySkeleton /> : selectedId ? <RunDetailView
      onBack={() => setSelectedId(null)}
      run={run}
      running={running}
      detailTab={detailTab}
      setDetailTab={setDetailTab}
      detailCounts={detailCounts}
      comparison={comparison}
      Diagnostics={Diagnostics}
    /> : <RunHistory runs={runs} onOpen={(id) => { setSelectedId(id); setDetailTab("overview"); }} onDelete={removeRun} />}
  </section>;
}

// 历史评测首次读取时保持表格骨架，避免接口还没返回就显示“还没有评测记录”。
// 选项下面的一句说明；没有要说的就不显示。
function Hint({ text }: { text: string }) {
  if (!text) return null;
  return <span className="ev-option-description is-below ev-hint"><span className="ev-info-icon" aria-hidden="true">i</span>{text}</span>;
}

function RunHistorySkeleton() {
  return <LoadingSkeleton className="ev-loading-panel" label="正在加载评测记录">
    <div className="ev-skeleton-toolbar"><SkeletonBlock className="skeleton-title" /><SkeletonBlock className="skeleton-button" /></div>
    <div className="ev-skeleton-table"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <div className="ev-skeleton-table"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <div className="ev-skeleton-table"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
  </LoadingSkeleton>;
}

// 评测详情需要再次读取完整结果；先保留配置栏、页签和指标卡的轮廓，减少详情切换时的空白跳变。
function RunDetailSkeleton() {
  return <LoadingSkeleton className="ev-loading-panel ev-detail-skeleton" label="正在加载评测详情">
    <SkeletonBlock className="skeleton-line-short" />
    <div className="ev-skeleton-config"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <div className="ev-skeleton-tabs"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <div className="ev-skeleton-cards"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <SkeletonBlock className="ev-skeleton-chart" />
  </LoadingSkeleton>;
}

// 评测集首屏读取期间使用题目卡片占位，加载完成后才显示真正的空集状态。
function DatasetSkeleton() {
  return <LoadingSkeleton className="ev-loading-panel" label="正在加载评测集">
    <div className="ev-skeleton-toolbar"><SkeletonBlock className="skeleton-line-long" /><SkeletonBlock className="skeleton-button" /></div>
    <div className="ev-skeleton-filter"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <SkeletonBlock className="ev-skeleton-question" />
    <SkeletonBlock className="ev-skeleton-question" />
    <SkeletonBlock className="ev-skeleton-question" />
  </LoadingSkeleton>;
}

// 历次记录先展示表格，只有点击查看后才进入单次评测详情及其二级指标页签。
function RunDetailView({ onBack, run, running, detailTab, setDetailTab, detailCounts, comparison, Diagnostics }: {
  onBack: () => void;
  run: EvalRun | null;
  running: string | null;
  detailTab: DetailTab;
  setDetailTab: (tab: DetailTab) => void;
  detailCounts: Record<DetailTab, string | number>;
  comparison: EvalComparison | null;
  Diagnostics: ComponentType<{ data: RetrievalDiagnosticsData }>;
}) {
  // 只跑固定流程：和原来一样一层页签。勾了 Agent：第一层是模式（两个都跑时有「对比」并默认打开），
  // 固定流程里再分原来的总览 / 逐题 / 阈值 / 消融；只跑 Agent 时只有 Agent 一页。
  const modes = run ? runModes(run) : ["fixed"];
  const modeTabs: ModeTab[] = !modes.includes("agent") ? [] : modes.includes("fixed") ? ["compare", "fixed", "agent"] : ["agent"];
  const [modeTab, setModeTab] = useState<ModeTab>("compare");
  const activeMode: ModeTab | null = modeTabs.length ? (modeTabs.includes(modeTab) ? modeTab : modeTabs[0]) : null;
  const showFixed = activeMode === null || activeMode === "fixed";
  const tabs = Object.keys(DETAIL_TAB_LABELS) as DetailTab[];
  const activeTab = detailTab;
  return <div className="ev-detail-view">
    <div className="ev-detail-toolbar"><button className="ev-back-button" onClick={onBack}>← 返回历次记录</button></div>
    {/* 详情页只展示当前评测配置；切换记录回到历史表格，避免下拉框和详情页职责重叠。 */}
    {run?.kind === "special" ? <div className="ev-body">{run.status !== "completed" ? <RunStatus run={run} live={run.id === running} /> : <SpecialRunResults run={run} />}</div> : run?.kind === "memory" ? <div className="ev-body">{run.status !== "completed" ? <RunStatus run={run} live={run.id === running} /> : <MemoryResults run={run} />}</div> : <>
    {run && <RunConfig run={run} />}
    {activeMode && <div className="document-detail-tabs ev-tabs ev-detail-tabs" role="tablist">
      {modeTabs.map((key) => <button key={key} role="tab" aria-selected={activeMode === key} className={activeMode === key ? "active" : ""} onClick={() => setModeTab(key)}>{MODE_TAB_LABELS[key]}</button>)}
    </div>}
    {showFixed && <div className={activeMode ? "ev-chips ev-subtabs" : "document-detail-tabs ev-tabs ev-detail-tabs"} role="tablist">
      {tabs.map((key) => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? "active" : ""} onClick={() => setDetailTab(key)}>{DETAIL_TAB_LABELS[key]}{detailCounts[key] !== "" && <span>{detailCounts[key]}</span>}</button>)}
    </div>}
    <div className="ev-body">
      {!run ? <RunDetailSkeleton /> :
        run.status !== "completed" ? <RunStatus run={run} live={run.id === running} /> :
          activeMode === "compare" ? <ComparePanel run={run} /> :
          activeMode === "agent" ? <AgentPanel run={run} /> :
          activeTab === "overview" ? <Overview run={run} comparison={comparison} /> :
            activeTab === "questions" ? <QuestionList run={run} Diagnostics={Diagnostics} /> :
              activeTab === "sweep" ? <SweepPanel run={run} /> :
                <VariantPanel run={run} />}
    </div>
    </>}
  </div>;
}

// 专项评测结果：每个专项一张卡片，卡片里是这个专项的通过数、和上次相比的变化、逐题结果。
function SpecialRunResults({ run }: { run: EvalRun }) {
  const sections = run.special ?? [];
  return <div className="sp-run-sections">
    <p className="ev-muted-note">专项题是难题，分数低正常，不计入调参分数。</p>
    {sections.map((section) => <section key={section.suite_id} className="sp-run-section">
      <h3>{section.name}<Tag size="sm" hue className="is-after">{section.method_label}</Tag></h3>
      {section.description && <p>{section.description}</p>}
      <SpecialSection section={section} />
    </section>)}
  </div>;
}

// 多轮对话评测结果（旧记录）：每组对话记忆参数一行，看最后一问答对了多少、有没有触发压缩、输入多长；展开看每段对话。
function MemoryResults({ run }: { run: EvalRun }) {
  const variants = run.memory ?? [];
  return <div className="ev-memory">
    <p className="ev-muted-note">共 {run.config.dataset_size ?? "—"} 段对话，最后一问要用到开头的内容。正确性：1 一致，0.5 部分，0 错误。</p>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th>参数</th><th className="num">最后一问正确性</th><th className="num">忠实度</th><th className="num">触发了压缩</th><th className="num">最后一问平均输入</th></tr></thead>
      <tbody>{variants.map((variant, index) => <tr key={variant.name} className={index === 0 ? "is-current" : ""}>
        <td>{variant.label}</td>
        <td className="num">{formatScore(variant.summary.correctness, 2)}</td>
        <td className="num">{formatScore(variant.summary.faithfulness, 2)}</td>
        <td className="num">{formatPercent(variant.summary.summarized_rate)}</td>
        <td className="num">{variant.summary.input_tokens_avg !== null ? `${Math.round(variant.summary.input_tokens_avg)} Token` : "—"}</td>
      </tr>)}</tbody>
    </table></div>
    {variants.map((variant) => <details key={variant.name} className="ev-table-view">
      <summary>{variant.label}：逐段对话</summary>
      <ul className="ev-memory-dialogues">{variant.dialogues.map((dialogue) => <li key={dialogue.id}>
        <div><strong>{dialogue.question}</strong><span className="ev-muted-note">（第 {dialogue.turns} 轮 · {dialogue.summarized ? "触发了压缩" : "没有压缩"} · 正确性 {formatScore(dialogue.judgement.correctness ?? null, 1)}）</span></div>
        <div className="ev-memory-answer">{dialogue.answer}</div>
        {dialogue.judgement.correctness_reason && <div className="ev-muted-note">评审：{dialogue.judgement.correctness_reason}</div>}
      </li>)}</ul>
    </details>)}
  </div>;
}

// 一次评测的关键配置：题目范围、召回参数、阈值和模型，结果是在什么条件下得到的一目了然。
function RunConfig({ run }: { run: EvalRunBrief }) {
  const config = run.config;
  const items: [string, string][] = [
    ["题目", `${SPLIT_LABELS[config.split ?? ""] ?? config.split}${config.dataset_size ? ` · ${config.dataset_size} 题` : ""}`],
    ["模式", modesLabel(run)],
    ...(config.agent ? [["Agent", `预算 ${config.agent.tool_budget} 次 · 超时 ${config.agent.timeout} 秒 · 提示词 ${config.agent.prompt_version}${config.agent.prompt_identity ? `（${config.agent.prompt_identity.slice(0, 6)}）` : ""}`] as [string, string]] : []),
    ["候选池", String(config.pool_size ?? "—")], ["返回上限", String(config.return_limit ?? "—")], ["RRF k", String(config.rrf_k ?? "—")],
    ["相关性阈值", config.reranked === false ? "未启用（没有重排）" : formatScore(config.min_score ?? null, 2)],
    ["向量模型", `${config.embedding_mode ?? "—"} · ${config.embedding_model ?? "—"}`],
    ["重排模型", config.reranked ? config.rerank_model ?? "—" : config.reranked === false ? "未启用" : "—"],
    ["检索词", flowRewriteLabel(config)],
    ...(config.flow ? [["充分性判断", config.flow.sufficiency ? "启用（和线上一样，可能补充检索或清空来源）" : "未启用"] as [string, string]] : []),
  ];
  return <div className="diag-config ev-config">{items.map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}</div>;
}

// 检索词从哪来：完整检索是大模型改写（带缓存），旧记录是规则检索词（原问题，不调用模型）。
function flowRewriteLabel(config: EvalRunBrief["config"]) {
  const flow = config.flow;
  if (!flow) return (config.query_source ?? []).map((item) => (item === "rewrite_cache" ? "改写缓存" : "规则改写（旧口径）")).join("、") || "—";
  const parts = [`${flow.model} 改写 · 提示词 ${flow.intent_prompt}`];
  if (flow.rewrite_cached || flow.rewrite_fresh) parts.push(`缓存 ${flow.rewrite_cached} 题 · 新改写 ${flow.rewrite_fresh} 题`);
  return parts.join(" · ");
}

function EmptyRuns({ hasRuns }: { hasRuns: boolean }) {
  return <div className="ev-empty"><h3>{hasRuns ? "请选择一次评测" : "还没有评测记录"}</h3><p>在上方选好后点「开始评测」。</p></div>;
}

function RunStatus({ run, live }: { run: EvalRun; live: boolean }) {
  if (run.status === "running" && live) return <div className="ev-empty"><h3>评测进行中</h3><p>已完成 {run.progress?.done ?? 0} / {run.progress?.total || "…"} 次检索，完成后自动显示结果。</p></div>;
  return <div className="ev-empty"><h3>{runStatus(run.status).label}</h3><p>{run.error ?? "这次评测没有正常结束（进程可能中途退出），请重新运行。"}</p></div>;
}

// 与上一次对比的变化标记：箭头 + 文字，不只靠颜色区分变好变差。
function ChangeTag({ row, metricKey }: { row?: EvalComparisonRow; metricKey: string }) {
  if (!row || row.delta === null) return <span className="ev-change is-none">无对比</span>;
  const labels = { better: "变好", worse: "变差", same: "持平", unknown: "—" };
  const arrow = row.delta > 0 ? "↑" : row.delta < 0 ? "↓" : "→";
  const amount = metricKey.includes("_ms") ? formatMs(Math.abs(row.delta)) : metricKey.startsWith("mrr") ? Math.abs(row.delta).toFixed(3) : `${Math.abs(row.delta * 100).toFixed(1)} 个百分点`;
  return <span className={`ev-change is-${row.change}`}>{arrow} {labels[row.change]}{row.change !== "same" && <small>{amount}</small>}</span>;
}

// 单次评测总览：指标卡片、chunk 对比、按题型分组的指标。
function Overview({ run, comparison }: { run: EvalRun; comparison: EvalComparison | null }) {
  const summary = run.summary ?? {};
  const changes: Record<string, EvalComparisonRow> = {};
  for (const row of comparison?.metrics ?? []) changes[row.key] = row;
  // 耗时在下方单独的面板里展示（平均、P95、重排最慢），卡片只放质量指标。
  const retrievalKeys = ["recall_pool", "recall_top", "recall_final", "mrr_top", "false_reject_rate", "false_accept_rate"];
  const generationKeys = ["faithfulness", "correctness", "refusal_accuracy", "citation_validity"];
  const hasGeneration = run.kind === "generation";
  // 完整检索流程（新记录才有）：第一次检索之后还有充分性判断和补充检索，最终交给模型的资料可能不同。
  const hasFlow = run.config.flow?.name === "full";
  const flowKeys = ["recall_given_first", "recall_given", "ext_hit_rate", "rescued_count", "wrong_clear_rate", "right_clear_rate", "retry_rate"];
  return <div className="ev-overview">
    {/* 顶部总览只展示本次评测结果，移除重复的历史对比提示；历史对比仍用于耗时变化和历史页。 */}
    {comparison?.settings_diff && comparison.settings_diff.length > 0 && <div className="ev-settings-diff">和上一次评测相比，系统参数改过 {comparison.settings_diff.length} 项：{comparison.settings_diff.map((item) => `${item.key} ${String(item.base)} → ${String(item.target)}`).join("；")}。分数变化可能来自参数，而不是代码。</div>}
    <div className="ev-section-title">{hasFlow ? "第一次检索" : "检索指标"}<small>{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答{hasFlow ? " · 调参看这里：召回、重排、阈值三个阶段" : ""}</small></div>
    <div className="ev-cards">{retrievalKeys.map((key) => <MetricCard key={key} metricKey={key} run={run} value={summary[key]} />)}</div>
    {hasFlow && <><div className="ev-section-title">完整检索流程<small>和线上一致：改写 → 检索 → 充分性判断 → 补充检索{run.config.flow?.sufficiency ? "" : " · 充分性判断未启用，最终就是第一次检索的结果"}</small></div>
      <div className="ev-cards">{flowKeys.map((key) => <MetricCard key={key} metricKey={key} run={run} value={summary[key]} />)}</div></>}
    {hasGeneration && <><div className="ev-section-title">生成指标<small>大模型评审，温度 0；评审理由见逐题明细</small></div>
      <div className="ev-cards">{generationKeys.map((key) => <MetricCard key={key} metricKey={key} run={run} value={summary[key]} />)}</div></>}
    {(hasGeneration || hasFlow) && <SufficiencySummary run={run} />}
    <div className="ev-overview-grid">
      <div className="ev-panel"><div className="ev-section-title">chunk 命中对比<small>预设证据与各阶段实际返回 chunk</small></div><ChunkStageComparison run={run} /></div>
      <div className="ev-panel"><div className="ev-section-title">耗时<small>单题召回 + 重排</small></div>
        <div className="ev-latency"><div><span>平均</span><strong>{formatMs(summary.latency_avg_ms)}</strong><ChangeTag row={changes.latency_avg_ms} metricKey="latency_avg_ms" /></div><div><span>P95</span><strong>{formatMs(summary.latency_p95_ms)}</strong></div><div><span>重排最慢</span><strong>{formatMs(summary.rerank_max_ms)}</strong></div>{hasFlow && <div><span>完整检索平均</span><strong>{formatMs(summary.flow_latency_avg_ms)}</strong><small>含改写、判断和补充检索</small></div>}</div>
      </div>
    </div>
    <div className="ev-section-title">按题目类型<small>整体分数可能掩盖某一类题特别差</small></div>
    <TypeTable run={run} />
  </div>;
}

// 指标卡片聚焦当前评测的真实数值和计算说明，避免没有基线时显示无意义的“无对比”占位文字。
function MetricCard({ metricKey, run, value }: { metricKey: string; run: EvalRun; value: number | null | undefined }) {
  const details = metricCardDetails(metricKey, run, value);
  return <div className="ev-card">
    <div className="ev-card-label-row">
      <span className="ev-card-label">{metricLabel(metricKey, run)}</span>
    </div>
    <strong className="ev-card-value">{formatMetric(metricKey, value)}</strong>
    <div className="ev-card-explanation">
      {details.map((detail) => <span key={detail}>{detail}</span>)}
    </div>
  </div>;
}

// 生成评测总览展示资料充分性判断，补充检索后的最终 chunk 单独计数，避免误读为首次检索结果。
function SufficiencySummary({ run }: { run: EvalRun }) {
  const stats = summarizeSufficiency(run);
  if (!stats) return <div className="ev-sufficiency-panel"><div className="ev-section-title">资料充分性<small>本次评测没有保存充分性结果</small></div><p className="ev-muted-note">重新跑一次才有。</p></div>;
  const average = stats.retryQuestions > 0 ? (stats.retryFinalChunks / stats.retryQuestions).toFixed(1) : "—";
  return <section className="ev-sufficiency-panel" aria-labelledby="ev-sufficiency-title">
    <div className="ev-section-title" id="ev-sufficiency-title">资料充分性<small>{stats.checked} / {stats.observed} 道题完成判断</small></div>
    <div className="ev-sufficiency-grid">
      <div className="ev-sufficiency-stat is-good"><span>资料充分</span><strong>{stats.sufficient}</strong><small>现有资料可以回答</small></div>
      <div className="ev-sufficiency-stat is-partial"><span>资料部分充分</span><strong>{stats.partial}</strong><small>只能回答问题的一部分</small></div>
      <div className="ev-sufficiency-stat is-bad"><span>资料不足</span><strong>{stats.insufficient}</strong><small>最终应拒答</small></div>
      <div className="ev-sufficiency-stat is-retry"><span>触发补充检索</span><strong>{stats.retried}</strong><small>道题追加检索</small></div>
      <div className="ev-sufficiency-stat is-chunks"><span>补检后最终返回 chunk</span><strong>{stats.retryFinalChunks}</strong><small>{stats.retryQuestions > 0 ? `${stats.retryQuestions} 道题合计 · 平均 ${average} 条` : "没有可统计的补检结果"}</small></div>
    </div>
    {stats.observed > stats.checked && <p className="ev-sufficiency-note">有 {stats.observed - stats.checked} 道题没做判断（没开大模型或充分性判断）。</p>}
  </section>;
}

// 总览直接对照预设证据和返回 chunk，避免用题目数的漏斗掩盖“返回了什么、命中了多少”这个核心问题。
function ChunkStageComparison({ run }: { run: EvalRun }) {
  const stats = summarizeChunkStages(run);
  if (!stats) return <p className="ev-muted-note">本次评测没有保存逐题 chunk 明细。</p>;
  const returnLimit = run.config.return_limit ?? 6;
  return <div className="ev-chunk-comparison">
    <div className="ev-chunk-reference"><span>预设证据对应 chunk</span><strong>{stats.expectedChunks}</strong><small>{stats.evidenceTotal} 条证据按 chunk 去重 · {stats.answerableQuestions} 道可回答题</small></div>
    <div className="ev-chunk-table" role="table" aria-label="预设证据与实际返回 chunk 对比">
      <div className="ev-chunk-table-row is-header" role="row"><span>阶段</span><span>返回 chunk</span><span>本次包含chunk / 预设正确chunk</span><span>其他 chunk</span></div>
      {stats.rows.map((row) => <div className="ev-chunk-table-row" role="row" key={row.key}>
        <span>{row.label}</span>{row.enabled ? <><strong>{row.returned}</strong><strong className="is-hit">{row.hits} / {stats.expectedChunks}</strong><strong className="is-other">{Math.max(0, row.returned - row.hits)}</strong></> : <strong className="ev-chunk-disabled">未启用</strong>}
      </div>)}
    </div>
    <p className="ev-chunk-comparison-note">融合召回 = 进重排前的全部候选。</p>
  </div>;
}

type ChunkComparisonStage = { key: string; label: string; returned: number; hits: number; enabled: boolean };

// 从每道题的诊断记录汇总细粒度检索阶段，保持“返回 chunk”和“命中 chunk”使用同一口径。
function summarizeChunkStages(run: EvalRun) {
  const answerable = (run.questions ?? []).filter((question) => question.answerable && question.diagnostics);
  if (answerable.length === 0) return null;
  const poolSize = run.config.pool_size ?? 20;
  const returnLimit = run.config.return_limit ?? 6;
  const rows: ChunkComparisonStage[] = [
    { key: "dense", label: "向量检索", returned: 0, hits: 0, enabled: false },
    { key: "keyword", label: "关键词检索", returned: 0, hits: 0, enabled: false },
    { key: "fused", label: "融合召回", returned: 0, hits: 0, enabled: true },
    { key: "top", label: `重排结果（前 ${returnLimit}）`, returned: 0, hits: 0, enabled: true },
    { key: "final", label: "阈值过滤后", returned: 0, hits: 0, enabled: true },
  ];
  let expectedChunks = 0;
  let evidenceTotal = 0;
  for (const question of answerable) {
    const diagnostics = question.diagnostics;
    if (!diagnostics) continue;
    const expectedIds = new Set(question.evidence.map((evidence) => evidence.chunk_id).filter((chunkId): chunkId is string => Boolean(chunkId)));
    expectedChunks += expectedIds.size;
    evidenceTotal += question.evidence.length;
    const denseIds = new Set(diagnostics.lists.filter((list) => list.method === "dense").flatMap((list) => list.hits.map((hit) => hit.chunk_id)));
    const keywordIds = new Set(diagnostics.lists.filter((list) => list.method === "keyword").flatMap((list) => list.hits.map((hit) => hit.chunk_id)));
    const stageIds: Record<string, Set<string>> = {
      dense: denseIds,
      keyword: keywordIds,
      fused: new Set(diagnostics.candidates.map((candidate) => candidate.chunk_id)),
      top: new Set(stageCandidates(question, "top", poolSize, returnLimit).map((candidate) => candidate.chunk_id)),
      final: new Set(stageCandidates(question, "final", poolSize, returnLimit).map((candidate) => candidate.chunk_id)),
    };
    for (const row of rows) {
      const ids = stageIds[row.key];
      row.returned += ids.size;
      for (const id of expectedIds) if (ids.has(id)) row.hits += 1;
      if (row.key === "dense" || row.key === "keyword") row.enabled = row.enabled || ids.size > 0;
    }
  }
  return { rows, expectedChunks, evidenceTotal, answerableQuestions: answerable.length };
}

type ChunkStage = "pool" | "top" | "final";

// 按真实排序和最终状态取出一道题在不同阶段看到的 chunk，展开题目时用于核对具体内容。
function stageCandidates(question: EvalQuestion, stage: ChunkStage, poolSize: number, returnLimit: number) {
  const candidates = [...(question.diagnostics?.candidates ?? [])];
  const pool = candidates.filter((candidate) => candidate.rrf_rank <= poolSize).sort((left, right) => left.rrf_rank - right.rrf_rank);
  if (stage === "pool") return pool;
  if (stage === "top") return pool.sort((left, right) => (left.rerank_rank ?? left.rrf_rank) - (right.rerank_rank ?? right.rrf_rank)).slice(0, returnLimit);
  return candidates.filter((candidate) => candidate.status === "returned").sort((left, right) => (left.source_id ?? "").localeCompare(right.source_id ?? ""));
}

// 逐题展示预设证据、各阶段返回的 chunk 以及命中/其他状态，帮助用户直接判断丢失发生在哪一环。
function QuestionChunkComparison({ question, run }: { question: EvalQuestion; run: EvalRun }) {
  if (!question.diagnostics) return <p className="ev-muted-note">这次没保存分块明细。</p>;
  const poolSize = run.config.pool_size ?? question.diagnostics.config.rerank_candidates ?? 20;
  const returnLimit = run.config.return_limit ?? question.diagnostics.config.return_limit ?? 6;
  const stages: { key: ChunkStage; label: string }[] = [
    { key: "pool", label: `候选池 · 前 ${poolSize}` },
    { key: "top", label: `重排 · 前 ${returnLimit}` },
    { key: "final", label: "最终来源" },
  ];
  const expectedIds = new Set(question.evidence.map((evidence) => evidence.chunk_id).filter((chunkId): chunkId is string => Boolean(chunkId)));
  return <div className="ev-question-chunk-comparison">
    <div className="ev-section-title">chunk 命中对比<small>绿色为包含预设证据的 chunk，灰色为其他返回 chunk</small></div>
    <div className="ev-chunk-detail-grid">
      <div className="ev-chunk-detail-column is-reference">
        <div className="ev-chunk-detail-heading"><strong>预设正确证据</strong><span>{question.evidence.length}</span></div>
        <div className="ev-chunk-detail-list">{question.evidence.map((evidence, index) => <div className="ev-chunk-detail-item is-reference" key={`${evidence.chunk_id ?? "evidence"}-${index}`}>
          <span>正确证据 {index + 1}</span><p>{evidence.text}</p><small>{evidence.chunk_id ?? "没有找到对应 chunk"}</small>
        </div>)}</div>
      </div>
      {stages.map((stage) => {
        const candidates = stageCandidates(question, stage.key, poolSize, returnLimit);
        return <div className="ev-chunk-detail-column" key={stage.key}>
          <div className="ev-chunk-detail-heading"><strong>{stage.label}</strong><span>{candidates.length}</span></div>
          <div className="ev-chunk-detail-list">{candidates.length === 0 ? <p className="ev-muted-note">没有返回 chunk</p> : candidates.map((candidate) => {
            const isCorrect = expectedIds.has(candidate.chunk_id);
            return <div className={`ev-chunk-detail-item ${isCorrect ? "is-correct" : "is-other"}`} key={`${stage.key}-${candidate.chunk_id}`}>
              <div><span>{isCorrect ? "✓ 包含证据" : "其他"}</span><code title={candidate.chunk_id}>{candidate.chunk_id}</code></div>
              <p>{candidate.preview}</p>
              <small>RRF {candidate.rrf_rank} · 重排 {candidate.rerank_rank ?? "—"}{stage.key === "final" ? ` · ${candidate.source_id ?? "未编号"}` : ""}</small>
            </div>;
          })}</div>
        </div>;
      })}
    </div>
  </div>;
}

function TypeTable({ run }: { run: EvalRun }) {
  const byType = run.by_type ?? {};
  const generation = run.kind === "generation";
  const columns = ["recall_pool", "recall_top", "recall_final", "mrr_top", "false_reject_rate", "false_accept_rate"];
  if (generation) columns.push("correctness", "faithfulness");
  // 同义改写的专项结果属于该题型的子项；默认展开，用户主动收起后只保留题型汇总行。
  const [paraphraseExpanded, setParaphraseExpanded] = useState(true);
  const hasParaphrase = Boolean(run.paraphrase);
  const toggleParaphrase = () => setParaphraseExpanded((expanded) => !expanded);
  const paraphrasePanelId = `paraphrase-analysis-${run.id}`;
  return <div className="diag-table-wrap"><table className="diag-table ev-table">
    <thead><tr><th>题型</th><th className="num">题数</th>{columns.map((key) => <th key={key} className="num" title={METRIC_HINTS[key]}>{metricLabel(key, run)}</th>)}</tr></thead>
    <tbody>{Object.entries(byType).map(([type, summary]) => {
      const isParaphrase = type === "同义改写" && hasParaphrase;
      const expanded = isParaphrase && paraphraseExpanded;
      return <Fragment key={type}>
        <tr
          className={isParaphrase ? "ev-type-main-row" : undefined}
          tabIndex={isParaphrase ? 0 : undefined}
          aria-expanded={isParaphrase ? expanded : undefined}
          aria-controls={isParaphrase ? paraphrasePanelId : undefined}
          title={isParaphrase ? "点击展开或收起同义改写专项结果" : undefined}
          onClick={isParaphrase ? toggleParaphrase : undefined}
          onKeyDown={isParaphrase ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleParaphrase(); } } : undefined}
        >
          <td>{isParaphrase && <span className="ev-type-expand-hint" aria-hidden="true">{expanded ? "▼" : "▶"}</span>}{type}</td>
          <td className="num">{summary.count}</td>{columns.map((key) => <td key={key} className="num">{formatMetric(key, summary[key])}</td>)}
        </tr>
        {expanded && run.paraphrase && <tr id={paraphrasePanelId} className="ev-type-subitem-row">
          <td colSpan={columns.length + 2}><ParaphraseAnalysis run={run} analysis={run.paraphrase} /></td>
        </tr>}
      </Fragment>;
    })}</tbody>
  </table></div>;
}

const PARAPHRASE_METRICS = ["recall_pool", "recall_top", "recall_final", "mrr_top", "false_reject_rate", "false_accept_rate"];

function formatParaphraseDelta(key: string, value: number | null) {
  if (value === null) return "—";
  if (key.startsWith("mrr")) return `${value > 0 ? "+" : ""}${value.toFixed(3)}`;
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;
}

function paraphraseStatusLabel(status: string) {
  const labels: Record<string, string> = { stable: "稳定命中", lost: "改写后丢失", gained: "改写后改善", both_missed: "两者未命中" };
  return labels[status] ?? status;
}

// 同义改写专项分析作为题型表的子项展示；这里复用相同指标比较原问题和改写问题。
function ParaphraseAnalysis({ run, analysis }: { run: EvalRun; analysis: EvalParaphraseAnalysis }) {
  return <section className="ev-paraphrase-analysis" aria-labelledby="ev-paraphrase-title">
    <div className="ev-section-title" id="ev-paraphrase-title">同义改写对比<small>{analysis.pair_count} 组题对 · {analysis.question_count} 个独立问题</small></div>
    <div className="ev-paraphrase-summary">
      <div><span>过滤后 Recall 改写保持率</span><strong>{formatPercent(analysis.retention.final)}</strong><small>只统计原问题已完整命中的题对</small></div>
      <div><span>原问题过滤后 Recall</span><strong>{formatMetric("recall_final", analysis.original.recall_final)}</strong><small>作为同义改写的基线</small></div>
      <div><span>改写问题过滤后 Recall</span><strong>{formatMetric("recall_final", analysis.paraphrase.recall_final)}</strong><small>改写后独立检索结果</small></div>
    </div>
    <div className="diag-table-wrap"><table className="diag-table ev-table ev-paraphrase-table">
      <thead><tr><th>指标</th><th className="num">原问题</th><th className="num">改写问题</th><th className="num">变化</th></tr></thead>
      <tbody>{PARAPHRASE_METRICS.map((key) => {
        const metric = analysis.metrics[key];
        return <tr key={key}><td>{metricLabel(key, run)}</td><td className="num">{formatMetric(key, metric?.original)}</td><td className="num">{formatMetric(key, metric?.paraphrase)}</td><td className={`num ${metric?.delta !== null && metric?.delta < 0 ? "ev-paraphrase-negative" : ""}`}>{formatParaphraseDelta(key, metric?.delta ?? null)}</td></tr>;
      })}</tbody>
    </table></div>
    <details className="ev-paraphrase-details"><summary>查看题对明细</summary><div className="ev-paraphrase-pairs">
      {analysis.pairs.map((pair) => <div className="ev-paraphrase-pair" key={pair.pair_id}>
        <div className="ev-paraphrase-pair-head"><code>{pair.pair_id}</code><span>{paraphraseStatusLabel(pair.statuses.final)}</span></div>
        <div><small>原问题</small><p>{pair.original.question}</p></div>
        <div><small>改写问题</small><p>{pair.paraphrase.question}</p></div>
      </div>)}
    </div></details>
  </section>;
}

// 一道题的检索结论：能回答的题看证据是否全部出现在最终来源里；无法回答的题看是否正确地没有返回来源。
function questionVerdict(question: EvalQuestion) {
  if (!question.answerable) return question.returned === 0 ? { key: "good", label: "正确拒绝" } : question.cleared ? { key: "good", label: "正确清空" } : { key: "bad", label: "漏放" };
  // 完整检索流程：按最终交给模型的资料算；被充分性判断清空的单独标出来。
  if (question.cleared) return { key: "bad", label: "被清空" };
  const recall = (question.sufficiency ? question.given_recall : null) ?? question.stages.final.recall ?? 0;
  if (recall >= 1) return { key: "good", label: "命中" };
  if (recall > 0) return { key: "warn", label: "部分命中" };
  return { key: "bad", label: "未命中" };
}

// 逐题明细：命中情况、证据名次、丢失阶段；无法回答题展开后直接查看被漏放的 chunk。
function QuestionList({ run, Diagnostics }: { run: EvalRun; Diagnostics: Props["Diagnostics"] }) {
  const questions = run.questions ?? [];
  const [typeFilter, setTypeFilter] = useState("all");
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  // 每个漏放来源默认只展示三行正文，展开状态按 chunk 独立保存，便于逐条核对内容。
  const [expandedLeaks, setExpandedLeaks] = useState<Record<string, boolean>>({});
  const types: string[] = [];
  for (const question of questions) if (!types.includes(question.type)) types.push(question.type);
  const visible = questions.filter((question) => {
    if (typeFilter !== "all" && question.type !== typeFilter) return false;
    const verdict = questionVerdict(question);
    if (verdictFilter === "problem" && verdict.key === "good") return false;
    if (verdictFilter === "good" && verdict.key !== "good") return false;
    return true;
  });
  const topLimit = run.config.return_limit ?? 6;
  return <div>
    <div className="ev-filters">
      <FilterChips value={typeFilter} options={[["all", "全部题型"], ...types.map((type): [string, string] => [type, type])]} onChange={setTypeFilter} />
      <FilterChips value={verdictFilter} options={[["all", "全部结果"], ["problem", "只看有问题"], ["good", "只看通过"]]} onChange={setVerdictFilter} />
      <span className="ev-filter-count">{visible.length} / {questions.length} 题</span>
    </div>
    <div className="ev-question-columns" aria-hidden="true"><span>编号</span><span>问题</span><span>检索结果</span><span>证据位置（RRF / 重排 / 来源）</span><span>丢失阶段</span><span /></div>
    <div className="ev-question-list">{visible.map((question) => {
      const verdict = questionVerdict(question);
      const open = expanded === question.id;
      const first = question.evidence[0];
      const sourceById = new Map((question.sources ?? []).map((source) => [source.id, source]));
      const leakedChunks = !question.answerable
        ? (question.diagnostics?.candidates ?? []).filter((candidate) => candidate.status === "returned").map((candidate) => ({
          candidate,
          source: candidate.source_id ? sourceById.get(candidate.source_id) : undefined,
        }))
        : [];
      return <article className={`ev-question ${open ? "is-open" : ""}`} key={question.id}>
        <button className="ev-question-head" aria-expanded={open} onClick={() => setExpanded(open ? null : question.id)}>
          <span className="ev-qid">{question.id}</span>
          <span className="ev-question-text">{question.question}<small>{question.type}{question.evidence_count > 1 ? ` · ${question.evidence_count} 条证据` : ""}</small></span>
          <span className={`ev-verdict is-${verdict.key}`}><b>{verdict.key === "good" ? "✓" : verdict.key === "warn" ? "◐" : "✕"}</b>{verdict.label}</span>
          <span className="ev-rank" title="证据所在分片：RRF 名次 / 重排名次 / 最终来源编号">{question.answerable ? (first ? `RRF ${first.rrf_rank ?? "—"} · 重排 ${first.rerank_rank ?? "—"} · ${first.source_id ?? "未返回"}` : "—") : `返回 ${question.returned} 条`}</span>
          <span className="ev-lost" title={question.lost_stage ? LOST_LABELS[question.lost_stage].hint : ""}>{question.lost_stage ? LOST_LABELS[question.lost_stage].label : question.answerable ? "—" : question.max_probability === null ? "—" : `最高概率 ${formatScore(question.max_probability, 2)}`}</span>
          <span className="collapse-icon">{open ? "−" : "＋"}</span>
        </button>
        {open && <div className="ev-question-body">
          {question.lost_stage && <p className="ev-lost-hint">丢失阶段：<strong>{LOST_LABELS[question.lost_stage].label}</strong>。{LOST_LABELS[question.lost_stage].hint}</p>}
          <div className="ev-stage-row">
            {(["pool", "top", "final"] as const).map((stage) => {
              const label = stage === "pool" ? `召回前 ${run.config.pool_size ?? 20}` : stage === "top" ? `重排前 ${topLimit}` : "阈值过滤后";
              return <div key={stage}>
                <span>{label}</span>
                <strong>{question.answerable ? formatPercent(question.stages[stage].recall) : "不适用"}</strong>
                <small>{question.answerable ? (question.stages[stage].rank ? `第 ${question.stages[stage].rank} 名` : "未找到") : "无标准证据，无法计算 Recall"}</small>
              </div>;
            })}
            {question.sufficiency && <div className={question.cleared ? "is-cleared" : ""}><span>最终交给模型</span>
              <strong>{question.answerable ? formatPercent(question.given_recall) : question.cleared ? "已清空" : `${question.sufficiency.source_count ?? question.returned} 段`}</strong>
              <small>{question.cleared ? "判断为资料不足，来源已清空" : question.sufficiency.retry_used ? "用了补充检索的结果" : question.sufficiency.checked ? "用第一次检索的结果" : "未做充分性判断"}{question.answerable && question.first_given_recall !== undefined && question.first_given_recall !== null && question.first_given_recall !== question.given_recall ? ` · 第一次 ${formatPercent(question.first_given_recall)}` : ""}</small></div>}
            <div><span>耗时</span><strong>{formatMs(question.flow_latency_ms ?? question.latency_ms)}</strong><small>{question.flow_latency_ms !== undefined && question.flow_latency_ms !== null ? `检索 ${formatMs(question.latency_ms)} · ` : ""}返回 {question.returned} 条来源</small></div>
          </div>
          {!question.answerable && <div className={`ev-leak-panel ${question.returned > 0 ? "is-leak" : "is-safe"}`}>
            <div className="ev-section-title">漏放来源<small>{question.returned > 0 ? `这道题返回了 ${question.returned} 条来源，以下 chunk 被放行给回答模型` : "没有返回来源，系统正确拒答"}</small></div>
            {question.returned === 0 ? <p className="ev-leak-note">这道题没有来源被交给回答模型，因此不属于漏放。</p> : leakedChunks.length === 0 ? <p className="ev-leak-note">这次没保存分块明细。</p> : <div className="ev-leak-list">{leakedChunks.map(({ candidate, source }) => {
              const chunkKey = `${question.id}:${candidate.chunk_id}`;
              const chunkExpanded = expandedLeaks[chunkKey] ?? false;
              const chunkText = source?.text ?? candidate.preview;
              return <div className="ev-leak-chunk" key={candidate.chunk_id}>
                <div className="ev-leak-chunk-head"><strong>{candidate.source_id ?? "—"}</strong><span>{candidate.title}{candidate.heading ? ` · ${candidate.heading}` : ""}</span><code title={candidate.chunk_id}>{candidate.chunk_id}</code></div>
                <p className={chunkExpanded ? "is-expanded" : ""}>{chunkText}</p>
                <button type="button" className="ev-leak-toggle" aria-expanded={chunkExpanded} onClick={() => setExpandedLeaks((items) => ({ ...items, [chunkKey]: !chunkExpanded }))}>{chunkExpanded ? "收起" : "展开更多"}<span aria-hidden="true">{chunkExpanded ? "↑" : "↓"}</span></button>
                <div className="ev-leak-chunk-meta"><span>RRF 第 {candidate.rrf_rank} 名</span><span>重排第 {candidate.rerank_rank ?? "—"} 名</span><span>概率 {formatScore(candidate.rerank_probability, 3)}</span></div>
              </div>;
            })}</div>}
          </div>}
          {question.answerable && <QuestionChunkComparison question={question} run={run} />}
          {question.evidence.length > 0 && <div className="ev-evidence-list">{question.evidence.map((evidence, index) => <div className="ev-evidence" key={index}>
            <p>“{evidence.text}”</p>
            <span>{EVIDENCE_STATUS[evidence.status] ?? evidence.status}</span><span>RRF 第 {evidence.rrf_rank ?? "—"} 名</span><span>重排第 {evidence.rerank_rank ?? "—"} 名</span><span>概率 {formatScore(evidence.rerank_probability, 3)}</span><span>来源 {evidence.source_id ?? "—"}</span>
          </div>)}</div>}
          <div className="ev-queries"><span>检索词</span>{question.queries.map((query) => <code key={query}>{query}</code>)}<span>重排问题</span><code>{question.rerank_query}</code><small>{rewriteLabel(question)}</small></div>
          {question.sufficiency && <SufficiencyReview result={question.sufficiency} question={question} />}
          {question.answer !== undefined && <AnswerReview question={question} />}
          {question.diagnostics && <details className="ev-diagnostics"><summary>检索诊断：每张排名表、RRF 贡献、重排概率和最终去向</summary><Diagnostics data={question.diagnostics} /></details>}
        </div>}
      </article>;
    })}</div>
  </div>;
}

// 逐题展示充分性判断的原始结论，重点标明是否补检以及补检后实际交给回答模型的 chunk 数。
function SufficiencyReview({ result, question }: { result: EvalSufficiency; question?: EvalQuestion }) {
  if (!result.checked) return <div className="ev-sufficiency-detail is-unchecked"><div className="ev-section-title">资料充分性<small>未调用判断模型</small></div><p>本题未执行资料充分性判断，沿用检索结果。</p></div>;
  const verdict = result.verdict;
  const missing = sufficiencyMissingText(result.missing);
  return <div className={`ev-sufficiency-detail is-${verdict ?? "unchecked"}`}>
    <div className="ev-section-title">资料充分性<small>和线上同一套判断{result.calls ? ` · 判断 ${result.calls} 次` : ""}</small></div>
    <div className="ev-sufficiency-detail-grid">
      <div><span>判断结论</span><strong>{verdict ? SUFFICIENCY_LABELS[verdict] : "未判定"}</strong></div>
      <div><span>补充检索</span><strong>{result.retried ? "已触发" : "未触发"}</strong><small>{result.retry_query ? `检索词：${result.retry_query}` : "第一次检索后未追加检索"}{question?.retry ? ` · 返回 ${question.retry.returned} 段${question.answerable ? `，命中 ${formatPercent(question.retry.given_recall)}` : ""} · ${question.retry.used ? "采用了" : "没变好，沿用第一次的"}` : ""}</small></div>
      <div><span>最终返回 chunk</span><strong>{result.source_count ?? "—"}</strong><small>{result.refused ? "资料不足，来源已清空并拒答" : "交给回答模型的最终来源数量"}</small></div>
    </div>
    {missing && <p className="ev-sufficiency-missing">缺少：{missing}</p>}
  </div>;
}

// 生成的回答和评审结果，附评审理由便于人工抽查。
function AnswerReview({ question }: { question: EvalQuestion }) {
  const judgement = question.judgement;
  return <div className="ev-answer">
    <div className="ev-section-title">生成的回答{judgement && <small>{judgement.judge === "rule" ? "固定拒答，按规则判定" : "大模型评审"}{judgement.refused ? " · 拒答" : ""}</small>}</div>
    <p className="ev-answer-text">{question.answer}</p>
    {judgement && <div className="ev-judge-grid">
      <div><span>忠实度</span><strong>{formatScore(judgement.faithfulness, 1)}</strong><small>{judgement.faithfulness_reason}</small></div>
      <div><span>正确性</span><strong>{formatScore(judgement.correctness, 1)}</strong><small>{judgement.correctness_reason}</small></div>
      <div><span>引用有效性</span><strong>{formatScore(judgement.citation, 1)}</strong><small>{judgement.citation_reason}</small></div>
    </div>}
  </div>;
}

function FilterChips({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <div className="ev-chips" role="group">{options.map(([key, label]) => <button key={key} className={value === key ? "active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>{label}</button>)}</div>;
}

// 阈值扫描：同一批重排概率在不同阈值下的误杀率、漏放率和过滤后召回率。
function SweepPanel({ run }: { run: EvalRun }) {
  const sweep = run.sweep ?? [];
  if (sweep.length === 0) return <div className="ev-empty"><h3>这次评测没有阈值扫描</h3><p>这次没启用重排，没有分数可扫。</p></div>;
  const current = run.config.min_score ?? null;
  let best: EvalSweepPoint | null = null;
  for (const point of sweep) {
    const cost = (point.false_reject_rate ?? 0) + (point.false_accept_rate ?? 0);
    if (!best || cost < (best.false_reject_rate ?? 0) + (best.false_accept_rate ?? 0)) best = point;
  }
  return <div>
    <p className="ev-muted-note">阈值越高，漏放越少、误杀越多。{best && <> 两者之和最小在 <strong>{best.threshold.toFixed(2)}</strong>（误杀 {formatPercent(best.false_reject_rate)}，漏放 {formatPercent(best.false_accept_rate)}），改之前先用留出集验证。</>}</p>
    <SweepChart sweep={sweep} current={current} />
    <details className="ev-table-view"><summary>表格视图</summary><div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th className="num">阈值</th><th className="num">误杀率</th><th className="num">漏放率</th><th className="num">过滤后 Recall</th></tr></thead>
      <tbody>{sweep.map((point) => <tr key={point.threshold} className={current !== null && Math.abs(point.threshold - current) < 1e-6 ? "is-current" : ""}><td className="num">{point.threshold.toFixed(2)}</td><td className="num">{formatPercent(point.false_reject_rate)}</td><td className="num">{formatPercent(point.false_accept_rate)}</td><td className="num">{formatPercent(point.recall_final)}</td></tr>)}</tbody>
    </table></div></details>
    <LimitSweep points={run.limit_sweep ?? []} current={run.config.return_limit ?? null} />
  </div>;
}

// 「交给模型的段数」扫描：在当前阈值下，段数取不同值时证据召回和平均实际交给模型几段。
// 召回在某个段数之后不再上升，说明再多给也找不到更多证据，只会让输入更长。
function LimitSweep({ points, current }: { points: EvalLimitPoint[]; current: number | null }) {
  if (points.length === 0) return null;
  const top = Math.max(...points.map((point) => point.recall_final ?? 0));
  const enough = points.find((point) => (point.recall_final ?? 0) >= top);
  return <div className="ev-limit-sweep">
    <div className="ev-section-title">交给模型的段数<small>在当前阈值下离线重算，不需要重新检索</small></div>
    <p className="ev-muted-note">{enough && <>段数达到 <strong>{enough.return_limit}</strong> 时召回已到最高 {formatPercent(top)}，再多只会让输入更长。</>}现在是 {current ?? "—"} 段。</p>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th className="num">段数</th><th className="num">证据召回</th><th className="num">证据全部命中</th><th className="num">多证据题召回</th><th className="num">平均实际交给模型</th><th className="num">被段数截断的题</th></tr></thead>
      <tbody>{points.map((point) => <tr key={point.return_limit} className={point.return_limit === current ? "is-current" : ""}>
        <td className="num">{point.return_limit}</td>
        <td className="num">{formatPercent(point.recall_final)}</td>
        <td className="num">{point.complete} / {point.answerable}</td>
        <td className="num">{point.multi_evidence ? `${formatPercent(point.multi_evidence_recall)}（${point.multi_evidence} 题）` : "—"}</td>
        <td className="num">{point.avg_returned?.toFixed(2) ?? "—"} 段</td>
        <td className="num">{point.capped} / {point.total}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

const SWEEP_SERIES = [
  { key: "false_reject_rate" as const, label: "误杀率", className: "series-1" },
  { key: "false_accept_rate" as const, label: "漏放率", className: "series-2" },
  { key: "recall_final" as const, label: "过滤后 Recall", className: "series-3" },
];

// 折线图：一个纵轴（0~100% 的比例），横轴是阈值；悬停时竖线吸附到最近的阈值，提示框列出三条线在该点的值。
function SweepChart({ sweep, current }: { sweep: EvalSweepPoint[]; current: number | null }) {
  // 按容器实际宽度绘制，而不是固定 viewBox 再整体缩放：缩放会把坐标轴文字一起放大或缩小，宽屏上字很大、手机上字太小。
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(300, Math.round(entries[0].contentRect.width))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const height = width < 520 ? 260 : 300;
  const margin = { top: 16, right: width < 520 ? 88 : 116, bottom: 40, left: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minX = sweep[0].threshold;
  const maxX = sweep[sweep.length - 1].threshold;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const x = (value: number) => margin.left + ((value - minX) / (maxX - minX)) * plotWidth;
  const y = (value: number) => margin.top + (1 - value) * plotHeight;
  const paths = useMemo(() => SWEEP_SERIES.map((series) => {
    let d = "";
    for (const point of sweep) {
      const value = point[series.key];
      if (value === null) continue;
      d += `${d ? "L" : "M"}${x(point.threshold).toFixed(1)},${y(value).toFixed(1)}`;
    }
    return { ...series, d };
  }), [sweep, width, height]);
  // 终点标签按数值排好后留出最小间距，避免三条线收尾接近时文字重叠。
  const endLabels = SWEEP_SERIES.map((series) => ({ ...series, value: sweep[sweep.length - 1][series.key] ?? 0 })).sort((a, b) => b.value - a.value);
  let lastY = -Infinity;
  const placed = endLabels.map((item) => {
    const target = Math.max(y(item.value), lastY + 15);
    lastY = target;
    return { ...item, labelY: target };
  });
  function pick(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relative = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    for (let index = 0; index < sweep.length; index += 1) {
      if (Math.abs(x(sweep[index].threshold) - relative) < Math.abs(x(sweep[nearest].threshold) - relative)) nearest = index;
    }
    setHover(nearest);
  }
  function onKey(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (event.key === "ArrowRight") setHover((value) => Math.min(sweep.length - 1, (value ?? -1) + 1));
    if (event.key === "ArrowLeft") setHover((value) => Math.max(0, (value ?? sweep.length) - 1));
  }
  const hovered = hover === null ? null : sweep[hover];
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // 窄屏时横轴只标 0.2、0.4…，避免刻度文字挤在一起。
  const tickStep = width < 520 ? 20 : 10;
  const xTicks = sweep.filter((point) => Math.round(point.threshold * 100) % tickStep === 0);
  return <div className="ev-chart">
    <div className="ev-legend">{SWEEP_SERIES.map((series) => <span key={series.key}><i className={`ev-line-key ${series.className}`} />{series.label}</span>)}{current !== null && <span><i className="ev-line-key is-threshold" />当前阈值 {current.toFixed(2)}</span>}</div>
    <div className="ev-chart-frame" ref={frameRef}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="阈值扫描折线图：误杀率、漏放率和过滤后召回率随阈值变化" tabIndex={0} onPointerMove={pick} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}><line className="ev-grid" x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} /><text className="ev-axis" x={margin.left - 8} y={y(tick) + 4} textAnchor="end">{tick * 100}%</text></g>)}
        {xTicks.map((point) => <text key={point.threshold} className="ev-axis" x={x(point.threshold)} y={height - margin.bottom + 18} textAnchor="middle">{point.threshold.toFixed(1)}</text>)}
        <text className="ev-axis" x={margin.left + plotWidth / 2} y={height - 4} textAnchor="middle">重排概率阈值</text>
        {current !== null && current >= minX && current <= maxX && <g><line className="ev-threshold" x1={x(current)} x2={x(current)} y1={margin.top} y2={margin.top + plotHeight} /><text className="ev-threshold-label" x={x(current) + 5} y={margin.top + plotHeight - 6}>当前 {current.toFixed(2)}</text></g>}
        {paths.map((series) => <path key={series.key} className={`ev-series ${series.className}`} d={series.d} />)}
        {placed.map((item) => <text key={item.key} className="ev-end-label" x={margin.left + plotWidth + 8} y={item.labelY + 4}>{width < 520 ? formatPercent(item.value) : `${item.label} ${formatPercent(item.value)}`}</text>)}
        {hovered && <g><line className="ev-crosshair" x1={x(hovered.threshold)} x2={x(hovered.threshold)} y1={margin.top} y2={margin.top + plotHeight} />{SWEEP_SERIES.map((series) => hovered[series.key] === null ? null : <circle key={series.key} className={`ev-dot ${series.className}`} cx={x(hovered.threshold)} cy={y(hovered[series.key] as number)} r={4.5} />)}</g>}
      </svg>
      {hovered && <div className="ev-tooltip" style={{ left: `${(x(hovered.threshold) / width) * 100}%` }}>
        <div className="ev-tooltip-title">阈值 {hovered.threshold.toFixed(2)}</div>
        {SWEEP_SERIES.map((series) => <div key={series.key} className="ev-tooltip-row"><i className={`ev-line-key ${series.className}`} /><strong>{formatPercent(hovered[series.key])}</strong><span>{series.label}</span></div>)}
      </div>}
    </div>
  </div>;
}

// 消融实验与参数对比：每一组只改一个因素，和基线逐项比较，差值标出变好或变差。
function VariantPanel({ run }: { run: EvalRun }) {
  const variants = run.variants ?? [];
  if (variants.length === 0) return <div className="ev-empty"><h3>这次评测没有包含实验组</h3><p>发起时勾选「消融实验」或「参数对比」才有。</p></div>;
  const keys = ["recall_pool", "recall_top", "recall_final", "mrr_top", "false_reject_rate", "false_accept_rate", "latency_avg_ms"];
  const lower = new Set(["false_reject_rate", "false_accept_rate", "latency_avg_ms"]);
  const baseline = run.summary ?? {};
  function cell(key: string, value: number | null | undefined) {
    const base = baseline[key];
    if (value === null || value === undefined || base === null || base === undefined) return <td key={key} className="num">{formatMetric(key, value)}</td>;
    const delta = value - base;
    // 与后端对比规则一致：耗时差不超过 5 毫秒或 10% 视为自然波动。
    const tolerance = key.includes("_ms") ? Math.max(5, Math.abs(base) * 0.1) : 1e-6;
    const change = Math.abs(delta) <= tolerance ? "same" : (delta > 0) !== lower.has(key) ? "better" : "worse";
    // 耗时差值以前只有数字、没有单位，改成带正负号的时分秒。
    const text = key.includes("_ms") ? formatDurationDelta(delta) : key.startsWith("mrr") ? `${delta > 0 ? "+" : ""}${delta.toFixed(3)}` : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}`;
    return <td key={key} className="num">{formatMetric(key, value)}<small className={`ev-delta is-${change}`}>{change === "same" ? "持平" : `${change === "better" ? "变好" : "变差"} ${text}`}</small></td>;
  }
  const groups: Record<string, typeof variants> = {};
  for (const variant of variants) (groups[variant.suite] ??= []).push(variant);
  return <div>
    <p className="ev-muted-note">差值相对基线。没有重排的几组也没有阈值过滤，漏放率会偏高。</p>
    <div className="diag-table-wrap"><table className="diag-table ev-table">
      <thead><tr><th>配置</th>{keys.map((key) => <th key={key} className="num" title={METRIC_HINTS[key]}>{metricLabel(key, run)}</th>)}</tr></thead>
      <tbody>
        <tr className="is-current"><td>基线（当前配置）</td>{keys.map((key) => <td key={key} className="num">{formatMetric(key, baseline[key])}</td>)}</tr>
        {Object.entries(groups).map(([suite, items]) => [<tr key={suite} className="ev-group-row"><td colSpan={keys.length + 1}>{suite === "ablation" ? "消融实验：去掉一个组件，看它贡献了多少" : "参数对比：凭经验定的参数换一个值会怎样"}</td></tr>, ...items.map((variant) => <tr key={variant.name}><td>{variant.label}</td>{keys.map((key) => cell(key, variant.summary[key]))}</tr>)])}
      </tbody>
    </table></div>
  </div>;
}

// 历史记录中的单个指标子项：把解释放在数值下方，用户不必再对照页面底部说明。
function HistoryMetric({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  return <div className="ev-history-metric-item"><span className="ev-history-metric-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

// 历次评测记录：选中两次查看逐项对比。
// 评测记录的「结果」列：每次最主要的那个数。调参检索看最终交给模型的命中率，生成看正确性，专项看通过数；
// 两种模式一起跑时两边各写一个。没跑完的显示「—」。
function runResult(item: EvalRunBrief) {
  const summary = (item.summary ?? {}) as Record<string, number | null | undefined>;
  if (item.status !== "completed" || !item.summary) return "—";
  const modes = runModes(item);
  const both = modes.includes("fixed") && modes.includes("agent");
  if (item.kind === "special") {
    const passed = `${summary.passed ?? 0} / ${summary.count ?? 0}`;
    if (both) return `固定流程 ${passed} · Agent ${summary.agent_passed ?? 0} / ${summary.count ?? 0}`;
    return `${modes[0] === "agent" ? "Agent " : ""}通过 ${passed}`;
  }
  if (item.kind === "generation") return `正确性 ${formatPercent(summary.correctness)}`;
  if (item.kind === "retrieval") {
    const fixed = formatPercent(summary.recall_given ?? summary.recall_final);
    if (both) return `固定流程 ${fixed} · Agent ${formatPercent(summary.agent_recall)}`;
    return modes[0] === "agent" ? `Agent 命中 ${formatPercent(summary.agent_recall)}` : `命中 ${fixed}`;
  }
  return "—";
}

// 只比和检索、回答结果有关的参数：设置页里「检索」「分片」「回答」三组（app/runtime_config.py 的 group）。
// 对话记忆、安全检查、巡检、界面配色、服务超时这些和评测分数关系不大，改了也不提示。
const RESULT_SETTINGS = new Set([
  "rerank_min_score", "rerank_fallback_min_score", "rerank_candidates", "return_limit", "parent_context", "parent_max_chars",
  "parent_radius", "rerank_enabled", "rrf_k", "chunk_context_max_tokens", "chunk_size", "chunk_overlap",
  "sufficiency_check", "intent_local", "contextual_retrieval", "agent_tool_budget", "agent_timeout",
]);

// 上一次「同一种」评测：调参评测要类型和题目范围都相同；专项要跑的是同一组专项（截断专项和 Agent 区分题不互相比）。
function sameSeries(run: EvalRunBrief, item: EvalRunBrief) {
  if (run.kind !== item.kind) return false;
  if (item.kind === "special") {
    const ids = (value: EvalRunBrief) => (value.config.special?.suites ?? []).map((suite) => suite.id).sort().join(",");
    return ids(run) === ids(item);
  }
  return run.config.split === item.config.split;
}

// 和上一次同一种评测比，参数改过哪些（和结果有关的设置页参数、改写提示词和模型、Agent 提示词和模型）；没改过返回空数组。
// 参数平时不怎么改，表格里不再每行列出参数，只在改过时提示。
function settingsChanges(item: EvalRunBrief, runs: EvalRunBrief[]) {
  const index = runs.findIndex((run) => run.id === item.id);
  const previous = runs.slice(index + 1).find((run) => sameSeries(run, item) && run.status === "completed" && run.config.settings);
  if (!previous || !item.config.settings) return [];
  const changes: string[] = [];
  const before = previous.config.settings as Record<string, unknown>;
  const after = item.config.settings as Record<string, unknown>;
  for (const key of Object.keys(after)) {
    if (!RESULT_SETTINGS.has(key)) continue;
    if (key in before && JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(`${settingLabel(key)} ${String(before[key])} → ${String(after[key])}`);
  }
  const pairs: [string, unknown, unknown][] = [
    ["改写提示词", previous.config.flow?.intent_prompt, item.config.flow?.intent_prompt],
    ["改写模型", previous.config.flow?.model, item.config.flow?.model],
    ["Agent 提示词", previous.config.agent?.prompt_version, item.config.agent?.prompt_version],
    ["Agent 模型", previous.config.agent?.model, item.config.agent?.model],
  ];
  for (const [label, from, to] of pairs) if (from && to && from !== to) changes.push(`${label} ${String(from)} → ${String(to)}`);
  return changes;
}

function RunHistory({ runs, onOpen, onDelete }: { runs: EvalRunBrief[]; onOpen: (id: string) => void; onDelete: (id: string) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 指标子项不能跨表格行使用 details；显式记录展开项。记录默认都收起，点一行才展开它的指标。
  const [expandedMetricRuns, setExpandedMetricRuns] = useState<string[]>([]);
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  // 勾选两条后点「对比」按钮才请求，结果在弹窗里显示（原来勾满两条就自动对比、显示在表格下面，不容易看到）。
  async function openComparison() {
    if (picked.length !== 2) return;
    // 较早的一次作为基准，变化方向始终表示"从旧到新"。
    const [first, second] = [...picked].sort();
    setComparing(true);
    setError("");
    try {
      setComparison(await compareEvalRuns(first, second));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setComparing(false);
    }
  }
  useEffect(() => {
    if (!comparison) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComparison(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparison]);
  function toggle(id: string) {
    setPicked((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items.slice(-1), id]));
  }
  function toggleMetrics(id: string) {
    setExpandedMetricRuns((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
  }

  // 删除前明确展示时间和状态，避免把误点“删除”当成可逆操作。
  async function remove(item: EvalRunBrief) {
    if (item.status === "running") return;
    if (!window.confirm(`确定删除 ${formatTime(item.created)} 的${KIND_LABELS[item.kind]}评测记录吗？删除后不可恢复。`)) return;
    setDeletingId(item.id);
    try {
      await onDelete(item.id);
      setPicked((items) => items.filter((pickedId) => pickedId !== item.id));
    } finally {
      setDeletingId(null);
    }
  }
  if (runs.length === 0) return <EmptyRuns hasRuns={false} />;
  const pickedRuns = runs.filter((item) => picked.includes(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  return <div>
    {error && <div className="error-banner">{error}</div>}
    <div className="ev-compare-bar">
      <span>{picked.length === 0 ? "勾选两条已完成的记录，再点「对比」看指标变化。" : picked.length === 1 ? "已选 1 条，再选 1 条。" : `已选 2 条：${pickedRuns.map((item) => formatTime(item.created)).join(" → ")}`}</span>
      {picked.length > 0 && <button type="button" className="secondary-button" onClick={() => setPicked([])}>清除选择</button>}
      <button type="button" className="primary-button" disabled={picked.length !== 2 || comparing} onClick={() => void openComparison()}>{comparing ? "正在对比…" : `对比（${picked.length}/2）`}</button>
    </div>
    <div className="diag-table-wrap ev-history-table-wrap"><table className="diag-table ev-table ev-history-table">
      {/* 历史记录只保留运行结果相关字段；提交号属于构建元数据，移除后给题数、配置和状态留出空间。 */}
      <thead><tr><th>对比</th><th>时间</th><th>类型</th><th>范围</th><th>题数</th><th>结果</th><th>耗时</th><th>状态</th><th /></tr></thead>
      <tbody>{runs.map((item) => {
        const metricsExpanded = expandedMetricRuns.includes(item.id);
        // 指标说明所需统计已随历史列表返回，展开行只做本地渲染，不再触发逐条详情请求。
        const stats = historyEvidenceStats(item.history_metrics);
        // 指标卡片下面的一句说明，和详情页总览同一套（metricSentence）；旧记录没有逐题统计时退回通用说明。
        const sentence = (key: string) => metricSentence(key, stats, item.config) ?? METRIC_HINTS[key] ?? FLOW_METRIC_EXPLANATIONS[key] ?? "—";
        return <Fragment key={item.id}>
          <tr className={`ev-history-main-row ${picked.includes(item.id) ? "is-current" : ""}`} tabIndex={0} aria-expanded={metricsExpanded} aria-controls={`history-metrics-${item.id}`} title="点击展开或收起指标" onClick={() => toggleMetrics(item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleMetrics(item.id); } }}>
            <td><input type="checkbox" aria-label={`选择 ${item.id}`} checked={picked.includes(item.id)} disabled={item.status !== "completed"} onClick={(event) => event.stopPropagation()} onChange={() => toggle(item.id)} /></td>
            <td className="ev-history-time">{formatTime(item.created)}</td><td><span className="tag-row"><HueTag label={KIND_LABELS[item.kind]} />{(item.kind === "retrieval" || item.kind === "special") && runModes(item).includes("agent") && runModes(item).map((mode) => <HueTag key={mode} label={mode === "agent" ? "Agent" : "固定流程"} />)}</span></td><td>{item.kind === "special" ? (item.config.special?.suites ?? []).map((suite) => suite.name).join("、") : SPLIT_LABELS[item.config.split ?? ""] ?? item.config.split}</td><td className="num ev-history-number">{item.kind === "special" ? item.summary?.count ?? "—" : item.config.dataset_size ?? "—"}</td>
            {/* 结果列：每次最主要的那个数；参数平时不变，只在和上一次同类评测不一样时标「参数改过」，鼠标放上去看改了什么。 */}
            <td className="ev-result-cell"><span className="tag-row"><span>{runResult(item)}</span>{(() => { const changes = settingsChanges(item, runs); return changes.length > 0 && <Tag size="sm" tone="warning" title={`和上一次同一种评测比：\n${changes.join("\n")}`}>参数改过</Tag>; })()}</span></td>
            <td className="num ev-history-latency" title={durationTitle(item.summary?.flow_latency_avg_ms ?? item.summary?.latency_avg_ms ?? item.summary?.agent_latency_avg_ms)}>{formatMs(item.summary?.flow_latency_avg_ms ?? item.summary?.latency_avg_ms ?? item.summary?.agent_latency_avg_ms)}</td>
            <td><span className="tag-row"><Tag dot tone={runStatus(item.status).tone}>{runStatus(item.status).label}{item.status === "running" ? ` ${progressPercent(item)}%` : ""}</Tag></span></td>
            <td><div className="ev-history-actions"><button className="ev-link ev-expand-link" aria-expanded={metricsExpanded} onClick={(event) => { event.stopPropagation(); toggleMetrics(item.id); }}>{item.kind === "special" ? "各专项" : "指标"} {metricsExpanded ? "▴" : "▾"}</button><button className="ev-link" onClick={(event) => { event.stopPropagation(); onOpen(item.id); }}>查看</button><button className="ev-delete-link" disabled={item.status === "running" || deletingId === item.id} title={item.status === "running" ? "评测运行中，不能删除" : "删除这条评测记录"} onClick={(event) => { event.stopPropagation(); void remove(item); }}>{deletingId === item.id ? "删除中…" : "删除"}</button></div></td>
          </tr>
          {metricsExpanded && item.kind === "special" && <tr id={`history-metrics-${item.id}`} className="ev-history-metrics-row">
            <td colSpan={9}><div className="ev-history-metrics-panel"><div className="ev-history-metrics-heading">各专项结果</div><div className="ev-history-metrics-grid">
              {Object.entries(((item.summary as unknown as { suites?: Record<string, { name: string; count: number; passed: number; modes?: EvalMode[]; agent_passed?: number | null }> } | null)?.suites) ?? {}).map(([key, entry]) => {
                const agentOnly = (entry.modes ?? []).length === 1 && entry.modes?.[0] === "agent";
                const both = (entry.modes ?? []).includes("agent") && !agentOnly;
                return <HistoryMetric key={key} label={entry.name} value={both ? `${entry.passed} / ${entry.count} · Agent ${entry.agent_passed ?? 0} / ${entry.count}` : `${entry.passed} / ${entry.count}`}
                  hint={both ? "固定流程 · Agent 各自通过数" : agentOnly ? "Agent 通过数" : "通过数"} />;
              })}
              {item.status !== "completed" && <span className="ev-muted-note">{runStatus(item.status).label}</span>}
            </div></div></td>
          </tr>}
          {metricsExpanded && item.kind !== "special" && <tr id={`history-metrics-${item.id}`} className="ev-history-metrics-row">
            <td colSpan={9}><div className="ev-history-metrics-panel"><div className="ev-history-metrics-heading">本条记录指标</div><div className="ev-history-metrics-grid">
              {runModes(item).includes("agent") && <HistoryMetric label="Agent 资料命中率" value={formatPercent(item.summary?.agent_recall)} hint={metricSentence("agent_recall", stats, item.config) ?? "Agent 找到资料，包含题目的证据的比例"} />}
              {runModes(item).includes("fixed") && <>
              {/* 完整检索流程的新记录：最终交给模型的命中率（结果列显示的就是它）和误清空率。 */}
              {item.config.flow?.name === "full" && <HistoryMetric label="固定流程资料命中率" value={formatPercent(item.summary?.recall_given)} hint={sentence("recall_given")} />}
              {item.config.flow?.name === "full" && <HistoryMetric label="误清空率" value={formatPercent(item.summary?.wrong_clear_rate)} hint={sentence("wrong_clear_rate")} />}
              <HistoryMetric label="候选池 Recall" value={formatPercent(item.summary?.recall_pool)} hint={sentence("recall_pool")} />
              {/* 补齐召回、重排、阈值过滤三个阶段，避免只看首尾指标而定位不到重排损失。 */}
              <HistoryMetric label="重排 Recall" value={formatPercent(item.summary?.recall_top)} hint={sentence("recall_top")} />
              <HistoryMetric label="最终 Recall" value={formatPercent(item.summary?.recall_final)} hint={sentence("recall_final")} />
              <HistoryMetric label="候选池 MRR" value={formatMetric("mrr_pool", item.summary?.mrr_pool)} hint={sentence("mrr_pool")} />
              <HistoryMetric label="误杀率" value={formatPercent(item.summary?.false_reject_rate)} hint={sentence("false_reject_rate")} />
              <HistoryMetric label="漏放率" value={formatPercent(item.summary?.false_accept_rate)} hint={sentence("false_accept_rate")} />
              </>}
            </div></div></td>
          </tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
    {comparison && <div className="ev-add-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setComparison(null); }}>
      <div className="ev-add-modal ev-compare-modal" role="dialog" aria-modal="true" aria-labelledby="ev-compare-title">
        <div className="ev-add-modal-header"><h3 id="ev-compare-title">对比结果</h3><button type="button" className="ev-modal-close" aria-label="关闭" onClick={() => setComparison(null)}>×</button></div>
        <div className="ev-compare-runs">
          <div><span>基准（较早）</span><strong>{formatTime(comparison.base.created)}</strong><small>{KIND_LABELS[comparison.base.kind]}{comparison.base.kind === "retrieval" ? ` · ${modesLabel(comparison.base)}` : ""} · {SPLIT_LABELS[comparison.base.config.split ?? ""] ?? comparison.base.config.split ?? "—"}</small></div>
          <span className="ev-compare-arrow" aria-hidden="true">→</span>
          <div><span>对比（较新）</span><strong>{formatTime(comparison.target.created)}</strong><small>{KIND_LABELS[comparison.target.kind]}{comparison.target.kind === "retrieval" ? ` · ${modesLabel(comparison.target)}` : ""} · {SPLIT_LABELS[comparison.target.config.split ?? ""] ?? comparison.target.config.split ?? "—"}</small></div>
        </div>
        {comparison.settings_diff && comparison.settings_diff.length > 0 && <div className="ev-settings-diff">两次评测之间改过 {comparison.settings_diff.length} 项：{comparison.settings_diff.map((item) => `${item.key} ${String(item.base)} → ${String(item.target)}`).join("；")}。分数变化可能来自这些改动。</div>}
      <div className="diag-table-wrap"><table className="diag-table ev-table">
        <thead><tr><th>指标</th><th className="num">基准</th><th className="num">对比</th><th className="num">变化</th><th>结论</th></tr></thead>
        <tbody>{comparison.metrics.map((row) => <tr key={row.key}><td title={METRIC_HINTS[row.key]}>{row.label}<small className="diag-sub">{row.direction === "higher" ? "越高越好" : "越低越好"}</small></td><td className="num">{formatMetric(row.key, row.base)}</td><td className="num">{formatMetric(row.key, row.target)}</td><td className="num">{row.delta === null ? "—" : row.key.includes("_ms") ? formatDurationDelta(row.delta) : row.key.startsWith("mrr") ? `${row.delta > 0 ? "+" : ""}${row.delta.toFixed(3)}` : `${row.delta > 0 ? "+" : ""}${(row.delta * 100).toFixed(1)} 个百分点`}</td><td><ChangeTag row={row} metricKey={row.key} /></td></tr>)}</tbody>
      </table></div>
      </div>
    </div>}
  </div>;
}

// 评测集管理：浏览题目之外，提供手动录入和 AI 起草入口，生成题目默认标记为待审核。
function DatasetBrowser({ dataset, onToast, onSaved }: { dataset: EvalDataset | null; onToast: ShowToast; onSaved: () => Promise<void> }) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [splitFilter, setSplitFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [question, setQuestion] = useState("");
  const [paraphraseQuestion, setParaphraseQuestion] = useState("");
  const [questionType, setQuestionType] = useState("事实");
  const [answerable, setAnswerable] = useState(true);
  const [evidence, setEvidence] = useState("");
  const [referenceAnswer, setReferenceAnswer] = useState("");
  const [questionSplit, setQuestionSplit] = useState("dev");
  const [history, setHistory] = useState("");
  const [aiCount, setAiCount] = useState(1);
  const [aiType, setAiType] = useState("");
  const [aiSplit, setAiSplit] = useState("dev");
  const [saving, setSaving] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<"choose" | "manual" | "ai" | null>(null);
  if (!dataset) return <DatasetSkeleton />;
  const items = dataset.items;
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  const reviewedCount = dataset.reviewed_count ?? items.filter((item) => item.reviewed === true).length;
  const unreviewed = dataset.pending_count ?? items.length - reviewedCount;
  // 筛选按钮的数量只统计其他筛选条件下的交集，避免“已审核 15”但列表实际只有 2 条的错觉。
  function matchesFilterScope(item: EvalItem, ignored: "type" | "split" | "review" | "none") {
    if (ignored !== "type" && typeFilter !== "all" && item.type !== typeFilter) return false;
    if (ignored !== "split" && splitFilter !== "all" && item.split !== splitFilter) return false;
    if (ignored !== "review" && reviewFilter === "pending" && item.reviewed === true) return false;
    if (ignored !== "review" && reviewFilter === "reviewed" && item.reviewed !== true) return false;
    return true;
  }

  // 生成当前筛选上下文中的数量，保证每组筛选按钮和实际可见列表使用同一套交集口径。
  function countInScope(ignored: "type" | "split" | "review", predicate: (item: EvalItem) => boolean) {
    let count = 0;
    for (const item of items) {
      if (matchesFilterScope(item, ignored) && predicate(item)) count += 1;
    }
    return count;
  }

  const typeOptions: [string, string][] = [["all", `全部 ${countInScope("type", () => true)}`]];
  for (const type of dataset.types) typeOptions.push([type, `${type} ${countInScope("type", (item) => item.type === type)}`]);
  const splitOptions: [string, string][] = [
    ["all", `全部范围 ${countInScope("split", () => true)}`],
    ["dev", `开发集 ${countInScope("split", (item) => item.split === "dev")}`],
    ["holdout", `留出集 ${countInScope("split", (item) => item.split === "holdout")}`],
  ];
  const scopedReviewedCount = countInScope("review", (item) => item.reviewed === true);
  const scopedPendingCount = countInScope("review", (item) => item.reviewed !== true);
  const scopedTotal = scopedReviewedCount + scopedPendingCount;
  const visible = items.filter((item) => matchesFilterScope(item, "none"));

  // 把多行文本转换为非空数组，证据和追问历史都采用“一行一条”的编辑方式。
  function readLines(value: string) {
    const lines = [];
    for (const line of value.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
    return lines;
  }

  // 打开添加题目弹窗时只重置表单流程；操作结果由全局 Toast 短暂提示，避免页面留下旧反馈。
  function openAddDialog() {
    setAddMode("choose");
  }

  // 关闭弹窗只结束当前编辑流程；成功和失败结果统一由 Toast 展示。
  function closeAddDialog() {
    setAddMode(null);
  }

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (questionType === "同义改写") {
        await addEvalDatasetPair({
          original_question: question, paraphrase_question: paraphraseQuestion, answerable,
          evidence: answerable ? readLines(evidence) : [], reference_answer: referenceAnswer, split: questionSplit,
        });
      } else {
        await addEvalDatasetItem({
          question, type: questionType, answerable, evidence: answerable ? readLines(evidence) : [],
          reference_answer: referenceAnswer, split: questionSplit, history: readLines(history),
        });
      }
      await onSaved();
      setQuestion("");
      setParaphraseQuestion("");
      setEvidence("");
      setReferenceAnswer("");
      setHistory("");
      closeAddDialog();
      onToast("success", questionType === "同义改写" ? "同义改写题对已保存为两条独立题目。" : "题目已加入评测集。");
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function submitAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await generateEvalDatasetItems({ count: aiCount, split: aiSplit, type: aiType || null });
      await onSaved();
      closeAddDialog();
      onToast("success", `已生成 ${result.items.length} 题，已标记为待人工审核。`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 审核按钮只改变审核状态，不改动题目内容；成功后刷新列表，让题目立即进入可评测数量。
  async function reviewItem(itemId: string) {
    if (reviewingId) return;
    setReviewingId(itemId);
    try {
      await reviewEvalDatasetItem(itemId);
      await onSaved();
      onToast("success", `${itemId} 已审核通过，可用于评测。`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setReviewingId(null);
    }
  }

  return <div>
    <div className="ev-dataset-toolbar">
      {/* 只说明这个评测集是干什么的；题数、审核状态在下面的筛选里已经有了。 */}
      <p className="ev-muted-note">改了参数跑一遍，看分数变好还是变差。平时用开发集，定下来后再用留出集确认。</p>
      <button className="primary-button ev-add-question-button" type="button" onClick={openAddDialog}>添加题目</button>
    </div>
    {addMode && <div className="ev-add-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAddDialog(); }}>
      <div className="ev-add-modal" role="dialog" aria-modal="true" aria-labelledby="ev-add-dialog-title">
        <div className="ev-add-modal-header"><h3 id="ev-add-dialog-title">{addMode === "choose" ? "添加题目" : addMode === "manual" ? "手动添加题目" : "AI 添加题目"}</h3><button className="ev-modal-close" type="button" aria-label="关闭" onClick={closeAddDialog}>×</button></div>
        {addMode === "choose" ? <div className="ev-add-choices">
          <button className="ev-add-choice" type="button" onClick={() => setAddMode("manual")}><strong>手动添加</strong><span>填写问题、证据原文和标准答案</span></button>
          <button className="ev-add-choice" type="button" onClick={() => setAddMode("ai")}><strong>AI 添加</strong><span>根据当前语料起草题目，生成后需要人工审核</span></button>
        </div> : <>
          <button className="ev-modal-back" type="button" onClick={() => setAddMode("choose")}>← 选择添加方式</button>
          {addMode === "manual" ? <form className="ev-dataset-form ev-modal-form" onSubmit={(event) => void submitManual(event)}>
            <div className="ev-form-grid">
              <label className="ev-form-field">题型<select value={questionType} onChange={(event) => setQuestionType(event.target.value)}>{dataset.types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label className="ev-form-field">题目范围<select value={questionSplit} onChange={(event) => setQuestionSplit(event.target.value)}><option value="dev">开发集</option><option value="holdout">留出集</option></select></label>
            </div>
            {questionType === "同义改写" ? <>
              <p className="ev-form-note ev-paraphrase-form-note">保存为两道题，共用答案和证据。</p>
              <label className="ev-form-field ev-form-wide">问题 1（原问题）<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="填写原始问法" required /></label>
              <label className="ev-form-field ev-form-wide">问题 2（同义改写）<input value={paraphraseQuestion} onChange={(event) => setParaphraseQuestion(event.target.value)} placeholder="换一种说法询问同一事实" required /></label>
            </> : <label className="ev-form-field ev-form-wide">问题<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：耳机保修多久？" required /></label>}
            <label className="ev-form-check"><input type="checkbox" checked={answerable} onChange={(event) => setAnswerable(event.target.checked)} />可回答题</label>
            <label className="ev-form-field ev-form-wide">证据原文 <small>每行一条；无法回答题留空</small><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} disabled={!answerable} placeholder="从语料中逐字粘贴证据原文" rows={3} /></label>
            <label className="ev-form-field ev-form-wide">标准答案<textarea value={referenceAnswer} onChange={(event) => setReferenceAnswer(event.target.value)} placeholder="回答应包含的事实或拒答说明" rows={3} required /></label>
            <label className="ev-form-field ev-form-wide">多轮追问历史 <small>可选，每行一条</small><textarea value={history} onChange={(event) => setHistory(event.target.value)} disabled={questionType !== "多轮追问"} rows={2} /></label>
            <button className="primary-button ev-form-submit" type="submit" disabled={saving}>{saving ? "保存中…" : "加入评测集"}</button>
          </form> : <form className="ev-dataset-form ev-modal-form" onSubmit={(event) => void submitAi(event)}>
            <p className="ev-form-note">按语料起草题目、证据和答案，生成后要人工审核。</p>
            <div className="ev-form-grid">
              <label className="ev-form-field">生成数量<input type="number" min={1} max={10} value={aiCount} onChange={(event) => setAiCount(Number(event.target.value))} /></label>
              <label className="ev-form-field">题型<select value={aiType} onChange={(event) => setAiType(event.target.value)}><option value="">混合题型</option>{dataset.types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label className="ev-form-field">题目范围<select value={aiSplit} onChange={(event) => setAiSplit(event.target.value)}><option value="dev">开发集</option><option value="holdout">留出集</option></select></label>
            </div>
            <button className="primary-button ev-form-submit" type="submit" disabled={saving}>{saving ? "生成中…" : "AI 生成并加入"}</button>
          </form>}
        </>}
      </div>
    </div>}
    <div className="ev-filters" aria-label="评测集筛选">
      <div className="ev-filter-group">
        <legend className="ev-filter-label">题目类型</legend>
        <FilterChips value={typeFilter} options={typeOptions} onChange={setTypeFilter} />
      </div>
      <span className="ev-filter-divider" aria-hidden="true" />
      <div className="ev-filter-group">
        <legend className="ev-filter-label">范围</legend>
        <FilterChips value={splitFilter} options={splitOptions} onChange={setSplitFilter} />
      </div>
      <span className="ev-filter-divider" aria-hidden="true" />
      <div className="ev-filter-group">
        <legend className="ev-filter-label">审核类型</legend>
        <FilterChips value={reviewFilter} options={[["all", `全部 ${scopedTotal}`], ["pending", `待审核 ${scopedPendingCount}`], ["reviewed", `已审核 ${scopedReviewedCount}`]]} onChange={setReviewFilter} />
      </div>
    </div>
    <p className="ev-filter-help"><span className="ev-info-icon" role="img" aria-label="说明">i</span><span>{DATASET_TYPE_DESCRIPTIONS[typeFilter] ?? DATASET_TYPE_DESCRIPTIONS.all}</span></p>
    <div className="ev-dataset">{visible.map((item) => <article className="ev-item" key={item.id}>
      <div className="ev-item-head"><span className="ev-qid">{item.id}</span><span className="tag-row"><HueTag label={item.type} size="sm" />{item.pair_id && <Tag size="sm" tone="info" outline>{item.pair_id} · {item.pair_role === "original" ? "原问题" : "改写问题"}</Tag>}<Tag size="sm" outline plain>{item.answerable ? "可回答" : "无法回答"}</Tag><Tag size="sm" outline plain>{SPLIT_LABELS[item.split] ?? item.split}</Tag>{item.reviewed !== true ? <Tag size="sm" dot tone="warning">待人工审核</Tag> : <Tag size="sm" dot tone="success">已审核</Tag>}</span></div>
      <div className="ev-item-purpose"><span>评测目标</span><p>{DATASET_TYPE_CARD_DETAILS[item.type] ?? "检验系统能否从语料中找回与问题相关的证据。"}</p></div>
      {item.history && item.history.length > 0 && <div className="ev-item-context"><span>对话上下文 · 第 {item.history.length + 1} 轮</span><p>{item.history.join(" → ")}</p></div>}
      <h4>问题：{item.question}</h4>
      {item.evidence.length > 0 ? <div className="ev-item-evidence"><span>证据原文</span>{item.evidence.map((text, index) => <blockquote key={index}>{text}</blockquote>)}<EvidenceDetails texts={item.evidence} /></div> : <div className="ev-item-evidence"><span>证据原文</span><p className="ev-muted">无（只看系统是否正确拒答）</p></div>}
      <div className="ev-item-answer"><span>标准答案（给AI参考判断）</span><p>{item.reference_answer}</p></div>
      {/* 审核按钮放在题目底部的独立操作栏，和状态标签分离，避免用户误以为标签可以点击。 */}
      {item.reviewed !== true && <div className="ev-item-actions" aria-label="题目操作"><span className="ev-item-actions-label">操作</span><button className="ev-review-button" type="button" disabled={reviewingId === item.id} onClick={() => void reviewItem(item.id)}>{reviewingId === item.id ? "审核中…" : "审核通过"}</button></div>}
    </article>)}</div>
  </div>;
}

export default Evaluation;
