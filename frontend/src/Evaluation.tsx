import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { addEvalDatasetItem, addEvalDatasetPair, compareEvalRuns, deleteEvalRun, generateEvalDatasetItems, getEvalDataset, getEvalRun, listEvalRuns, reviewEvalDatasetItem, startEvalRun, type EvalComparison, type EvalComparisonRow, type EvalDataset, type EvalHistoryMetrics, type EvalItem, type EvalParaphraseAnalysis, type EvalQuestion, type EvalRun, type EvalRunBrief, type EvalSufficiency, type EvalSuite, type EvalSummary, type EvalLimitPoint, type EvalSweepPoint, type RetrievalDiagnosticsData } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import Regression from "./Regression";
// 耗时格式化移到公共文件，知识库、问答、设置页共用同一套规则。
import { durationTitle, formatDuration as formatMs, formatDurationDelta } from "./format";

export type EvaluationSection = "history" | "dataset" | "regression";
type TopTab = EvaluationSection;
type DetailTab = "overview" | "questions" | "sweep" | "variants";
type EvalKind = "retrieval" | "generation" | "memory";
const KIND_LABELS: Record<EvalKind, string> = { retrieval: "检索", generation: "生成", memory: "多轮对话" };

// 评测页面单独成一个文件：App.tsx 已有一千多行且还在频繁修改，评测页面有六个子视图，放在一起会让两边的改动互相冲突。
// 检索诊断面板由 App 以参数传入，直接复用问答页面同一个组件，避免两份实现各自演化。
type ShowToast = (kind: "success" | "error", message: string) => void;
type Props = {
  Diagnostics: ComponentType<{ data: RetrievalDiagnosticsData }>;
  section: EvaluationSection;
  // 回归集页签里打开的评测集，来自地址 /eval/regression/<编号>。
  setId?: string;
  onNavigate: (path: string) => void;
  onToast: ShowToast;
};

const TOP_TAB_LABELS: Record<TopTab, string> = {
  history: "历史评测记录",
  dataset: "评测集",
  regression: "回归集",
};
const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  overview: "总览",
  questions: "逐题明细",
  sweep: "阈值与段数",
  variants: "消融与参数",
};
const SPLIT_LABELS: Record<string, string> = { dev: "开发集", holdout: "留出集", all: "全部题目" };
const STATUS_LABELS: Record<string, string> = { running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断" };
// 运行状态改成胶囊标签：以前只有失败和运行中有颜色，已完成是普通文字，列表里不好区分。
const STATUS_TONES: Record<string, string> = { running: "blue", completed: "green", failed: "red", interrupted: "orange" };
// 丢失阶段的说明：告诉读者该去优化哪一环。
const LOST_LABELS: Record<string, { label: string; hint: string }> = {
  recall: { label: "未进候选池", hint: "证据所在分片没有进入 RRF 前 N 名，重排没机会看到它：检查检索词、分块或召回路数" },
  rerank: { label: "重排后掉出前列", hint: "证据进了候选池，但重排把它排到了返回数量之外：检查重排问题或模型" },
  threshold: { label: "被阈值误杀", hint: "证据排在前列，但重排概率低于相关性阈值被丢弃：阈值可能偏高" },
};
const EVIDENCE_STATUS: Record<string, string> = {
  returned: "已返回", beyond_limit: "超出返回数", filtered_low_score: "低于阈值", in_pool: "候选池", not_in_pool: "未进重排", not_recalled: "未召回",
};
// 操作栏直接解释每个实验开关，用户能在勾选前知道实验目的和会运行的变体。
const SUITE_DESCRIPTIONS: Record<string, string> = {
  ablation: "固定其他条件，逐个拿掉一种检索组件，回答“向量检索、关键词检索、重排分别贡献多少”。",
  params: "保持完整检索流程，只替换候选池大小或多查询融合方式，比较不同配置的效果。",
};
// 题型筛选说明跟随当前选项变化，帮助用户在题目卡片前理解这一组题检验的能力。
const DATASET_TYPE_DESCRIPTIONS: Record<string, string> = {
  all: "当前展示全部题型，用于查看评测集整体分布。",
  事实: "这类题直接询问语料中的明确事实，主要检验系统能否准确找回原文证据。",
  同义改写: "这类题用不同说法询问同一事实，主要检验检索是否能覆盖自然语言变化。",
  关键词: "这类题使用较短的关键词式问题，主要检验关键词检索和混合召回。",
  多轮追问: "这类题依赖上一轮问题继续追问，主要检验历史上下文和问题改写。",
  无法回答: "这类题在语料中没有答案，主要检验系统能否正确拒答而不是编造内容。",
  截断: "这类题的证据只在分片超长、被向量模型截掉的后半段里，主要检验截断会不会让向量检索找不到内容。可以和「仅向量」消融结果对照看。",
};
// 题目卡片补充每道题的评测目标，避免用户只能看到类型名称却不知道这道题具体在测什么。
const DATASET_TYPE_CARD_DETAILS: Record<string, string> = {
  事实: "直接核对语料中的明确事实，观察系统能否找回对应证据。",
  同义改写: "问题换了一种说法，但仍在询问证据中的同一事实，检验语义改写后的召回。",
  关键词: "问题依赖人名、专有名词、指标或概念等关键词，检验关键词是否帮助召回正确证据。",
  多轮追问: "当前问题依赖上一轮上下文，检验系统能否理解省略信息并继续检索。",
  无法回答: "语料中没有足够答案，预期行为是拒答且不返回误导性来源。",
  截断: "证据所在分片超过向量模型的长度上限，证据正好在没参与向量计算的那一段；向量找不到时只能靠关键词检索兜底。",
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
  const splitLabel = SPLIT_LABELS[run.config.split] ?? run.config.split;
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
  };
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
  };
}

// 每个指标的显示方式：比例用百分比，MRR 用小数，耗时用时分秒。
function formatMetric(key: string, value: number | null | undefined) {
  if (key.startsWith("mrr")) return formatScore(value);
  if (key.includes("_ms")) return formatMs(value);
  return formatPercent(value);
}

// 指标名里带上本次评测实际的 K 值（候选池大小、返回数量），读者不用再去翻配置。
function metricLabel(key: string, run: EvalRunBrief) {
  const pool = run.config.pool_size ?? 20;
  const top = run.config.return_limit ?? 6;
  const labels: Record<string, string> = {
    recall_pool: `召回 Recall@${pool}`, recall_top: `重排 Recall@${top}`, recall_final: "过滤后 Recall",
    mrr_pool: `召回 MRR@${pool}`, mrr_top: `重排 MRR@${top}`, mrr_final: "过滤后 MRR",
    false_reject_rate: "误杀率", false_accept_rate: "漏放率", latency_avg_ms: "平均耗时", latency_p95_ms: "P95 耗时",
    faithfulness: "忠实度", correctness: "正确性", refusal_accuracy: "拒答正确率", citation_validity: "引用有效性",
  };
  return labels[key] ?? key;
}

// 生成指标的卡片说明和表格提示统一使用确认后的文案，避免同一指标在不同位置出现两套解释。
const GENERATION_METRIC_EXPLANATIONS: Record<string, string> = {
  faithfulness: "评审大模型判断，回答中的内容都能在 chunk 中找到依据。",
  correctness: "评审大模型判断，回答与标准答案的关键要点基本一致。",
  refusal_accuracy: "系统判断所有题目的回答/拒答决定都正确。",
  citation_validity: "评审大模型判断，回答中的引用chunk都能支持对应内容。",
};

const METRIC_HINTS: Record<string, string> = {
  recall_pool: "证据是否进入交给重排的候选池（RRF 前 N 名）；多条证据按找到的比例计分",
  recall_top: "重排后前几名（不考虑阈值）里找到的证据比例",
  recall_final: "阈值过滤后真正交给回答模型的来源里找到的证据比例",
  mrr_pool: "第一个包含证据的分片名次的倒数，名次越靠前越接近 1",
  mrr_top: "重排后第一个包含证据的分片名次的倒数",
  mrr_final: "最终来源里第一个包含证据的来源序号的倒数",
  false_reject_rate: "能回答的题里，来源被阈值全部过滤、直接拒答的比例（越低越好）",
  false_accept_rate: "无法回答的题里，仍然留下来源、模型可能硬凑答案的比例（越低越好）",
  latency_avg_ms: "单题检索（召回 + 重排）平均耗时",
  ...GENERATION_METRIC_EXPLANATIONS,
};

// 根据当前评测的逐题结果生成卡片说明，展示真实 chunk 数量而不是固定示例。
function metricCardDetails(metricKey: string, run: EvalRun, value: number | null | undefined) {
  const generationExplanation = GENERATION_METRIC_EXPLANATIONS[metricKey];
  if (generationExplanation) return [generationExplanation];

  const stats = summarizeHistoryEvidence(run);
  if (stats) {
    if (metricKey === "recall_pool") {
      return [`${stats.answerableQuestions} 道可回答题预设有 ${stats.evidenceTotal} 个正确 chunk，候选池返回 ${stats.poolChunks} 个 chunk，包含 ${stats.poolHits} 个正确 chunk。`];
    }
    if (metricKey === "recall_top") {
      const returnLimit = run.config.return_limit ?? 6;
      return [`${stats.answerableQuestions} 道可回答题预设有 ${stats.evidenceTotal} 个正确 chunk，重排后取前 ${returnLimit} 条，共保留 ${stats.topChunks} 个 chunk，包含 ${stats.topHits} 个正确 chunk。`];
    }
    if (metricKey === "recall_final") {
      return [`${stats.answerableQuestions} 道可回答题预设有 ${stats.evidenceTotal} 个正确 chunk，阈值过滤后剩余 ${stats.finalAnswerableChunks} 个 chunk，包含 ${stats.finalHits} 个正确 chunk。`];
    }
    if (metricKey === "mrr_pool") {
      return [`${stats.answerableQuestions} 道可回答题中，候选池第一条正确 chunk 的排名倒数平均为 ${formatScore(value)}。`];
    }
    if (metricKey === "mrr_top") {
      return [`${stats.answerableQuestions} 道可回答题中，重排后第一条正确 chunk 的排名倒数平均为 ${formatScore(value)}。`];
    }
    if (metricKey === "mrr_final") {
      return [`${stats.answerableQuestions} 道可回答题中，阈值过滤后第一条正确 chunk 的排名倒数平均为 ${formatScore(value)}。`];
    }
    if (metricKey === "false_reject_rate") {
      return [`${stats.answerableQuestions} 道可回答题中，有 ${stats.falseRejectQuestions} 道被过滤掉全部来源而拒答。`];
    }
    if (metricKey === "false_accept_rate") {
      return [`${stats.unanswerableQuestions} 道无法回答题中，有 ${stats.falseAcceptQuestions} 道仍返回了 chunk，可能导致 AI 引用错误来源。`];
    }
  }

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
      return [`${judgedQuestions.length} 道题中，有 ${correctDecisions} 道的回答/拒答判断正确，准确率为 ${formatPercent(value)}。`];
    }
    if (["faithfulness", "correctness", "citation_validity"].includes(metricKey)) {
      return [`${judgedQuestions.length} 道题中，大模型评审的${metricLabel(metricKey, run)}平均得分为 ${formatPercent(value)}。`];
    }
  }
  if (["faithfulness", "correctness", "refusal_accuracy", "citation_validity"].includes(metricKey)) {
    return ["本次评测暂无逐题大模型评审数据。"];
  }
  return ["本次评测暂无逐题数据。"];
}

function Evaluation({ onToast, Diagnostics, section, setId, onNavigate }: Props) {
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
  const [launchKind, setLaunchKind] = useState<EvalKind>("retrieval");
  const [launchSplit, setLaunchSplit] = useState("dev");
  const [launchSuites, setLaunchSuites] = useState<string[]>([]);
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

  async function launch() {
    setLaunching(true);
    setError("");
    try {
      const suites = launchKind !== "retrieval" ? [] : launchSuites;
      const started = await startEvalRun(launchKind, launchSplit, suites);
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
  function changeLaunchKind(kind: EvalKind) {
    setLaunchKind(kind);
    if (kind !== "retrieval") setLaunchSuites([]);
  }

  function toggleSuite(key: string) {
    setLaunchSuites((items) => (items.includes(key) ? items.filter((item) => item !== key) : [...items, key]));
  }

  const runningRun = runs.find((item) => item.id === running) ?? null;
  const questionCount = run?.questions?.length ?? 0;
  // 评测集数量随 dataset.jsonl 变化，运行时计算后展示，避免操作栏的题数和实际可选范围不一致。
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

  return <section className="ev-root">
    <div className="ev-heading">
      <div><h2>评测</h2><p>用固定的评测集衡量检索和回答质量：每次改动后跑一遍，看指标是变好还是变差。</p></div>
    </div>
    <div className="document-detail-tabs ev-tabs ev-top-tabs" role="tablist">
      {(Object.keys(TOP_TAB_LABELS) as TopTab[]).map((key) => <button key={key} role="tab" aria-selected={section === key} className={section === key ? "active" : ""} onClick={() => onNavigate(key === "history" ? "/eval/runs" : key === "dataset" ? "/eval/dataset" : "/eval/regression")}>{TOP_TAB_LABELS[key]}{key !== "regression" && <span>{key === "history" ? runs.length : dataset?.reviewed_count ?? dataset?.items.filter((item) => item.reviewed === true).length ?? ""}</span>}</button>)}
    </div>
    {section === "history" && <>
      {/* 操作区只属于历史记录，评测集 Tab 保持为题目管理入口。 */}
      <div className="ev-launch">
        <div className="ev-launch-title">操作：发起{KIND_LABELS[launchKind]}评测<small>{launchKind === "memory" ? "按顺序问完多段对话，每组记忆参数各一遍，调用大模型次数较多" : launchKind === "generation" ? "调用回答和评审大模型，会产生少量费用" : "不调用大模型，约几十秒"}</small></div>
        <div className="ev-launch-options">
          <div className="ev-launch-option">
            <fieldset className="ev-radio-field">
              <legend>评测类型</legend>
              <div className="ev-radio-options" role="radiogroup" aria-label="评测类型">
                <label className={`ev-radio-option ${launchKind === "retrieval" ? "is-selected" : ""}`}><input type="radio" name="eval-kind" value="retrieval" checked={launchKind === "retrieval"} onChange={() => changeLaunchKind("retrieval")} />检索评测</label>
                <label className={`ev-radio-option ${launchKind === "generation" ? "is-selected" : ""}`}><input type="radio" name="eval-kind" value="generation" checked={launchKind === "generation"} onChange={() => changeLaunchKind("generation")} />生成评测</label>
                <label className={`ev-radio-option ${launchKind === "memory" ? "is-selected" : ""}`}><input type="radio" name="eval-kind" value="memory" checked={launchKind === "memory"} onChange={() => changeLaunchKind("memory")} />多轮对话评测</label>
              </div>
            </fieldset>
            <span className="ev-option-description"><span className="ev-description-label"><span className="ev-info-icon" aria-hidden="true">i</span>说明</span>：{launchKind === "memory" ? "用 eval/dialogues.jsonl 里的多段对话，按顺序真的问一遍，最后一问要用到开头的内容；对比当前的对话记忆参数和调大、调小后的结果，给设置页的「对话记忆」两项提供依据。" : launchKind === "generation" ? "调用回答模型生成答案，再调用评审模型检查忠实度、正确性、拒答和引用。" : "只验证召回、重排和阈值过滤，不调用大模型，适合修改检索参数后反复运行。"}</span>
          </div>
          {launchKind !== "memory" && <div className="ev-launch-option">
            <fieldset className="ev-radio-field">
              <legend>题目范围</legend>
              <div className="ev-radio-options" role="radiogroup" aria-label="题目范围">
                <label className={`ev-radio-option ${launchSplit === "dev" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="dev" checked={launchSplit === "dev"} onChange={() => setLaunchSplit("dev")} />开发集（日常调参）</label>
                <label className={`ev-radio-option ${launchSplit === "holdout" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="holdout" checked={launchSplit === "holdout"} onChange={() => setLaunchSplit("holdout")} />留出集（最终验证）</label>
                <label className={`ev-radio-option ${launchSplit === "all" ? "is-selected" : ""}`}><input type="radio" name="eval-split" value="all" checked={launchSplit === "all"} onChange={() => setLaunchSplit("all")} />全部题目</label>
              </div>
            </fieldset>
            <span className="ev-option-description"><span className="ev-description-label"><span className="ev-info-icon" aria-hidden="true">i</span>说明</span>：{launchSplit === "dev" ? `${splitCounts.dev || "—"} 题。每次修改检索参数后使用，可以反复试错；调参只看这一组，不动最终验证题。` : launchSplit === "holdout" ? `${splitCounts.holdout || "—"} 题。调参完成后再运行，只验证没有参与调参的题目，确认参数没有变差。` : `${splitCounts.dev + splitCounts.holdout || "—"} 题。合并已审核的开发集和留出集查看总体表现，不用于决定参数。`}</span>
          </div>}
          {/* 生成评测只跑基线，先在界面层禁用检索实验组选项，避免用户提交无效组合。 */}
          {suites.map((suite) => {
            const suiteDescription = launchKind !== "retrieval"
              ? "只有检索评测能运行这组实验。"
              : (SUITE_DESCRIPTIONS[suite.key] ?? "对比这一实验组和基线的指标差异。") + " 本次会各跑一次：" + suite.variants.join("、") + "。";
            const suiteClass = launchKind !== "retrieval" ? "ev-check is-disabled" : "ev-check";
            return <div className="ev-launch-option" key={suite.key}>
              <label className={suiteClass} title={launchKind !== "retrieval" ? "只有检索评测能运行这组实验" : suite.variants.join("、")}><input type="checkbox" disabled={launchKind !== "retrieval"} checked={launchSuites.includes(suite.key)} onChange={() => toggleSuite(suite.key)} />{suite.label}<small>{suite.variants.length} 组</small></label>
              <span className="ev-option-description"><span className="ev-description-label"><span className="ev-info-icon" aria-hidden="true">i</span>说明</span>：{suiteDescription}</span>
            </div>;
          })}
        </div>
        <div className="ev-launch-actions">
          <button className="primary-button" disabled={launching || Boolean(running)} onClick={() => void launch()}>{running ? "评测进行中…" : launching ? "正在启动…" : "开始评测"}</button>
        </div>
        {runningRun && <div className="ev-progress" aria-live="polite"><div className="ev-progress-track"><div className="ev-progress-fill" style={{ width: `${progressPercent(runningRun)}%` }} /></div><span>{runningRun.progress?.done ?? 0} / {runningRun.progress?.total || "…"} 次检索</span></div>}
        {runningRun && progressBreakdown(runningRun, suites) && <p className="ev-progress-note">{progressBreakdown(runningRun, suites)}</p>}
      </div>
    </>}
    {error && <div className="error-banner">{error}</div>}
    {section === "regression" ? <Regression setId={setId ?? null} onNavigate={onNavigate} onToast={onToast} /> : section === "dataset" ? datasetLoading ? <DatasetSkeleton /> : <DatasetBrowser dataset={dataset} onToast={onToast} onSaved={async () => { setDataset(await getEvalDataset()); }} /> : runsLoading ? <RunHistorySkeleton /> : selectedId ? <RunDetailView
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
  return <div className="ev-detail-view">
    <div className="ev-detail-toolbar"><button className="ev-back-button" onClick={onBack}>← 返回历次记录</button></div>
    {/* 详情页只展示当前评测配置；切换记录回到历史表格，避免下拉框和详情页职责重叠。 */}
    {run?.kind === "memory" ? <div className="ev-body">{run.status !== "completed" ? <RunStatus run={run} live={run.id === running} /> : <MemoryResults run={run} />}</div> : <>
    {run && <RunConfig run={run} />}
    <div className="document-detail-tabs ev-tabs ev-detail-tabs" role="tablist">
      {(Object.keys(DETAIL_TAB_LABELS) as DetailTab[]).map((key) => <button key={key} role="tab" aria-selected={detailTab === key} className={detailTab === key ? "active" : ""} onClick={() => setDetailTab(key)}>{DETAIL_TAB_LABELS[key]}{detailCounts[key] !== "" && <span>{detailCounts[key]}</span>}</button>)}
    </div>
    <div className="ev-body">
      {!run ? <RunDetailSkeleton /> :
        run.status !== "completed" ? <RunStatus run={run} live={run.id === running} /> :
          detailTab === "overview" ? <Overview run={run} comparison={comparison} /> :
            detailTab === "questions" ? <QuestionList run={run} Diagnostics={Diagnostics} /> :
              detailTab === "sweep" ? <SweepPanel run={run} /> :
                <VariantPanel run={run} />}
    </div>
    </>}
  </div>;
}

// 多轮对话评测结果：每组对话记忆参数一行，看最后一问答对了多少、有没有触发压缩、输入多长；展开看每段对话。
function MemoryResults({ run }: { run: EvalRun }) {
  const variants = run.memory ?? [];
  return <div className="ev-memory">
    <p className="ev-muted-note">每段对话按顺序问完，最后一问要用到开头几轮的内容。和线上一样，意图识别只看最近 3 轮问答和滚动摘要，开头的内容只能靠摘要带过来。正确性由评审大模型打分（1 = 要点一致，0.5 = 部分正确，0 = 错误）。共 {run.config.dataset_size ?? "—"} 段对话。</p>
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
    ["题目", `${SPLIT_LABELS[config.split] ?? config.split}${config.dataset_size ? ` · ${config.dataset_size} 题` : ""}`],
    ["候选池", String(config.pool_size ?? "—")], ["返回上限", String(config.return_limit ?? "—")], ["RRF k", String(config.rrf_k ?? "—")],
    ["相关性阈值", config.reranked === false ? "未启用（没有重排）" : formatScore(config.min_score ?? null, 2)],
    ["向量模型", `${config.embedding_mode ?? "—"} · ${config.embedding_model ?? "—"}`],
    ["重排模型", config.reranked ? config.rerank_model ?? "—" : config.reranked === false ? "未启用" : "—"],
    ["检索词", (config.query_source ?? []).map((item) => (item === "rewrite_cache" ? "改写缓存" : "规则改写")).join("、") || "—"],
  ];
  return <div className="diag-config ev-config">{items.map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}</div>;
}

function EmptyRuns({ hasRuns }: { hasRuns: boolean }) {
  return <div className="ev-empty"><h3>{hasRuns ? "请选择一次评测" : "还没有评测记录"}</h3><p>在上方操作栏选择“检索评测”或“生成评测”后点击“开始评测”即可运行；生成评测需要真实大模型并会产生少量费用。</p></div>;
}

function RunStatus({ run, live }: { run: EvalRun; live: boolean }) {
  if (run.status === "running" && live) return <div className="ev-empty"><h3>评测进行中</h3><p>已完成 {run.progress?.done ?? 0} / {run.progress?.total || "…"} 次检索，完成后自动显示结果。</p></div>;
  return <div className="ev-empty"><h3>{STATUS_LABELS[run.status] ?? run.status}</h3><p>{run.error ?? "这次评测没有正常结束（进程可能中途退出），请重新运行。"}</p></div>;
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
  return <div className="ev-overview">
    {/* 顶部总览只展示本次评测结果，移除重复的历史对比提示；历史对比仍用于耗时变化和历史页。 */}
    {comparison?.settings_diff && comparison.settings_diff.length > 0 && <div className="ev-settings-diff">和上一次评测相比，系统参数改过 {comparison.settings_diff.length} 项：{comparison.settings_diff.map((item) => `${item.key} ${String(item.base)} → ${String(item.target)}`).join("；")}。分数变化可能来自参数，而不是代码。</div>}
    <div className="ev-section-title">检索指标<small>{summary.answerable_count ?? 0} 道能回答 · {summary.unanswerable_count ?? 0} 道无法回答</small></div>
    <div className="ev-cards">{retrievalKeys.map((key) => <MetricCard key={key} metricKey={key} run={run} value={summary[key]} />)}</div>
    {hasGeneration && <><div className="ev-section-title">生成指标<small>大模型评审，温度 0；评审理由见逐题明细</small></div>
      <div className="ev-cards">{generationKeys.map((key) => <MetricCard key={key} metricKey={key} run={run} value={summary[key]} />)}</div></>}
    {hasGeneration && <SufficiencySummary run={run} />}
    {!hasGeneration && <p className="ev-muted-note">本次是检索评测，没有生成指标。生成评测（忠实度、正确性、拒答正确率、引用有效性）需要调用大模型，请在上方操作栏选择“生成评测”。</p>}
    <div className="ev-overview-grid">
      <div className="ev-panel"><div className="ev-section-title">chunk 命中对比<small>预设证据与各阶段实际返回 chunk</small></div><ChunkStageComparison run={run} /></div>
      <div className="ev-panel"><div className="ev-section-title">耗时<small>单题召回 + 重排</small></div>
        <div className="ev-latency"><div><span>平均</span><strong>{formatMs(summary.latency_avg_ms)}</strong><ChangeTag row={changes.latency_avg_ms} metricKey="latency_avg_ms" /></div><div><span>P95</span><strong>{formatMs(summary.latency_p95_ms)}</strong></div><div><span>重排最慢</span><strong>{formatMs(summary.rerank_max_ms)}</strong></div></div>
        <p className="ev-muted-note">重排调用本地交叉编码器，是最慢的一步；冷启动时可能接近超时，P95 比平均值更容易暴露这个问题。</p>
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
  if (!stats) return <div className="ev-sufficiency-panel"><div className="ev-section-title">资料充分性<small>本次生成评测没有保存充分性结果</small></div><p className="ev-muted-note">重新运行生成评测后，这里会显示资料充分、补充检索和最终 chunk 数。</p></div>;
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
    {stats.observed > stats.checked && <p className="ev-sufficiency-note">有 {stats.observed - stats.checked} 道题未完成判断，通常是未启用模型或充分性检查开关关闭。</p>}
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
    <p className="ev-chunk-comparison-note">“包含证据”表示该阶段返回的 chunk 中能找到预设证据；向量和关键词是各自去重后的召回结果，融合召回是进入重排前的全部候选。</p>
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
  if (!question.diagnostics) return <p className="ev-muted-note">本次评测没有保存 chunk 明细；重新运行评测后可以查看逐阶段对比。</p>;
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
  if (!question.answerable) return question.returned === 0 ? { key: "good", label: "正确拒绝" } : { key: "bad", label: "漏放" };
  const recall = question.stages.final.recall ?? 0;
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
            <div><span>耗时</span><strong>{formatMs(question.latency_ms)}</strong><small>返回 {question.returned} 条来源</small></div>
          </div>
          {!question.answerable && <div className={`ev-leak-panel ${question.returned > 0 ? "is-leak" : "is-safe"}`}>
            <div className="ev-section-title">漏放来源<small>{question.returned > 0 ? `这道题返回了 ${question.returned} 条来源，以下 chunk 被放行给回答模型` : "没有返回来源，系统正确拒答"}</small></div>
            {question.returned === 0 ? <p className="ev-leak-note">这道题没有来源被交给回答模型，因此不属于漏放。</p> : leakedChunks.length === 0 ? <p className="ev-leak-note">本次评测只记录了返回数量，没有保存 chunk 明细；请重新运行评测以查看具体内容。</p> : <div className="ev-leak-list">{leakedChunks.map(({ candidate, source }) => {
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
          <div className="ev-queries"><span>检索词</span>{question.queries.map((query) => <code key={query}>{query}</code>)}<span>重排问题</span><code>{question.rerank_query}</code><small>{question.query_source === "rewrite_cache" ? "来自改写缓存" : "规则改写（未调用大模型）"}</small></div>
          {question.sufficiency && <SufficiencyReview result={question.sufficiency} />}
          {question.answer !== undefined && <AnswerReview question={question} />}
          {question.diagnostics && <details className="ev-diagnostics"><summary>检索诊断：每张排名表、RRF 贡献、重排概率和最终去向</summary><Diagnostics data={question.diagnostics} /></details>}
        </div>}
      </article>;
    })}</div>
  </div>;
}

// 逐题展示充分性判断的原始结论，重点标明是否补检以及补检后实际交给回答模型的 chunk 数。
function SufficiencyReview({ result }: { result: EvalSufficiency }) {
  if (!result.checked) return <div className="ev-sufficiency-detail is-unchecked"><div className="ev-section-title">资料充分性<small>未调用判断模型</small></div><p>本题未执行资料充分性判断，沿用检索结果。</p></div>;
  const verdict = result.verdict;
  const missing = sufficiencyMissingText(result.missing);
  return <div className={`ev-sufficiency-detail is-${verdict ?? "unchecked"}`}>
    <div className="ev-section-title">资料充分性<small>生成评测保存的判断结果</small></div>
    <div className="ev-sufficiency-detail-grid">
      <div><span>判断结论</span><strong>{verdict ? SUFFICIENCY_LABELS[verdict] : "未判定"}</strong></div>
      <div><span>补充检索</span><strong>{result.retried ? "已触发" : "未触发"}</strong><small>{result.retry_query ? `检索词：${result.retry_query}` : "第一次检索后未追加检索"}</small></div>
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
  if (sweep.length === 0) return <div className="ev-empty"><h3>这次评测没有阈值扫描</h3><p>阈值只作用在重排概率上；本次没有启用重排（EMBEDDING_MODE 不是 local，或设置页关闭了重排），所以无法扫描。</p></div>;
  const current = run.config.min_score ?? null;
  let best: EvalSweepPoint | null = null;
  for (const point of sweep) {
    const cost = (point.false_reject_rate ?? 0) + (point.false_accept_rate ?? 0);
    if (!best || cost < (best.false_reject_rate ?? 0) + (best.false_accept_rate ?? 0)) best = point;
  }
  return <div>
    <p className="ev-muted-note">阈值越高，无关来源越容易被挡住（漏放率下降），但相关来源也更容易被误杀（误杀率上升）。这张图由本次评测记录的重排概率离线重算，不需要重新检索。{best && <> 误杀率 + 漏放率最小的阈值是 <strong>{best.threshold.toFixed(2)}</strong>（误杀 {formatPercent(best.false_reject_rate)}，漏放 {formatPercent(best.false_accept_rate)}）；题目较少时这只是参考，改阈值前请在留出集上验证。</>}</p>
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
    <p className="ev-muted-note">{enough && <>段数达到 <strong>{enough.return_limit}</strong> 时召回已经是最高的 {formatPercent(top)}，再多给也找不到更多证据，只会让输入更长。</>}现在设置的是 {current ?? "—"} 段。多证据题如果很少，或证据都在同一个分片里，这张表区分不出段数的好坏。</p>
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
  if (variants.length === 0) return <div className="ev-empty"><h3>这次评测没有包含实验组</h3><p>发起评测时勾选“消融实验”或“参数对比”，会在同一批题目上额外跑这些变体：仅向量、仅 BM25、混合不重排、候选池 12 / 30、多查询取最好名次。</p></div>;
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
    <p className="ev-muted-note">基线是当前线上配置（混合召回 + 重排 + 阈值）。差值以基线为准：召回率越高越好，误杀率、漏放率和耗时越低越好。注意“仅向量”“仅 BM25”“混合（不重排）”没有重排，也就没有阈值过滤，漏放率会明显升高。</p>
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
  return <div className="ev-history-metric-item"><strong>{label}</strong><strong>{value}</strong><small>{hint}</small></div>;
}

// 历次评测记录：选中两次查看逐项对比。
function RunHistory({ runs, onOpen, onDelete }: { runs: EvalRunBrief[]; onOpen: (id: string) => void; onDelete: (id: string) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 指标子项不能跨表格行使用 details；显式记录收起项，保证子项能作为完整下一行渲染且新记录默认展开。
  const [collapsedMetricRuns, setCollapsedMetricRuns] = useState<string[]>([]);
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (picked.length !== 2) {
      setComparison(null);
      return;
    }
    // 较早的一次作为基准，变化方向始终表示"从旧到新"。
    const [first, second] = [...picked].sort();
    compareEvalRuns(first, second).then(setComparison).catch((reason: Error) => setError(reason.message));
  }, [picked]);
  function toggle(id: string) {
    setPicked((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items.slice(-1), id]));
  }
  // 只记录用户主动收起的记录，评测完成后新出现的记录自然保持展开。
  function toggleMetrics(id: string) {
    setCollapsedMetricRuns((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
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
  return <div>
    {error && <div className="error-banner">{error}</div>}
    <div className="diag-table-wrap ev-history-table-wrap"><table className="diag-table ev-table ev-history-table">
      {/* 历史记录只保留运行结果相关字段；提交号属于构建元数据，移除后给题数、配置和状态留出空间。 */}
      <thead><tr><th>对比</th><th>时间</th><th>类型</th><th>范围</th><th>题数</th><th>配置</th><th>平均耗时</th><th>状态</th><th /></tr></thead>
      <tbody>{runs.map((item) => {
        const metricsExpanded = !collapsedMetricRuns.includes(item.id);
        // 指标说明所需统计已随历史列表返回，展开行只做本地渲染，不再触发逐条详情请求。
        const stats = historyEvidenceStats(item.history_metrics);
        const evidenceTotal = stats?.evidenceTotal ?? 0;
        const poolHint = stats
          ? `找到 ${stats.poolHits} 条证据；${stats.answerableQuestions} 道可回答题共标注 ${evidenceTotal} 条正确证据，${stats.poolHits === evidenceTotal ? "全部进入候选池" : `有 ${stats.poolHits} 条进入候选池`}。`
          : "暂缺本次评测的证据统计";
        const returnLimit = item.config.return_limit ?? 6;
        const topHint = stats
          ? `每道题的候选 chunk 重排后取前 ${returnLimit} 条，共 ${stats.topTotal} 条；仍找到 ${stats.topHits} 条正确证据。`
          : "暂缺本次评测的证据统计";
        // 最终 Recall 同时展示过滤后的 chunk 总数和命中的正确证据数，避免只看到百分比而不知道它对应的真实数量。
        const finalHint = stats
          ? `阈值过滤后剩余 ${stats.finalRemaining} 个 chunk，仍找到设置的 ${stats.finalHits} 条正确证据。`
          : "暂缺本次评测的证据统计";
        const mrrHint = stats
          ? <>{stats.answerableQuestions} 道可回答题中，第一条正确证据排名倒数的平均值为 {formatScore(item.summary?.mrr_pool)}。<br />看正确证据排得靠不靠前。越接近 1，说明证据越靠前。</>
          : "暂缺本次评测的排名统计";
        const falseRejectHint = stats
          ? `${stats.answerableQuestions} 道可回答题中，有 ${stats.falseRejectQuestions} 道被拒答，过滤了所有资料。`
          : "暂缺本次评测的题目统计";
        // 漏放率说明改为强调实际返回的 chunk 及其错误引用风险，避免把指标误解成 AI 已经完成回答。
        const falseAcceptHint = stats
          ? `${stats.unanswerableQuestions} 道无法回答题中，有 ${stats.falseAcceptQuestions} 道仍返回了 chunk，可能导致 AI 引用错误来源。`
          : "暂缺本次评测的题目统计";
        return <Fragment key={item.id}>
          <tr className={`ev-history-main-row ${picked.includes(item.id) ? "is-current" : ""}`} tabIndex={0} aria-expanded={metricsExpanded} aria-controls={`history-metrics-${item.id}`} title="点击展开或收起指标" onClick={() => toggleMetrics(item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleMetrics(item.id); } }}>
            <td><input type="checkbox" aria-label={`选择 ${item.id}`} checked={picked.includes(item.id)} disabled={item.status !== "completed"} onClick={(event) => event.stopPropagation()} onChange={() => toggle(item.id)} /></td>
            <td className="ev-history-time">{formatTime(item.created)}</td><td><span className="ev-history-kind">{KIND_LABELS[item.kind]}</span></td><td>{SPLIT_LABELS[item.config.split] ?? item.config.split}</td><td className="num ev-history-number">{item.config.dataset_size ?? "—"}</td>
            <td className="ev-config-cell">候选池 {item.config.pool_size ?? "—"} · 阈值 {item.config.reranked === false ? "未启用" : formatScore(item.config.min_score ?? null, 2)}{item.config.suites.length ? ` · 含${item.config.suites.map((suite) => (suite === "ablation" ? "消融" : "参数")).join("、")}` : ""}<span className="ev-history-expand-hint">{metricsExpanded ? "▼ 指标" : "▶ 指标"}</span></td>
            <td className="num ev-history-latency" title={durationTitle(item.summary?.latency_avg_ms)}>{formatMs(item.summary?.latency_avg_ms)}</td>
            <td><span className={`status-tag is-${STATUS_TONES[item.status] ?? "gray"}`}>{STATUS_LABELS[item.status] ?? item.status}{item.status === "running" ? ` ${progressPercent(item)}%` : ""}</span></td>
            <td><div className="ev-history-actions"><button className="ev-link" onClick={(event) => { event.stopPropagation(); onOpen(item.id); }}>查看</button><button className="ev-delete-link" disabled={item.status === "running" || deletingId === item.id} title={item.status === "running" ? "评测运行中，不能删除" : "删除这条评测记录"} onClick={(event) => { event.stopPropagation(); void remove(item); }}>{deletingId === item.id ? "删除中…" : "删除"}</button></div></td>
          </tr>
          {metricsExpanded && <tr id={`history-metrics-${item.id}`} className="ev-history-metrics-row">
            <td colSpan={9}><div className="ev-history-metrics-panel"><div className="ev-history-metrics-heading">本条记录指标</div><div className="ev-history-metrics-grid">
              <HistoryMetric label="候选池 Recall" value={formatPercent(item.summary?.recall_pool)} hint={poolHint} />
              {/* 补齐召回、重排、阈值过滤三个阶段，避免只看首尾指标而定位不到重排损失。 */}
              <HistoryMetric label="重排 Recall" value={formatPercent(item.summary?.recall_top)} hint={topHint} />
              <HistoryMetric label="最终 Recall" value={formatPercent(item.summary?.recall_final)} hint={finalHint} />
              <HistoryMetric label="候选池 MRR" value={formatMetric("mrr_pool", item.summary?.mrr_pool)} hint={mrrHint} />
              <HistoryMetric label="误杀率" value={formatPercent(item.summary?.false_reject_rate)} hint={falseRejectHint} />
              <HistoryMetric label="漏放率" value={formatPercent(item.summary?.false_accept_rate)} hint={falseAcceptHint} />
            </div></div></td>
          </tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
    <p className="ev-history-help">指标说明：候选池 Recall 表示证据是否进入重排候选池；最终 Recall 表示阈值过滤后是否仍保留证据；候选池 MRR 越接近 1 代表证据越靠前；误杀率是有答案却被过滤的比例；漏放率是无答案却保留来源的比例。</p>
    {comparison && <div className="ev-panel ev-compare">
      <div className="ev-section-title">对比结果<small><code>{comparison.base.id}</code> → <code>{comparison.target.id}</code></small></div>
      <div className="diag-table-wrap"><table className="diag-table ev-table">
        <thead><tr><th>指标</th><th className="num">基准</th><th className="num">对比</th><th className="num">变化</th><th>结论</th></tr></thead>
        <tbody>{comparison.metrics.map((row) => <tr key={row.key}><td title={METRIC_HINTS[row.key]}>{row.label}<small className="diag-sub">{row.direction === "higher" ? "越高越好" : "越低越好"}</small></td><td className="num">{formatMetric(row.key, row.base)}</td><td className="num">{formatMetric(row.key, row.target)}</td><td className="num">{row.delta === null ? "—" : row.key.includes("_ms") ? formatDurationDelta(row.delta) : row.key.startsWith("mrr") ? `${row.delta > 0 ? "+" : ""}${row.delta.toFixed(3)}` : `${row.delta > 0 ? "+" : ""}${(row.delta * 100).toFixed(1)} 个百分点`}</td><td><ChangeTag row={row} metricKey={row.key} /></td></tr>)}</tbody>
      </table></div>
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
      <p className="ev-muted-note">语料：{dataset.corpus.join("、")}。共 {dataset.items.length} 题，可用于评测 {reviewedCount} 题，待人工审核 {unreviewed} 题；待审核题只在这里管理，不参与评测。无法回答 {counts["无法回答"] ?? 0} 题；标注的是“证据原文”而不是分片 ID，检索结果中只要有分片包含证据原文就算命中，分块参数变化后标注依然有效。</p>
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
              <p className="ev-form-note ev-paraphrase-form-note">保存后会生成两条独立题目；两题共享下面的标准答案和证据，并自动关联同一个题对编号。</p>
              <label className="ev-form-field ev-form-wide">问题 1（原问题）<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="填写原始问法" required /></label>
              <label className="ev-form-field ev-form-wide">问题 2（同义改写）<input value={paraphraseQuestion} onChange={(event) => setParaphraseQuestion(event.target.value)} placeholder="换一种说法询问同一事实" required /></label>
            </> : <label className="ev-form-field ev-form-wide">问题<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：耳机保修多久？" required /></label>}
            <label className="ev-form-check"><input type="checkbox" checked={answerable} onChange={(event) => setAnswerable(event.target.checked)} />可回答题</label>
            <label className="ev-form-field ev-form-wide">证据原文 <small>每行一条；无法回答题留空</small><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} disabled={!answerable} placeholder="从语料中逐字粘贴证据原文" rows={3} /></label>
            <label className="ev-form-field ev-form-wide">标准答案<textarea value={referenceAnswer} onChange={(event) => setReferenceAnswer(event.target.value)} placeholder="回答应包含的事实或拒答说明" rows={3} required /></label>
            <label className="ev-form-field ev-form-wide">多轮追问历史 <small>可选，每行一条</small><textarea value={history} onChange={(event) => setHistory(event.target.value)} disabled={questionType !== "多轮追问"} rows={2} /></label>
            <button className="primary-button ev-form-submit" type="submit" disabled={saving}>{saving ? "保存中…" : "加入评测集"}</button>
          </form> : <form className="ev-dataset-form ev-modal-form" onSubmit={(event) => void submitAi(event)}>
            <p className="ev-form-note">基于当前语料起草题目、证据和标准答案；会产生少量大模型费用，生成后必须人工审核。</p>
            <div className="ev-form-grid">
              <label className="ev-form-field">生成数量<input type="number" min={1} max={10} value={aiCount} onChange={(event) => setAiCount(Number(event.target.value))} /></label>
              <label className="ev-form-field">题型<select value={aiType} onChange={(event) => setAiType(event.target.value)}><option value="">混合题型</option>{(dataset.generated_types ?? dataset.types).map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
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
      <div className="ev-item-head"><span className="ev-qid">{item.id}</span><span className="ev-tag">{item.type}</span>{item.pair_id && <span className="ev-tag is-pair">{item.pair_id} · {item.pair_role === "original" ? "原问题" : "改写问题"}</span>}<span className={`ev-tag ${item.answerable ? "" : "is-muted"}`}>{item.answerable ? "可回答" : "无法回答"}</span><span className="ev-tag is-muted">{SPLIT_LABELS[item.split] ?? item.split}</span>{item.reviewed !== true ? <span className="ev-tag is-warn">待人工审核</span> : <span className="ev-tag is-approved">已审核</span>}</div>
      <div className="ev-item-purpose"><span>评测目标</span><p>{DATASET_TYPE_CARD_DETAILS[item.type] ?? "检验系统能否从语料中找回与问题相关的证据。"}</p></div>
      {item.history && item.history.length > 0 && <div className="ev-item-context"><span>对话上下文 · 第 {item.history.length + 1} 轮</span><p>{item.history.join(" → ")}</p></div>}
      <h4>问题：{item.question}</h4>
      {item.evidence.length > 0 ? <div className="ev-item-evidence"><span>证据原文</span>{item.evidence.map((text, index) => <blockquote key={index}>{text}</blockquote>)}</div> : <div className="ev-item-evidence"><span>证据原文</span><p className="ev-muted">无（只看系统是否正确拒答）</p></div>}
      <div className="ev-item-answer"><span>标准答案（给AI参考判断）</span><p>{item.reference_answer}</p></div>
      {/* 审核按钮放在题目底部的独立操作栏，和状态标签分离，避免用户误以为标签可以点击。 */}
      {item.reviewed !== true && <div className="ev-item-actions" aria-label="题目操作"><span className="ev-item-actions-label">操作</span><button className="ev-review-button" type="button" disabled={reviewingId === item.id} onClick={() => void reviewItem(item.id)}>{reviewingId === item.id ? "审核中…" : "审核通过"}</button></div>}
    </article>)}</div>
  </div>;
}

export default Evaluation;
