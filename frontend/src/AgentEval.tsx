import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ChunkOriginalDialog, type ChunkOriginal } from "./ChunkOriginalDialog";
import { DetailDialog } from "./DetailDialog";
import {
  type EvalAgentCall,
  type EvalCompareKey,
  type EvalConfig,
  type EvalMaterial,
  type EvalMode,
  type EvalRetry,
  type EvalQuestion,
  type EvalRun,
  type EvalRunBrief,
  type EvalSpecialQuestion,
  type EvalSpecialSection,
  type EvalSummary,
} from "./api";
import { EvidenceFilterSummary } from "./EvidenceFilterSummary";
import { ScoringItems } from "./ScoringItems";
import {
  newEvidenceHits,
  evidenceFilterReason,
  filteredRankingText,
} from "./newEvidenceHits";
import "./AgentEvidence.css";
import { JsonView } from "./AgentTrace";
import { formatDuration as formatMs } from "./format";
import {
  SourceTag,
  Tag,
  TypeStats,
  TypeTag,
  typeHues,
  type TypeStat,
} from "./Tag";
import type { Tone } from "./tags";
import { PRESET_HUES } from "./hues";
import {
  SCORE_RULE,
  bandsText,
  formatPoints,
  questionScore,
  summarizeScores,
} from "./score";

// Agent 检索评测的结果页（后端 app/evaluation/agent_retrieval.py）。
// Agent 每道题用新会话跑一遍，只看它最后拿到的资料里有没有计分项（最后命中），口径和固定流程的「交给模型的资料命中率」一致
// （两边都算父块扩展拼进来的相邻分片，Agent 另外加上读前后文读到的）；
// 答案照样生成，但这一步不评分。和固定流程一起跑时，逐题对比两边是否命中，点开看两边的检索日志。

export function runModes(run: EvalRunBrief): EvalMode[] {
  return run.config.modes && run.config.modes.length
    ? run.config.modes
    : ["fixed"];
}

export function modesLabel(run: EvalRunBrief) {
  const modes = runModes(run);
  if (modes.length === 2) return "固定流程 + Agent";
  return modes[0] === "agent" ? "Agent" : "固定流程";
}

const COMPARE_LABELS: Record<EvalCompareKey, string> = {
  agent_only: "只有 Agent 命中",
  fixed_only: "只有固定流程命中",
  neither: "都没命中",
  both: "都命中",
};
const COMPARE_HINTS: Record<EvalCompareKey, string> = {
  agent_only: "Agent 找到，固定流程没有",
  fixed_only: "固定流程找到，Agent 没有：重点看",
  neither: "两边都没拿全",
  both: "两边都拿全了",
};
const STOP_LABELS: Record<string, string> = {
  answered: "正常回答",
  budget: "工具预算用完，强制回答",
  timeout: "超时，强制回答",
  demo: "演示模式",
};
const TOOL_LABELS: Record<string, string> = {
  search_knowledge: "检索知识库",
  read_context: "读前后文",
  lookup_order: "查订单",
  query_data: "查业务数据",
};
const SEARCH_MODE_LABELS: Record<string, string> = {
  hybrid: "混合检索",
  vector: "向量检索",
  keyword: "关键词检索",
};
const CALL_STATUS: Record<string, string> = {
  ok: "",
  error: "出错",
  duplicate: "和之前的调用相同，没有执行",
  skipped: "预算用完，没有执行",
};

function percent(value: number | null | undefined) {
  return value === null || value === undefined
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}

function number(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined
    ? "—"
    : String(Math.round(value * 10 ** digits) / 10 ** digits);
}

// 一道题 Agent 的结果：能回答的题看计分项拿到多少；无法回答的题看有没有拿到资料（拿到了就可能硬凑答案）。
function agentVerdict(question: EvalQuestion) {
  const agent = question.agent;
  if (!agent) return { key: "none", label: "—" };
  if (agent.status !== "completed") return { key: "bad", label: "运行失败" };
  if (!question.answerable)
    return agent.returned === 0
      ? { key: "good", label: "没拿到资料 · 100 分" }
      : { key: "warn", label: `拿到 ${agent.returned} 段 · -20 分` };
  // 写出拿到几个计分项：「命中 3 / 3」「部分 1 / 3」「未命中 0 / 3」。
  const total = agent.evidence.length || question.evidence_count;
  const found = agent.evidence.length
    ? agent.evidence.filter((item) => item.found).length
    : Math.round((agent.recall ?? 0) * total);
  return countVerdict(found, total);
}

// 后面带上这题的得分（规则见 score.ts）。
function countVerdict(found: number, total: number) {
  const score = questionScore(true, found, total);
  const count = `${found} / ${total}${score === null ? "" : ` · ${score} 分`}`;
  if (total > 0 && found >= total)
    return { key: "good", label: `命中 ${count}` };
  if (found > 0) return { key: "warn", label: `部分 ${count}` };
  return { key: "bad", label: `未命中 ${count}` };
}

// 一道题的检索词是谁给的。
export function rewriteLabel(question: {
  rewrite?: EvalQuestion["rewrite"];
  query_source?: string;
}) {
  const classifier = question.rewrite?.classifier ?? question.query_source;
  if (classifier === "llm")
    return question.rewrite?.cached
      ? "大模型改写（来自改写缓存）"
      : "大模型改写";
  if (classifier === "small_model")
    return "本地小模型只分类不改写，用原问题检索";
  if (classifier === "rewrite_cache") return "来自改写缓存";
  // 没用上大模型：写出原因（大模型调用失败、输出格式不对、命中规则……），这时只用原问题检索一路。
  const reason = question.rewrite?.fallback_reason;
  return reason
    ? `没用上大模型改写：${reason}，只用原问题检索`
    : "没用上大模型改写，只用原问题检索（这次评测没记原因）";
}

function fixedVerdict(question: EvalQuestion) {
  if (!question.stages) return { key: "none", label: "—" };
  if (!question.answerable)
    return question.returned === 0 || question.cleared
      ? {
          key: "good",
          label: `${question.cleared ? "被清空，没拿到资料" : "没拿到资料"} · 100 分`,
        }
      : {
          key: "warn",
          label: `拿到 ${question.sufficiency?.source_count ?? question.returned} 段 · -20 分`,
        };
  // 被充分性判断清空：模型什么资料都拿不到。
  if (question.cleared)
    return {
      key: "bad",
      label: `被清空 0 / ${question.evidence_count} · ${questionScore(true, 0, question.evidence_count)} 分`,
    };
  // 和 Agent 比较时按「最终交给模型的资料」（含父块扩展、补充检索）算；旧记录没有，用过滤后 Recall。
  const recall = question.given_recall ?? question.stages.final.recall ?? 0;
  const total = question.evidence_count;
  return countVerdict(question.given_hits ?? Math.round(recall * total), total);
}

function Verdict({ verdict }: { verdict: { key: string; label: string } }) {
  if (verdict.key === "none") return <span className="ag-muted">—</span>;
  return (
    <span className={`ev-verdict is-${verdict.key}`}>
      <b>{verdict.key === "good" ? "✓" : verdict.key === "warn" ? "◐" : "✕"}</b>
      {verdict.label}
    </span>
  );
}

function Card({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="ev-card">
      <span className="ev-card-label">{label}</span>
      <strong className="ev-card-value">{value}</strong>
      {note && (
        <div className="ev-card-explanation">
          <span>{note}</span>
        </div>
      )}
    </div>
  );
}

// 两种模式的大卡片：左边固定流程、右边 Agent，每张卡片放这个模式的全部指标，同一行左右对齐好比较。
// 分三块：结果（通过、计分项命中、扩展命中）、过程（检索次数、耗时……）、配置。数字都从逐题结果现算，调参评测和专项共用。
type ModeCell = { value: string; note?: string; best?: boolean };
type ModeRow = {
  group: "result" | "process" | "config";
  label: string;
  fixed?: ModeCell;
  agent?: ModeCell;
};

function avg(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function ratio(part: number, total: number) {
  return total
    ? `${part} / ${total} · ${Math.round((part / total) * 100)}%`
    : "—";
}

// 交给模型的资料：后端记的段数、字数、token；旧记录按保存下来的来源正文现算（token 用和后端同一种估算）。
const WIDE_CHARS =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
function textTokens(text: string) {
  const wide = (text.match(WIDE_CHARS) ?? []).length;
  return wide + Math.ceil((text.length - wide) / 4);
}

function fixedMaterial(question: EvalQuestion): EvalMaterial | null {
  if (question.material) return question.material;
  if (!question.stages) return null;
  if (question.cleared) return { count: 0, chars: 0, tokens: 0 };
  const sources =
    question.retry?.used && question.retry.sources
      ? question.retry.sources
      : question.sources;
  if (!sources) return null;
  return {
    count: sources.length,
    chars: sources.reduce((sum, source) => sum + (source.text ?? "").length, 0),
    tokens: sources.reduce(
      (sum, source) => sum + textTokens(source.text ?? ""),
      0,
    ),
  };
}

function agentMaterial(question: EvalQuestion): EvalMaterial | null {
  return question.agent?.material ?? null;
}

function MaterialLine({ material }: { material: EvalMaterial | null }) {
  if (!material) return null;
  return (
    <div className="ag-material">
      <span className="ag-tool">交给模型的资料</span>
      <span>
        <b>{material.count}</b> 段 · {material.chars.toLocaleString()} 字 · 约{" "}
        {material.tokens.toLocaleString()} token
      </span>
    </div>
  );
}

// 计分项命中情况：每个计分项一个结果标签（检索命中 / 父块扩展命中 / 读前后文拿到 / 被过滤 / 没召回 / 没拿到），后面写细节。
type EvidenceStatusEntry = {
  label: string;
  tone: "success" | "danger" | "neutral" | "info";
  dashed?: boolean;
  hue?: number;
  detail: string;
  count?: number;
};
type EvidenceStatusRow = EvidenceStatusEntry & {
  matches?: EvidenceStatusEntry[];
  hitCount?: number;
};

// 卡片显示简洁摘要，完整计分项命中记录通过标题旁的详情按钮查看。
function EvidenceStatus({
  question,
  rows,
  expanded,
  onToggle,
  children,
  agent = false,
}: {
  question: EvalQuestion;
  rows: EvidenceStatusRow[];
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  agent?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const itemName = (index: number) => {
    const label =
      question.agent?.evidence[index]?.label ||
      question.evidence?.[index]?.label;
    return `计分项 ${index + 1}${label ? `：${label}` : ""}`;
  };
  return (
    <div className="ag-evidence-status">
      <div className="ag-evidence-status-head">
        <span className="ag-tool">计分项命中情况</span>
        <button
          type="button"
          className="secondary-button ag-evidence-details-button"
          aria-haspopup="dialog"
          onClick={() => setDetailOpen(true)}
        >
          详情
        </button>
      </div>
      {rows.length > 0 ? (
        <ul>
          {rows.map((row, index) => (
            <li key={index}>
              <span
                className={`ag-evidence-name ${row.tone === "danger" || row.tone === "neutral" ? "is-missed" : ""}`}
              >
                {itemName(index)}
              </span>
              <Tag
                tone={row.tone}
                hue={row.hue}
                size="sm"
                outline={row.dashed}
                className={row.dashed ? "is-dashed" : undefined}
              >
                {row.label}
              </Tag>
              {(row.tone === "danger" || row.tone === "neutral") &&
                row.detail && <small>{row.detail}</small>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ag-muted">没有答案的题，不看计分项。</p>
      )}
      {children}
      <button
        type="button"
        className="secondary-button ag-detail-button"
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        检索详情
      </button>
      <DetailDialog
        open={detailOpen}
        title={`${agent ? "Agent" : "固定流程"} · 计分项命中详情`}
        onClose={() => setDetailOpen(false)}
        className="ag-evidence-hit-dialog"
      >
        {rows.length === 0 && (
          <p className="ag-muted">没有答案的题，不看计分项。</p>
        )}
        {rows.map((row, index) => (
          <section key={index}>
            <div className="ag-evidence-hit-heading">
              <h4
                className={
                  row.tone === "danger" || row.tone === "neutral"
                    ? "ag-evidence-missed"
                    : undefined
                }
              >
                {itemName(index)}
              </h4>
              {row.hitCount !== undefined && (
                <small className="ag-muted">累计命中 {row.hitCount} 次</small>
              )}
            </div>
            <ul className="ag-evidence-hit-list">
              {(row.matches ?? [row]).map((match) => (
                <li key={match.label}>
                  <Tag
                    tone={match.tone}
                    hue={match.hue}
                    size="sm"
                    outline={match.dashed}
                    className={match.dashed ? "is-dashed" : undefined}
                  >
                    {match.label}
                    {match.count !== undefined ? ` · ${match.count} 次` : ""}
                  </Tag>
                  {match.detail && <small>{match.detail}</small>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </DetailDialog>
    </div>
  );
}

// 计分项命中情况（两边各一列）：从逐题结果算出每个计分项的结果标签和细节。
// 固定流程按最后交给模型的资料算（补充检索、被清空都考虑），没拿到的写丢在哪一步；Agent 重点写第几轮拿到的。
function rerankText(value: number | null | undefined, extended = false) {
  return !extended && typeof value === "number" && Number.isFinite(value)
    ? `重排分 ${value.toFixed(2)}`
    : "";
}

function chunkItemsOf(
  sources: EvalQuestion["sources"] | EvalRetry["sources"] | undefined,
) {
  return (sources ?? []).map((source) => {
    const extra = source as {
      id: string;
      chunk_id?: string | null;
      position?: number | null;
      parent_chunk_ids?: string[];
    };
    return {
      id: extra.id,
      chunkId: extra.chunk_id ?? null,
      position: extra.position ?? null,
      relevance: source.relevance,
      parts: extra.parent_chunk_ids ?? (extra.chunk_id ? [extra.chunk_id] : []),
    };
  });
}

function evidenceChunkLists(question: EvalQuestion) {
  return (question.agent?.evidence ?? []).length
    ? (question.agent?.evidence ?? []).map((item) => item.chunk_ids ?? [])
    : (question.evidence ?? []).map((item, index) => [
        ...new Set(
          [item.chunk_id, question.retry?.evidence?.[index]?.chunk_id].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ]);
}

function fixedEvidenceRows(
  question: EvalQuestion,
  config: EvalRun["config"],
): EvidenceStatusRow[] {
  const evidenceLists = evidenceChunkLists(question);
  const total = question.answerable ? evidenceLists.length : 0;
  const items = chunkItemsOf(question.sources);
  const retry = question.retry;
  const retryItems = chunkItemsOf(retry?.sources);
  const usedRetry = Boolean(question.sufficiency?.retry_used);
  return Array.from({ length: total }, (_, evidence): EvidenceStatusRow => {
    const fixed = usedRetry
      ? retry?.evidence?.[evidence]
      : question.evidence?.[evidence];
    if (question.cleared)
      return {
        label: "被过滤",
        tone: "danger",
        detail: "（被充分性判断清空，线上会直接拒答）",
      };
    const finalItems = usedRetry ? retryItems : items;
    const chunkIds = evidenceLists[evidence] ?? [];
    const carriers = finalItems.filter((item) =>
      (item.parts ?? []).some((chunkId) => chunkIds.includes(chunkId)),
    );
    const from = usedRetry ? "补充检索的" : "检索的";
    if (carriers.length) {
      const matches: EvidenceStatusEntry[] = [];
      for (const direct of [true, false]) {
        const sources = carriers.filter(
          (item) =>
            (item.chunkId
              ? chunkIds.includes(item.chunkId)
              : fixed?.via !== "extension") === direct,
        );
        if (!sources.length) continue;
        matches.push({
          label: direct ? "检索命中" : "扩展命中",
          tone: "success",
          dashed: !direct,
          detail: sources
            .map((item) => {
              const chunk = `${from}${chunkLabel(item.position, item.chunkId)}`;
              if (direct) {
                const score = rerankText(
                  item.relevance ??
                    (!usedRetry ? fixed?.rerank_probability : undefined),
                );
                return `${chunk}${score ? `（${score}）` : ""}`;
              }
              const extended = item.parts
                .filter(
                  (chunkId) =>
                    chunkId !== item.chunkId && chunkIds.includes(chunkId),
                )
                .map((chunkId) =>
                  chunkLabel(
                    question.agent?.evidence[evidence]?.positions?.[
                      chunkIds.indexOf(chunkId)
                    ],
                    chunkId,
                  ),
                )
                .join("、");
              return `${chunk}（扩展分片：${extended}）`;
            })
            .join("；"),
        });
      }
      return { ...matches[0], matches };
    }
    const row =
      usedRetry && !retry?.evidence
        ? {
            label: "没拿到",
            tone: "danger" as const,
            detail: "补充检索未命中，历史记录未保存过滤原因",
          }
        : lostRow(fixed, config);
    return retry && !usedRetry
      ? { ...row, detail: `${row.detail}；补充检索没采用` }
      : row;
  });
}

function agentEvidenceRows(question: EvalQuestion): EvidenceStatusRow[] {
  const agent = question.agent;
  if (!agent || !question.answerable) return [];
  return agent.evidence.map((evidence, index): EvidenceStatusRow => {
    if (!evidence.found) {
      for (const call of agent.calls) {
        const candidate = call.retrieval_diagnostics?.candidates.find(
          (item) =>
            item.hits?.includes(index) &&
            (item.agent_status ?? item.status) !== "returned",
        );
        if (candidate) {
          const status = candidate.agent_status ?? candidate.status;
          return {
            label: status === "beyond_top_k" ? "未返回" : "被过滤",
            tone: "danger",
            detail: `（第 ${call.call} 次检索：${evidenceFilterReason(call, candidate)}）`,
          };
        }
      }
      const searches = agent.calls.filter(
        (call) => call.name === "search_knowledge" && call.status === "ok",
      );
      return searches.length &&
        searches.every((call) => call.retrieval_diagnostics)
        ? {
            label: "没召回",
            tone: "neutral",
            detail: "每次检索都没召回对应分片",
          }
        : {
            label: "没拿到",
            tone: "neutral",
            detail: "历史记录未保存完整过滤原因",
          };
    }
    const matches = new Map<string, EvidenceStatusEntry>();
    for (const where of [...evidence.where].sort((a, b) => a.call - b.call)) {
      const call = agent.calls.find((item) => item.call === where.call);
      const source = call?.results?.find(
        (item) => item.evidence_id === where.evidence_id,
      );
      const context = call?.name === "read_context";
      const extended =
        !context &&
        (source && evidence.chunk_ids?.length
          ? !evidence.chunk_ids.includes(source.chunk_id ?? "")
          : source?.main_hits
            ? !source.main_hits.includes(index)
            : evidence.via === "extension");
      const label = `第 ${call?.round ?? "—"} 轮${context ? "读前后文拿到" : extended ? "扩展命中" : "检索命中"}`;
      const score = context ? "" : rerankText(source?.relevance, extended);
      const previous = matches.get(label);
      if (previous) {
        previous.count = (previous.count ?? 0) + 1;
        previous.detail = [
          ...new Set([...previous.detail.split("；"), score].filter(Boolean)),
        ].join("；");
      } else
        matches.set(label, {
          label,
          hue:
            call?.round != null && call.round > 0
              ? PRESET_HUES[(call.round - 1) % PRESET_HUES.length]
              : undefined,
          tone: context ? "info" : "success",
          dashed: extended,
          detail: score,
          count: 1,
        });
    }
    const entries = [...matches.values()];
    return entries.length
      ? {
          ...entries[0],
          matches: entries,
          hitCount: entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0),
        }
      : {
          label:
            evidence.via === "extension"
              ? "扩展命中"
              : evidence.via === "context"
                ? "读前后文拿到"
                : "检索命中",
          tone: "success",
          detail: "",
        };
  });
}

// 固定流程没交给模型的计分项：丢在哪一步（第一次检索的记录）。没召回单独一类，其余都算被过滤，括号里写原因。
function lostRow(
  fixed: EvalQuestion["evidence"][number] | undefined,
  config: EvalRun["config"],
): EvidenceStatusRow {
  const outcome = mergeOutcome(fixed, false, config);
  if (!fixed || fixed.status === "not_recalled")
    return { label: "没召回", tone: "neutral", detail: "每一路都没召回" };
  return {
    label: "被过滤",
    tone: "danger",
    detail: `（${outcome.text.replace(/，被过滤$/, "")}）`,
  };
}

// 固定流程一道题命中几个计分项：按最后交给模型的资料算，被清空算 0。
function fixedHits(question: EvalQuestion) {
  if (question.cleared) return 0;
  if (question.given_hits !== undefined && question.given_hits !== null)
    return question.given_hits;
  if (question.evidence.some((item) => item.given !== undefined))
    return question.evidence.filter((item) => item.given).length;
  return Math.round(
    (question.given_recall ?? question.stages?.final.recall ?? 0) *
      question.evidence_count,
  );
}

function fixedExtHits(question: EvalQuestion) {
  if (question.cleared) return 0;
  return (
    question.ext_hits ??
    question.evidence.filter((item) => item.given && item.via === "extension")
      .length
  );
}

function modeRows(
  questions: EvalQuestion[],
  config: EvalConfig | undefined,
  hasFixed: boolean,
  hasAgent: boolean,
): ModeRow[] {
  const answerable = questions.filter((question) => question.answerable);
  const unanswerable = questions.filter((question) => !question.answerable);
  const evidenceTotal = answerable.reduce(
    (sum, question) => sum + question.evidence_count,
    0,
  );
  const rows: ModeRow[] = [];
  let fixed: Record<string, number> = {};
  let agent: Record<string, number> = {};
  if (hasFixed) {
    const ran = answerable.filter((question) => question.stages);
    const hits = ran.map(fixedHits);
    fixed = {
      passed: ran.filter(
        (question, index) =>
          question.evidence_count > 0 && hits[index] >= question.evidence_count,
      ).length,
      count: ran.length,
      hits: hits.reduce((sum, value) => sum + value, 0),
      ext: ran.reduce((sum, question) => sum + fixedExtHits(question), 0),
      direct: ran.reduce(
        (sum, question, index) => sum + hits[index] - fixedExtHits(question),
        0,
      ),
      retried: questions.filter((question) => question.retry?.used).length,
      cleared: answerable.filter((question) => question.cleared).length,
      rejected: ran.filter(
        (question) => question.cleared || question.returned === 0,
      ).length,
      accepted: unanswerable.filter(
        (question) =>
          question.stages && !question.cleared && question.returned > 0,
      ).length,
    };
  }
  if (hasAgent) {
    const ran = answerable.filter((question) => question.agent);
    const found = ran.map(
      (question) =>
        question.agent!.evidence.filter((item) => item.found).length,
    );
    const all = questions
      .filter((question) => question.agent)
      .map((question) => question.agent!);
    const searches = all.reduce((sum, item) => sum + item.searches, 0);
    agent = {
      passed: ran.filter(
        (question, index) =>
          question.evidence_count > 0 &&
          found[index] >=
            (question.agent!.evidence.length || question.evidence_count),
      ).length,
      count: ran.length,
      hits: found.reduce((sum, value) => sum + value, 0),
      ext: ran.reduce(
        (sum, question) =>
          sum +
          question.agent!.evidence.filter(
            (item) => item.found && item.via === "extension",
          ).length,
        0,
      ),
      context: ran.reduce(
        (sum, question) =>
          sum +
          question.agent!.evidence.filter(
            (item) => item.found && item.via === "context",
          ).length,
        0,
      ),
      direct: ran.reduce(
        (sum, question) =>
          sum +
          question.agent!.evidence.filter(
            (item) => item.found && item.via === "direct",
          ).length,
        0,
      ),
      searches,
      wasted: all.reduce((sum, item) => sum + (item.wasted_searches ?? 0), 0),
      forced: all.filter((item) => item.forced).length,
      failed: all.filter((item) => item.status !== "completed").length,
      rejected: ran.filter((question) => question.agent!.returned === 0).length,
      accepted: unanswerable.filter(
        (question) => question.agent && question.agent.returned > 0,
      ).length,
    };
  }
  const both = hasFixed && hasAgent;
  // 两边都跑时，通过数、计分项命中多的一边打 ✓。
  const best = (key: string, side: "fixed" | "agent") =>
    both &&
    (side === "fixed" ? fixed[key] > agent[key] : agent[key] > fixed[key]);
  const pick = (
    fixedCell: ModeCell | undefined,
    agentCell: ModeCell | undefined,
  ) => ({
    fixed: hasFixed ? fixedCell : undefined,
    agent: hasAgent ? agentCell : undefined,
  });
  // 得分：每题满分 100，没拿全最高 90，一条没找到按计分项条数扣分；下面一行是分档计数。
  const fixedScore = summarizeScores(
    questions
      .filter((question) => question.stages)
      .map((question) => [
        question.answerable,
        question.answerable ? fixedHits(question) : 0,
        question.evidence_count,
        question.cleared ? 0 : question.returned,
      ]),
  );
  const agentScore = summarizeScores(
    questions
      .filter(
        (question) => question.agent && question.agent.status === "completed",
      )
      .map((question) => [
        question.answerable,
        question.agent!.evidence.filter((item) => item.found).length,
        question.agent!.evidence.length || question.evidence_count,
        question.agent!.returned,
      ]),
  );
  const scoreBest = (side: "fixed" | "agent") =>
    both &&
    fixedScore.score !== null &&
    agentScore.score !== null &&
    (side === "fixed"
      ? fixedScore.score > agentScore.score
      : agentScore.score > fixedScore.score);
  rows.push({
    group: "result",
    label: "得分",
    ...pick(
      {
        value: formatPoints(fixedScore.score),
        note: bandsText(fixedScore.bands),
        best: scoreBest("fixed"),
      },
      {
        value: formatPoints(agentScore.score),
        note: bandsText(agentScore.bands),
        best: scoreBest("agent"),
      },
    ),
  });
  rows.push({
    group: "result",
    label: "通过",
    ...pick(
      {
        value: `${fixed.passed} / ${fixed.count}`,
        note: "计分项全拿到的题",
        best: best("passed", "fixed"),
      },
      {
        value: `${agent.passed} / ${agent.count}`,
        note: agent.failed
          ? `计分项全拿到的题 · 运行失败 ${agent.failed} 题`
          : "计分项全拿到的题",
        best: best("passed", "agent"),
      },
    ),
  });
  rows.push({
    group: "result",
    label: "计分项命中",
    ...pick(
      {
        value: ratio(fixed.hits, evidenceTotal),
        note: "最后交给模型的资料里有的计分项",
        best: best("hits", "fixed"),
      },
      {
        value: ratio(agent.hits, evidenceTotal),
        note: "Agent 拿到的资料里有的计分项",
        best: best("hits", "agent"),
      },
    ),
  });
  // 每个计分项是检索命中那一片里拿到的，还是父块扩展拼进来的（via）：加扩展命中统计之前跑的评测没有记，显示「—」而不是 0。
  const fixedVia = answerable.some(
    (question) =>
      (question.ext_hits !== undefined && question.ext_hits !== null) ||
      question.evidence.some(
        (item) => item.via !== undefined && item.via !== null,
      ),
  );
  const agentVia = answerable.some((question) =>
    (question.agent?.evidence ?? []).some(
      (item) => item.via !== undefined && item.via !== null,
    ),
  );
  const noVia = {
    value: "—",
    note: "这次评测没记录（加扩展命中统计之前跑的），重跑后才有",
  };
  // 检索命中：计分项命中里去掉靠扩展（和读前后文）拿到的，只算检索本身命中的；没有 via 记录的旧评测显示「—」。
  rows.push({
    group: "result",
    label: "检索命中",
    ...pick(
      fixedVia
        ? {
            value: ratio(fixed.direct, evidenceTotal),
            note: "不算父块扩展，检索本身命中的计分项",
            best: best("direct", "fixed"),
          }
        : noVia,
      agentVia
        ? {
            value: ratio(agent.direct, evidenceTotal),
            note: "不算父块扩展和读前后文，检索本身命中的计分项",
            best: best("direct", "agent"),
          }
        : noVia,
    ),
  });
  rows.push({
    group: "result",
    label: "扩展命中",
    ...pick(
      fixedVia
        ? {
            value: ratio(fixed.ext, evidenceTotal),
            note: "只在父块扩展的分片里",
          }
        : noVia,
      agentVia
        ? {
            value: ratio(agent.ext, evidenceTotal),
            note: agent.context
              ? `只在父块扩展的分片里 · 读前后文 ${agent.context} 条`
              : "只在父块扩展的分片里",
          }
        : noVia,
    ),
  });
  if (unanswerable.length) {
    rows.push({
      group: "result",
      label: "误杀",
      ...pick(
        {
          value: `${fixed.rejected} 题`,
          note: `${fixed.count} 道有答案的题一段资料都没拿到`,
        },
        {
          value: `${agent.rejected} 题`,
          note: `${agent.count} 道有答案的题一段资料都没拿到`,
        },
      ),
    });
    rows.push({
      group: "result",
      label: "漏放",
      ...pick(
        {
          value: `${fixed.accepted} 题`,
          note: `${unanswerable.length} 道没答案的题还拿到了资料`,
        },
        {
          value: `${agent.accepted} 题`,
          note: `${unanswerable.length} 道没答案的题还拿到了资料`,
        },
      ),
    });
  }
  const flowLatency = avg(
    questions
      .filter((question) => question.stages)
      .map((question) => question.flow_latency_ms ?? question.latency_ms),
  );
  const agentRuns = questions
    .filter((question) => question.agent)
    .map((question) => question.agent!);
  const fixedCount = questions.filter((question) => question.stages).length;
  // 交给模型的资料：固定流程是最后留下的那几段，Agent 是资料池里全部（每次检索留下的累加）。
  const averageMaterial = (items: (EvalMaterial | null)[]) => {
    const known = items.filter((item): item is EvalMaterial => item !== null);
    return known.length
      ? {
          count: avg(known.map((item) => item.count))!,
          chars: avg(known.map((item) => item.chars))!,
          tokens: avg(known.map((item) => item.tokens))!,
        }
      : null;
  };
  const fixedGiven = averageMaterial(
    questions.filter((question) => question.stages).map(fixedMaterial),
  );
  const agentGiven = averageMaterial(
    questions.filter((question) => question.agent).map(agentMaterial),
  );
  const materialCell = (
    value: ReturnType<typeof averageMaterial>,
    note: string,
  ) =>
    value
      ? {
          value: `平均 ${number(value.count)} 段 · 约 ${Math.round(value.tokens).toLocaleString()} token`,
          note: `约 ${Math.round(value.chars).toLocaleString()} 字；${note}`,
        }
      : { value: "—", note: "这次评测没记录，重跑后才有" };
  rows.push({
    group: "process",
    label: "资料量",
    ...pick(
      materialCell(fixedGiven, "交给模型的是最后留下的那几段"),
      materialCell(agentGiven, "交给模型的是资料池里全部，每次检索留下的累加"),
    ),
  });
  rows.push({
    group: "process",
    label: "检索",
    ...pick(
      {
        value: `平均 ${number(fixedCount ? 1 + fixed.retried / fixedCount : null)} 次`,
        note: `补充检索 ${fixed.retried} 题${fixed.cleared ? ` · 被清空 ${fixed.cleared} 题` : ""}`,
      },
      {
        value: `平均 ${number(avg(agentRuns.map((item) => item.searches)))} 次`,
        note: agent.searches
          ? `无新增 ${agent.wasted} 次，占 ${Math.round((agent.wasted / agent.searches) * 100)}%`
          : undefined,
      },
    ),
  });
  if (hasAgent)
    rows.push({
      group: "process",
      label: "轮数",
      ...pick(
        { value: "—", note: "固定流程没有轮次" },
        {
          value: `平均 ${number(avg(agentRuns.map((item) => item.rounds)))} 轮`,
          note: `强制回答 ${agent.forced} 题`,
        },
      ),
    });
  rows.push({
    group: "process",
    label: "耗时",
    ...pick(
      {
        value: `平均 ${formatMs(flowLatency)}`,
        note: "改写 + 检索 + 充分性判断，不含写回答",
      },
      agentRuns.some((item) => item.search_ms !== undefined)
        ? {
            value: `平均 ${formatMs(avg(agentRuns.map((item) => item.search_ms ?? 0)))}`,
            note: `只算检索；写回答另需 ${formatMs(avg(agentRuns.map((item) => item.answer_ms ?? 0)))}，合计 ${formatMs(avg(agentRuns.map((item) => item.latency_ms)))}`,
          }
        : {
            value: `平均 ${formatMs(avg(agentRuns.map((item) => item.latency_ms)))}`,
            note: "含写回答（旧记录分不开）",
          },
    ),
  });
  if (hasAgent)
    rows.push({
      group: "process",
      label: "输入 token",
      ...pick(
        { value: "—", note: "没记录" },
        {
          value: `平均 ${number(avg(agentRuns.map((item) => item.prompt_tokens)), 0)}`,
        },
      ),
    });
  const flow = config?.flow;
  const agentConfig = config?.agent;
  const fixedModel =
    config?.model_mode === "demo"
      ? "演示模式（未调用大模型）"
      : flow?.model || "未记录";
  const agentModel =
    config?.model_mode === "demo"
      ? "演示模式（未调用大模型）"
      : agentConfig?.model || "未记录";
  const localIntent = config?.settings?.intent_local;
  const models: { label: string; fixed?: ModeCell; agent?: ModeCell }[] = [
    {
      label: "聊天大模型",
      fixed: { value: fixedModel },
      agent: { value: agentModel },
    },
    {
      label: "充分性判断模型",
      fixed: {
        value: flow ? (flow.sufficiency ? fixedModel : "未启用") : "未记录",
      },
    },
    {
      label: "问题改写模型",
      fixed: { value: fixedModel },
    },
    {
      label: "意图识别模型",
      fixed:
        localIntent === true
          ? {
              value: "TF-IDF + 逻辑回归（本地）",
              note: `未接受时由大模型处理：${fixedModel}`,
            }
          : {
              value: fixedModel,
              note:
                localIntent === undefined
                  ? "历史记录未保存本地分类模型开关"
                  : "规则未命中时由大模型识别",
            },
    },
    {
      label: "向量模型",
      fixed: { value: config?.embedding_model || "未记录" },
      agent: { value: config?.embedding_model || "未记录" },
    },
    {
      label: "重排模型",
      fixed: {
        value:
          config?.settings?.rerank_enabled === false ||
          config?.rerank_mode === "off"
            ? "未启用"
            : config?.rerank_model || "未记录",
      },
      agent: {
        value:
          config?.settings?.rerank_enabled === false ||
          config?.rerank_mode === "off"
            ? "未启用"
            : config?.rerank_model || "未记录",
      },
    },
  ];
  if (agentConfig) {
    models.push(
      {
        label: "工具调用预算",
        agent: { value: `${agentConfig.tool_budget} 次` },
      },
      { label: "执行超时", agent: { value: `${agentConfig.timeout} 秒` } },
      {
        label: "提示词版本",
        agent: { value: agentConfig.prompt_version || "未记录" },
      },
    );
  }
  for (const model of models) {
    rows.push({
      group: "config",
      label: model.label,
      ...pick(model.fixed, model.agent),
    });
  }
  return rows;
}

function ModeCards({
  questions,
  config,
  hasFixed,
  hasAgent,
}: {
  questions: EvalQuestion[];
  config?: EvalConfig;
  hasFixed: boolean;
  hasAgent: boolean;
}) {
  const rows = modeRows(questions, config, hasFixed, hasAgent);
  const card = (side: "fixed" | "agent", title: string) => (
    <section className="ag-mode-card">
      <h4>{title}</h4>
      {rows.map((row, index) => {
        const cell = row[side];
        if (!cell) return null;
        return (
          <Fragment key={row.label}>
            <div
              className={`ag-mode-row is-${row.group}${index > 0 && rows[index - 1].group !== row.group ? " is-break" : ""}`}
            >
              <span className="ag-mode-label">{row.label}</span>
              <span className="ag-mode-value">
                <b>{cell.value}</b>
                {cell.best && (
                  <Tag tone="success" size="sm">
                    {row.label === "得分" ? "✓ 更高" : "✓ 更多"}
                  </Tag>
                )}
                {cell.note && <small>{cell.note}</small>}
              </span>
            </div>
            {row.label === "扩展命中" && (
              <EvidenceFilterSummary questions={questions} mode={side} />
            )}
          </Fragment>
        );
      })}
    </section>
  );
  return (
    <>
      <p className="ev-muted-note">
        得分：{SCORE_RULE}；无法回答的题拿到资料扣 20。
      </p>
      {config && (
        <p className="ev-muted-note">
          {hasFixed && hasAgent ? "两边共用的检索参数" : "检索参数"}：
          {fixedParams(config).join(" · ")}。
          {hasAgent
            ? "Agent 每次检索也走这一套，只是可以自己选检索方式、少取几段。"
            : ""}
        </p>
      )}
      <div className={`ag-mode-cards${hasFixed && hasAgent ? " is-two" : ""}`}>
        {hasFixed && card("fixed", "固定流程")}
        {hasAgent && card("agent", "Agent")}
      </div>
    </>
  );
}

// 两边都跑时，能回答的题按两边是否命中分成四类，一行标签。
function CompareLine({ counts }: { counts: Record<EvalCompareKey, number> }) {
  const tones: Record<EvalCompareKey, Tone> = {
    agent_only: "info",
    fixed_only: "warning",
    neither: "danger",
    both: "success",
  };
  return (
    <div className="ag-compare-line">
      <span>逐题对比</span>
      {(Object.keys(COMPARE_LABELS) as EvalCompareKey[]).map((key) => (
        <Tag key={key} tone={tones[key]} title={COMPARE_HINTS[key]}>
          {COMPARE_LABELS[key]} {counts[key] ?? 0}
        </Tag>
      ))}
    </div>
  );
}

// 「对比」页签（固定流程和 Agent 一起跑时默认打开）：两边的核心指标左右并排，下面是逐题对比，点开看两边的检索日志。
export function ComparePanel({ run }: { run: EvalRun }) {
  const summary: EvalSummary = run.summary ?? {};
  return (
    <div className="ev-overview ag-eval">
      <p className="ev-muted-note">
        {summary.answerable_count ?? 0} 道能回答 ·{" "}
        {summary.unanswerable_count ?? 0}{" "}
        道无法回答，比的是最后交给模型的资料里有没有计分项。
      </p>
      <ModeCards
        questions={run.questions ?? []}
        config={run.config}
        hasFixed
        hasAgent
      />
      {run.comparison && <CompareLine counts={run.comparison} />}
      <div className="ev-section-title">
        按题目类型<small>得分和资料命中率</small>
      </div>
      <div className="diag-table-wrap">
        <table className="diag-table ev-table">
          <thead>
            <tr>
              <th>题型</th>
              <th className="num">题数</th>
              <th className="num">固定流程得分</th>
              <th className="num">Agent 得分</th>
              <th className="num">固定流程命中率</th>
              <th className="num">Agent 命中率</th>
              <th className="num">固定流程资料</th>
              <th className="num">Agent 资料</th>
              <th className="num">Agent 平均检索次数</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(run.by_type ?? {}).map(([type, row]) => (
              <tr key={type}>
                <td>{type}</td>
                <td className="num">{row.count ?? row.agent_count ?? "—"}</td>
                <td className="num">{formatPoints(row.score)}</td>
                <td className="num">{formatPoints(row.agent_score)}</td>
                <td className="num">
                  {percent(row.recall_given ?? row.recall_final)}
                </td>
                <td className="num">{percent(row.agent_recall)}</td>
                <td className="num">
                  {row.material_avg_count === undefined ||
                  row.material_avg_count === null
                    ? "—"
                    : `${number(row.material_avg_count)} 段 · 约 ${Math.round(row.material_avg_tokens ?? 0).toLocaleString()} token`}
                </td>
                <td className="num">
                  {row.agent_material_avg_count === undefined ||
                  row.agent_material_avg_count === null
                    ? "—"
                    : `${number(row.agent_material_avg_count)} 段 · 约 ${Math.round(row.agent_material_avg_tokens ?? 0).toLocaleString()} token`}
                </td>
                <td className="num">{number(row.agent_avg_searches)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ev-section-title">
        逐题<small>点开看两边的检索日志</small>
      </div>
      <AgentQuestionList run={run} hasFixed />
    </div>
  );
}

// 「Agent」页签：Agent 自己的命中、检索过程和成本，逐题只看 Agent 的检索日志。
export function AgentPanel({ run }: { run: EvalRun }) {
  const summary: EvalSummary = run.summary ?? {};
  const config = run.config.agent;
  // 卡片说明写成「共 N 个计分项，有 X 条……」「N 道……题，有 X 道……」，和固定流程的卡片同一种写法。
  const agentQuestions = (run.questions ?? []).filter(
    (question) => question.agent,
  );
  const answerable = agentQuestions.filter((question) => question.answerable);
  const unanswerable = agentQuestions.filter(
    (question) => !question.answerable,
  );
  const evidenceTotal = answerable.reduce(
    (sum, question) => sum + (question.agent?.evidence ?? []).length,
    0,
  );
  const evidenceFound = answerable.reduce(
    (sum, question) =>
      sum +
      (question.agent?.evidence ?? []).filter((item) => item.found).length,
    0,
  );
  const rejected = answerable.filter(
    (question) => (question.agent?.returned ?? 0) === 0,
  ).length;
  // 扩展命中：Agent 拿到的计分项里，只在父块扩展拼进来的分片里的（读前后文拿到的单独算）。
  const viaCount = (kind: string) =>
    answerable.reduce(
      (sum, question) =>
        sum +
        (question.agent?.evidence ?? []).filter(
          (item) => item.found && item.via === kind,
        ).length,
      0,
    );
  const hasVia = answerable.some((question) =>
    (question.agent?.evidence ?? []).some((item) => item.via !== undefined),
  );
  const accepted = unanswerable.filter(
    (question) => (question.agent?.returned ?? 0) > 0,
  ).length;
  return (
    <div className="ev-overview ag-eval">
      <p className="ev-muted-note">
        只看 Agent 最后拿到的资料里有没有计分项。
        {config && (
          <>
            {" "}
            工具预算 {config.tool_budget} 次 · 超时 {config.timeout} 秒 · 提示词{" "}
            {config.prompt_version}
            {config.model ? ` · ${config.model}` : ""}
          </>
        )}
      </p>
      <div className="ev-section-title">
        命中
        <small>
          {summary.answerable_count ?? 0} 道能回答 ·{" "}
          {summary.unanswerable_count ?? 0} 道无法回答
        </small>
      </div>
      <div className="ev-cards">
        <Card
          label="得分"
          value={formatPoints(summary.agent_score)}
          note={
            summary.agent_score_bands
              ? bandsText(
                  summary.agent_score_bands as unknown as Record<
                    string,
                    number
                  >,
                )
              : SCORE_RULE
          }
        />
        <Card
          label="资料命中率"
          value={percent(summary.agent_recall)}
          note={
            agentQuestions.length
              ? `共 ${evidenceTotal} 个计分项，Agent 找到的资料里有 ${evidenceFound} 条`
              : "Agent 找到资料，包含题目的计分项的比例"
          }
        />
        <Card
          label="检索命中率"
          value={hasVia ? percent(summary.agent_direct_recall) : "—"}
          note={
            hasVia
              ? `共 ${evidenceTotal} 个计分项，有 ${viaCount("direct")} 条是检索本身命中的（不算扩展和读前后文）`
              : "这次评测没记录（加扩展命中统计之前跑的），重跑后才有"
          }
        />
        <Card
          label="扩展命中率"
          value={percent(summary.agent_ext_hit_rate)}
          note={
            hasVia
              ? `拿到的 ${evidenceFound} 个计分项里，有 ${viaCount("extension")} 条在扩展的分片里${viaCount("context") ? `，${viaCount("context")} 条靠读前后文` : ""}`
              : "拿到的计分项里，只在父块扩展拼进来的分片里的比例"
          }
        />
        <Card
          label="误杀率"
          value={percent(summary.agent_false_reject_rate)}
          note={
            agentQuestions.length
              ? `${answerable.length} 道有答案的题，有 ${rejected} 道一段资料都没拿到`
              : "有答案却没拿到资料"
          }
        />
        <Card
          label="漏放率"
          value={percent(summary.agent_false_accept_rate)}
          note={
            agentQuestions.length
              ? `${unanswerable.length} 道没答案的题，有 ${accepted} 道还拿到了资料`
              : "没答案却拿到资料"
          }
        />
        {summary.agent_failed ? (
          <Card
            label="运行失败"
            value={`${summary.agent_failed} 题`}
            note="模型调用失败等，点逐题看原因"
          />
        ) : null}
      </div>
      <div className="ev-section-title">
        检索过程<small>每题平均</small>
      </div>
      <div className="ev-cards">
        <Card
          label="检索次数"
          value={number(summary.agent_avg_searches)}
          note={`其中空检索 ${number(summary.agent_avg_empty_searches)} 次`}
        />
        <Card
          label="无新增检索"
          value={number(summary.agent_avg_wasted_searches)}
          note={`一个新分块都没拿到的检索，占全部检索 ${percent(summary.agent_wasted_rate)}（越低越好）`}
        />
        <Card label="读前后文" value={number(summary.agent_avg_reads)} />
        <Card
          label="工具调用"
          value={number(summary.agent_avg_tool_calls)}
          note={`重复调用被拦下 ${summary.agent_duplicates ?? 0} 次`}
        />
        <Card
          label="模型轮数"
          value={number(summary.agent_avg_rounds)}
          note={`强制回答 ${summary.agent_forced ?? 0} 题 · 引用重写 ${summary.agent_citation_retried ?? 0} 题`}
        />
      </div>
      <div className="ev-section-title">
        成本<small>每题平均</small>
      </div>
      <div className="ev-cards">
        <Card
          label="输入 token"
          value={number(summary.agent_avg_prompt_tokens, 0)}
          note={`缓存命中 ${percent(summary.agent_cache_hit_rate)}`}
        />
        <Card
          label="输出 token"
          value={number(summary.agent_avg_completion_tokens, 0)}
        />
        <Card
          label="检索耗时"
          value={formatMs(
            summary.agent_search_latency_avg_ms ?? summary.agent_latency_avg_ms,
          )}
          note={
            summary.agent_search_latency_avg_ms !== undefined &&
            summary.agent_search_latency_avg_ms !== null
              ? `不含写回答；写回答另需 ${formatMs(summary.agent_answer_latency_avg_ms)}，合计 ${formatMs(summary.agent_latency_avg_ms)}`
              : `含写回答（旧记录分不开）· P95 ${formatMs(summary.agent_latency_p95_ms)}`
          }
        />
      </div>
      <div className="ev-section-title">按题目类型</div>
      <div className="diag-table-wrap">
        <table className="diag-table ev-table">
          <thead>
            <tr>
              <th>题型</th>
              <th className="num">题数</th>
              <th className="num">资料命中率</th>
              <th className="num">平均检索次数</th>
              <th className="num">平均耗时</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(run.by_type ?? {}).map(([type, row]) => (
              <tr key={type}>
                <td>{type}</td>
                <td className="num">{row.count ?? row.agent_count ?? "—"}</td>
                <td className="num">{percent(row.agent_recall)}</td>
                <td className="num">{number(row.agent_avg_searches)}</td>
                <td className="num">{formatMs(row.agent_latency_avg_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ev-section-title">
        逐题<small>点开看 Agent 的检索日志</small>
      </div>
      <AgentQuestionList run={run} hasFixed={false} />
    </div>
  );
}

// 每次调用新拿到了哪些分块（之前的调用没拿到过的），以及一个新分块都没拿到的检索有几次。
// 后端从这次起会记 new_chunks / wasted_searches；旧记录没有，就按每次调用的 chunk_ids 现算，结果一样。
function freshness(question: EvalQuestion) {
  const seen = new Set<string>();
  const perCall = new Map<number, Set<string>>();
  let wasted = 0;
  for (const call of question.agent?.calls ?? []) {
    const fresh = new Set(
      call.chunk_ids.filter((chunkId) => !seen.has(chunkId)),
    );
    fresh.forEach((chunkId) => seen.add(chunkId));
    perCall.set(call.call, fresh);
    if (
      call.name === "search_knowledge" &&
      (call.status === "ok" || call.status === "error") &&
      (call.new_chunks ?? fresh.size) === 0
    )
      wasted += 1;
  }
  return { perCall, wasted: question.agent?.wasted_searches ?? wasted };
}

function AgentQuestionList({
  run,
  hasFixed,
}: {
  run: EvalRun;
  hasFixed: boolean;
}) {
  const questions = run.questions ?? [];
  const [typeFilter, setTypeFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  // 每道题各自展开 / 收起，可以同时展开好几道对照着看。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const types: string[] = [];
  for (const question of questions)
    if (!types.includes(question.type)) types.push(question.type);
  const hues = typeHues(types);
  const resultOptions: [string, string][] = hasFixed
    ? [
        ["all", "全部"],
        ["agent_only", COMPARE_LABELS.agent_only],
        ["fixed_only", COMPARE_LABELS.fixed_only],
        ["neither", COMPARE_LABELS.neither],
        ["both", COMPARE_LABELS.both],
        ["unanswerable", "无法回答的题"],
      ]
    : [
        ["all", "全部"],
        ["problem", "只看有问题"],
        ["good", "只看通过"],
      ];
  const visible = questions.filter((question) => {
    if (typeFilter !== "all" && question.type !== typeFilter) return false;
    if (resultFilter === "all") return true;
    if (resultFilter === "unanswerable") return !question.answerable;
    if (resultFilter === "problem")
      return agentVerdict(question).key !== "good";
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
      setStuck(
        sentinel.current.getBoundingClientRect().top <
          header.current.getBoundingClientRect().top - 1,
      );
    }
    check();
    document.addEventListener("scroll", check, true);
    window.addEventListener("resize", check);
    return () => {
      document.removeEventListener("scroll", check, true);
      window.removeEventListener("resize", check);
    };
  }, []);
  return (
    <div>
      <div className="ev-filters">
        <Chips
          value={typeFilter}
          options={[
            ["all", "全部题型"],
            ...types.map((type): [string, string] => [type, type]),
          ]}
          onChange={setTypeFilter}
        />
        <Chips
          value={resultFilter}
          options={resultOptions}
          onChange={setResultFilter}
        />
        <span className="ev-filter-count">
          {visible.length} / {questions.length} 题
        </span>
      </div>
      {/* 表头固定在顶部：题目多、展开详情后往下翻，仍然知道每一列是什么。 */}
      <div ref={sentinel} className="ag-sticky-sentinel" aria-hidden="true" />
      <div
        ref={header}
        className={`ag-q-columns ${layout} ${stuck ? "is-stuck" : ""}`}
        aria-hidden="true"
      >
        <span>编号</span>
        <span>问题</span>
        {hasFixed && (
          <>
            <span>固定流程</span>
            <span>固定流程耗时</span>
          </>
        )}
        <span>Agent</span>
        <span>Agent 检索次数</span>
        <span>Agent 检索耗时</span>
        <span />
      </div>
      <div className="ev-question-list">
        {visible.map((question) => {
          const open = expanded.has(question.id);
          const agent = question.agent;
          return (
            <article
              className={`ev-question ${open ? "is-open" : ""}`}
              key={question.id}
            >
              <button
                className={`ag-q-head ${layout}`}
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (open) next.delete(question.id);
                    else next.add(question.id);
                    return next;
                  })
                }
              >
                <span className="ev-qid" title={question.id}>
                  {question.seq ?? question.id}
                </span>
                <span className="ev-question-text">
                  {question.question}
                  <small>
                    <TypeTag type={question.type} hues={hues} />
                    {question.evidence_count > 1
                      ? ` ${question.evidence_count} 个计分项`
                      : ""}
                    {question.compare
                      ? ` · ${COMPARE_LABELS[question.compare]}`
                      : ""}
                    {question.note ? ` · ${question.note}` : ""}
                  </small>
                </span>
                {hasFixed && (
                  <>
                    <Verdict verdict={fixedVerdict(question)} />
                    <span className="ag-num">
                      {formatMs(
                        question.flow_latency_ms ?? question.latency_ms,
                      )}
                    </span>
                  </>
                )}
                <span className="ag-verdict-cell">
                  <Verdict verdict={agentVerdict(question)} />
                </span>
                <span className="ag-num ag-search-cell">
                  {agent ? `${agent.searches} 次` : "—"}
                </span>
                <span className="ag-num">
                  {agent ? formatMs(agent.search_ms ?? agent.latency_ms) : "—"}
                </span>
                <span className="collapse-icon">{open ? "−" : "＋"}</span>
              </button>
              {open && (
                <QuestionDetail
                  question={question}
                  hasFixed={hasFixed}
                  params={fixedParams(run.config)}
                  config={run.config}
                />
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Chips({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="ev-chips" role="group">
      {options.map(([key, label]) => (
        <button
          key={key}
          className={value === key ? "active" : ""}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// 分块编号：分块在文档里的序号，显示成「第 N 片」，和知识库页面一致，不随检索变化。
// S1、S2 只是某一次检索返回结果的顺序编号（交给模型引用用），每次检索都从 S1 开始，不能拿来对照。
// 旧记录没有序号时，从分块 id 取：分块 id 是「文档 id:序号」（app/storage.py），冒号后面就是序号；
// 原来取 id 的前 8 位，那其实是文档 id，同一份文档的分块全都一样。
function chunkLabel(
  position: number | null | undefined,
  chunkId?: string | null,
) {
  if (typeof position === "number") return `第 ${position + 1} 片`;
  const index = chunkId?.match(/:(\d+)$/)?.[1];
  if (index !== undefined) return `第 ${Number(index) + 1} 片`;
  return chunkId ?? "—";
}

// 一个分块：命中计分项的标签有背景色；点标签打开共用的原文浮窗。
type ChunkItem = {
  key: string;
  id: string;
  chunkId?: string | null;
  position?: number | null;
  parts?: string[];
  evidenceParts?: Set<string>;
  fresh?: boolean;
  snapshotNote?: string;
  title: string | null;
  heading: string | null;
  text: string;
  relevance?: number | null;
  low?: boolean;
  hit: boolean;
};

// 父块扩展：检索命中的是一片，父块扩展会把同一父块里相邻的几片一起拼进来交给模型。
// 拼进来的那几片标成「扩展」（虚线框），方便看出计分项是检索直接命中的，还是靠扩展带进来的。
function extendedParts(item: ChunkItem) {
  return (item.parts ?? []).filter((chunkId) => chunkId !== item.chunkId);
}

// 计分项是不是只在父块扩展拼进来的分片里（检索命中的那一片本身不含计分项）。
function hitByExtension(item: ChunkItem) {
  return (
    item.hit &&
    extendedParts(item).some((chunkId) => item.evidenceParts?.has(chunkId)) &&
    !(item.chunkId && item.evidenceParts?.has(item.chunkId))
  );
}

function ChunkTabs({
  items,
  empty,
  question,
}: {
  items: ChunkItem[];
  empty: string;
  question: EvalQuestion;
}) {
  const [selected, setSelected] = useState<ChunkOriginal | null>(null);
  if (items.length === 0) return <p className="ag-muted">{empty}</p>;
  const groups = [
    { label: "命中", items: items.filter((item) => item.hit) },
    { label: "新增", items: items.filter((item) => item.fresh) },
    {
      label: items.some((item) => item.fresh !== undefined)
        ? "重复返回"
        : "未命中",
      items: items.filter((item) => !item.hit && !item.fresh),
    },
  ];
  return (
    <div className="ag-chunks">
      <ul className="ag-chunk-groups">
        {groups
          .filter((group) => group.items.length)
          .map((group) => (
            <li key={group.label}>
              <span className="ag-chunk-group-label">{group.label}：</span>
              <span className="ag-chunk-group-sources">
                {group.items.map((item) => (
                  <Tag
                    key={item.key}
                    hue
                    size="sm"
                    title={[
                      chunkLabel(item.position, item.chunkId),
                      item.title,
                      hitByExtension(item) ? "计分项在扩展分片中" : "",
                      "点击查看原文",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onClick={() => {
                      const ids = item.parts?.length
                        ? item.parts
                        : item.chunkId
                          ? [item.chunkId]
                          : [];
                      const texts = question.agent?.evidence.length
                        ? question.agent.evidence
                        : question.evidence;
                      const hits = question.answerable
                        ? evidenceChunkLists(question).flatMap(
                            (chunks, index) =>
                              chunks.some((id) => ids.includes(id))
                                ? [index]
                                : [],
                          )
                        : [];
                      setSelected({
                        label: chunkLabel(item.position, item.chunkId),
                        chunkId: item.chunkId,
                        sources: [item],
                        evidence: hits.map((index) => ({
                          number: index + 1,
                          text: texts[index]?.text ?? "",
                        })),
                      });
                    }}
                  >
                    {item.chunkId || item.position != null
                      ? chunkLabel(item.position, item.chunkId)
                      : item.parts?.length
                        ? item.parts
                            .map((id) => chunkLabel(null, id))
                            .join("、")
                        : "查看原文"}
                  </Tag>
                ))}
              </span>
            </li>
          ))}
      </ul>
      <ChunkOriginalDialog value={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// 按来源编号分组，每组内合并同一分片；不同来源可能覆盖同一个分片。
function FinalDelivery({
  question,
  items,
  unavailable = false,
}: {
  question: EvalQuestion;
  items: ChunkItem[];
  unavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ChunkOriginal | null>(null);
  const lists = question.answerable ? evidenceChunkLists(question) : [];
  const evidence = question.agent?.evidence.length
    ? question.agent.evidence
    : question.evidence;
  type Row = {
    chunkId: string | null;
    position?: number | null;
    sources: ChunkItem[];
    hits: number[];
  };
  const groups = new Map<string, Map<string, Row>>();
  const chunks = new Set<string>();
  for (const item of items) {
    const rows = groups.get(item.id) ?? new Map<string, Row>();
    for (const chunkId of item.parts?.length
      ? item.parts
      : [item.chunkId ?? null]) {
      const key = chunkId ?? item.key;
      chunks.add(key);
      const row = rows.get(key) ?? {
        chunkId,
        position: chunkId === item.chunkId ? item.position : null,
        sources: [],
        hits: lists.flatMap((ids, index) =>
          chunkId && ids.includes(chunkId) ? [index] : [],
        ),
      };
      if (!row.sources.some((source) => source.key === item.key))
        row.sources.push(item);
      rows.set(key, row);
    }
    groups.set(item.id, rows);
  }
  const directChunks = new Set(
    items
      .filter((item) => !item.key.startsWith("context-"))
      .map((item) => item.chunkId)
      .filter(Boolean),
  );
  const expandedChunks = new Set(
    items
      .filter((item) => !item.key.startsWith("context-"))
      .flatMap(extendedParts)
      .filter((id) => !directChunks.has(id)),
  );
  return (
    <div className="ag-delivery">
      <button
        type="button"
        className="ag-delivery-open"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="ag-tool">最终交付给模型的资料</span>
        <small>
          {groups.size} 条来源 · {chunks.size} 个分片（含扩展{" "}
          {expandedChunks.size} 片）
        </small>
        <span aria-hidden="true">查看 →</span>
      </button>
      <DetailDialog
        open={open}
        title="最终交付给模型的资料"
        onClose={() => setOpen(false)}
      >
        <p className="ag-muted">
          {groups.size} 条来源 · {chunks.size} 个分片（含扩展{" "}
          {expandedChunks.size} 片）
        </p>
        {unavailable ? (
          <p className="ag-muted">这次评测没有保存最终交付资料。</p>
        ) : groups.size === 0 ? (
          <p className="ag-muted">
            {question.cleared
              ? "资料已清空，没有最终交付。"
              : "没有最终交付资料。"}
          </p>
        ) : (
          <ul className="ag-delivery-groups">
            {[...groups]
              .sort(([a], [b]) =>
                a.localeCompare(b, undefined, { numeric: true }),
              )
              .map(([id, rows]) => (
                <li className="ag-delivery-group" key={id}>
                  <details
                    className="ag-delivery-source"
                    open={[...rows.values()].some((row) => row.hits.length > 0)}
                  >
                    <summary className="ag-delivery-group-head">
                      <SourceTag id={id} />
                      <small>
                        {rows.size} 个分片
                        {![...rows.values()].some(
                          (row) => row.hits.length > 0,
                        ) && "（未命中计分项）"}
                      </small>
                      <span
                        className="ag-delivery-source-toggle"
                        aria-hidden="true"
                      />
                    </summary>
                    <blockquote className="ag-delivery-quote">
                      <ul>
                        {[...rows]
                          .sort(([a], [b]) =>
                            a.localeCompare(b, undefined, { numeric: true }),
                          )
                          .map(([key, row]) => {
                            const direct = row.sources.some(
                              (item) =>
                                !item.key.startsWith("context-") &&
                                item.chunkId === row.chunkId,
                            );
                            const extended =
                              !direct &&
                              row.sources.some(
                                (item) => !item.key.startsWith("context-"),
                              );
                            const score = [
                              ...new Set(
                                row.sources
                                  .map((item) =>
                                    rerankText(item.relevance, extended),
                                  )
                                  .filter(Boolean),
                              ),
                            ].join("、");
                            return (
                              <li key={key}>
                                <button
                                  type="button"
                                  className={`ag-delivery-row ${row.hits.length ? "" : "is-non-evidence"}`}
                                  aria-haspopup="dialog"
                                  onClick={() =>
                                    setSelected({
                                      label: chunkLabel(
                                        row.position,
                                        row.chunkId,
                                      ),
                                      chunkId: row.chunkId,
                                      sources: row.sources,
                                      evidence: row.hits.map((index) => ({
                                        number: index + 1,
                                        text: evidence[index]?.text ?? "",
                                      })),
                                    })
                                  }
                                >
                                  <strong>
                                    {row.chunkId
                                      ? chunkLabel(
                                          row.position,
                                          row.chunkId,
                                        ).replace(/第 (\d+) 片/, "第$1分片")
                                      : "资料"}
                                  </strong>
                                  <Tag
                                    size="sm"
                                    tone={direct ? "success" : "info"}
                                    outline={extended}
                                    className={
                                      extended ? "is-dashed" : undefined
                                    }
                                  >
                                    {direct
                                      ? row.hits.length
                                        ? "检索命中"
                                        : "检索返回"
                                      : extended
                                        ? row.hits.length
                                          ? "扩展命中"
                                          : "扩展返回"
                                        : "读前后文"}
                                  </Tag>
                                  <Tag
                                    size="sm"
                                    tone={
                                      row.hits.length ? "success" : "neutral"
                                    }
                                    className={
                                      row.hits.length
                                        ? undefined
                                        : "ag-non-evidence"
                                    }
                                  >
                                    {row.hits.length
                                      ? `计分项 ${row.hits.map((index) => index + 1).join("、")}`
                                      : "未关联计分项"}
                                  </Tag>
                                  {score && (
                                    <span className="ag-delivery-score">
                                      {score}
                                    </span>
                                  )}
                                  <small>查看原文 →</small>
                                </button>
                              </li>
                            );
                          })}
                      </ul>
                    </blockquote>
                  </details>
                </li>
              ))}
          </ul>
        )}
        <ChunkOriginalDialog
          value={selected}
          onClose={() => setSelected(null)}
        />
      </DetailDialog>
    </div>
  );
}

function agentDelivery(question: EvalQuestion): ChunkItem[] {
  const items = new Map<string, ChunkItem>();
  for (const call of question.agent?.calls ?? []) {
    for (const result of call.results ?? []) {
      // Agent 的 S 编号全程稳定；重复检索不会重复交付同一条资料。
      if (!items.has(result.evidence_id))
        items.set(result.evidence_id, {
          key: result.evidence_id,
          id: result.evidence_id,
          chunkId: result.chunk_id,
          position: result.position,
          parts: result.parent_chunk_ids,
          title: result.title,
          heading: result.heading ?? null,
          text: result.text,
          relevance: result.relevance,
          hit: result.hits.length > 0,
          snapshotNote: call.full_text
            ? undefined
            : "历史记录仅保存正文摘要，可能不完整。",
        });
    }
    if (call.name === "read_context" && call.chunk_ids.length)
      items.set(`context-${call.call}`, {
        key: `context-${call.call}`,
        id: call.source_id ?? "—",
        chunkId: null,
        parts: call.chunk_ids,
        title: "读前后文",
        heading: null,
        text: call.text ?? "",
        hit: Boolean(call.read_hits?.length),
        snapshotNote: call.full_text
          ? undefined
          : "历史记录仅保存正文摘要，可能不完整。",
      });
  }
  return [...items.values()];
}

// Agent 某次调用的某个结果是不是靠父块扩展才含这个计分项：结果检索命中的分片不在计分项所在分片里。
function viaExtension(
  agent: EvalQuestion["agent"],
  where: { call: number; evidence_id: string | null },
  chunkIds?: string[],
) {
  if (!chunkIds?.length) return false;
  const result = agent?.calls
    .find((call) => call.call === where.call)
    ?.results?.find((item) => item.evidence_id === where.evidence_id);
  return (
    Boolean(result?.chunk_id) && !chunkIds.includes(result!.chunk_id as string)
  );
}

// 展开后：先说每个计分项在哪个分块（两边各自的编号，Agent 还标第几次调用），下面左右两栏只列分块编号。
// 固定流程的检索参数（一行显示）：检索方式、候选池、返回段数、相关度阈值；专项只知道检索方式。
function SearchParams({ values }: { values: string[] }) {
  return (
    <div className="ag-call-params" role="group" aria-label="检索参数">
      <strong>检索参数</strong>
      <div className="ag-call-param-values">
        {values.map((value, index) => (
          <Tag key={index} outline plain size="sm">
            {value}
          </Tag>
        ))}
      </div>
    </div>
  );
}

function fixedParams(config: EvalRun["config"] & { search_label?: string }) {
  const parts = [config.search_label ?? "混合检索"];
  if (config.pool_size) parts.push(`候选池 ${config.pool_size}`);
  if (config.return_limit) parts.push(`返回 ${config.return_limit} 段`);
  if (config.reranked === false) parts.push("不重排");
  else if (typeof config.min_score === "number")
    parts.push(`阈值 ${config.min_score.toFixed(2)}`);
  return parts;
}

// 这批分块命中了第几个计分项（从 0 开始）：计分项所在的分片出现在某个分块（含父块扩展拼进来的分片）里就算。
function hitEvidence(items: ChunkItem[], evidenceLists: string[][]) {
  const given = new Set(
    items.flatMap((item) =>
      item.parts?.length ? item.parts : item.chunkId ? [item.chunkId] : [],
    ),
  );
  return evidenceLists.flatMap((chunkIds, index) =>
    chunkIds.some((chunkId) => given.has(chunkId)) ? [index] : [],
  );
}

// 标题行上的结果：命中了哪几个计分项，或者没命中。
function HitTag({ hits, total }: { hits: number[]; total: number }) {
  if (total === 0) return null;
  return hits.length ? (
    <Tag tone="success" dot>
      命中计分项 {hits.map((index) => index + 1).join("、")}
    </Tag>
  ) : (
    <Tag tone="danger" plain>
      没命中计分项
    </Tag>
  );
}

// 第一次检索里，一个计分项合并之后的去向：交给模型了，或者丢在哪一步（没召回 / 没进候选池 / 重排分低于阈值 / 超出返回段数）。
function mergeOutcome(
  fixed: EvalQuestion["evidence"][number] | undefined,
  given: boolean,
  config: EvalRun["config"],
) {
  if (given) return { ok: true, text: "交给模型了" };
  const score =
    typeof fixed?.rerank_probability === "number"
      ? `重排分 ${fixed.rerank_probability.toFixed(2)}`
      : "";
  switch (fixed?.status) {
    case "not_recalled":
    case undefined:
      return { ok: false, text: "每一路都没召回" };
    case "not_in_pool":
      return {
        ok: false,
        text: `合并后排第 ${fixed.rrf_rank ?? "—"} 名，没进候选池（前 ${config.pool_size ?? "—"} 段）`,
      };
    case "filtered_low_score":
      return {
        ok: false,
        text: `进了重排，${score ? `${score}，` : "重排分"}低于阈值 ${typeof config.min_score === "number" ? config.min_score.toFixed(2) : "—"}，被过滤`,
      };
    case "beyond_limit":
      return {
        ok: false,
        text: `${score ? `${score}，` : ""}重排第 ${fixed.rerank_rank ?? "—"} 名，超出返回的 ${config.return_limit ?? "—"} 段`,
      };
    default:
      return { ok: false, text: "进了候选池，但没交给模型" };
  }
}

function QuestionDetail({
  question,
  hasFixed,
  params,
  config,
}: {
  question: EvalQuestion;
  hasFixed: boolean;
  params: string[];
  config: EvalRun["config"];
}) {
  const agent = question.agent;
  // 所有报告使用同一计分项组件；历史字段在接口层统一。
  const texts = (agent?.evidence ?? []).length
    ? agent!.evidence
    : question.evidence;
  return (
    <div className="ev-question-body">
      {agent?.error && (
        <p className="ev-lost-hint">Agent 运行失败：{agent.error}</p>
      )}
      {question.answerable ? (
        <ScoringItems items={texts} />
      ) : (
        <p className="ev-muted-note">没有答案的题，拿到的资料越少越好。</p>
      )}

      <div className={`ag-columns ${hasFixed ? "" : "is-single"}`}>
        {hasFixed && (
          <FixedLog question={question} params={params} config={config} />
        )}
        {agent && <AgentLog question={question} />}
      </div>
    </div>
  );
}

function FixedSearchResults({
  question,
  items,
  config,
  queries,
  queryRoutes,
  mergedEvidence,
  retryQuery,
  sourcesAvailable = true,
  retrySearch = false,
}: {
  question: EvalQuestion;
  items: ChunkItem[];
  config: EvalRun["config"];
  queries: string[];
  queryRoutes?: EvalQuestion["query_routes"];
  mergedEvidence?: EvidenceStatusRow[];
  retryQuery?: string | null;
  sourcesAvailable?: boolean;
  retrySearch?: boolean;
}) {
  const total = question.answerable ? evidenceChunkLists(question).length : 0;
  const routes =
    queryRoutes == null
      ? []
      : queries.map(
          (query) =>
            queryRoutes.find((route) => route.query === query) ?? {
              query,
              recalled: 0,
              kept: 0,
              evidence: [],
              best: [],
            },
        );
  return (
    <>
      {queryRoutes == null && (
        <ul className="ag-query-list">
          {queries.map((query) => (
            <li key={query}>
              <strong className="ag-query-title">
                {query === retryQuery
                  ? "补充查询"
                  : queries.length > 1
                    ? "扩展查询"
                    : "检索查询"}
              </strong>
              {query}
            </li>
          ))}
        </ul>
      )}
      {retryQuery && queryRoutes == null && (
        <p className="ag-muted">
          这条历史记录未保存补充检索的逐路召回与过滤详情，重新评测后可查看。
        </p>
      )}
      {/* 每一路检索词分别检索（和 Agent 同一轮同时发出的几次检索对应），再合并、重排、过滤成最后的结果。 */}
      {/* 只有 1 路时不再套一层「检索」框（外面已经是检索这一步），直接列这一路。 */}
      {routes.length > 0 && (
        <div
          className={
            routes.length > 1 ? "ag-round is-parallel" : "ag-single-route"
          }
        >
          {routes.length > 1 && (
            <div className="ag-round-head">
              同时检索 {routes.length} 路
              <Tag size="sm" tone="warning">
                每路分别检索，合并后重排
              </Tag>
            </div>
          )}
          {routes.map((route, index) => (
            <div className="ag-route" key={route.query}>
              <div className="ag-call-head">
                <span className="ag-tool">第 {index + 1} 路</span>
                <Tag outline plain>
                  召回 {route.recalled} 段
                </Tag>
                <Tag outline plain>
                  留到最后 {route.kept} 段
                </Tag>
              </div>
              <div className="ag-call-query">
                <strong className="ag-query-title">
                  {route.query === retryQuery
                    ? "补充查询"
                    : routes.length > 1
                      ? "扩展查询"
                      : "检索查询"}
                </strong>
                <span>{route.query}</span>
              </div>
              {/* 这一路召回到了哪几个计分项、各排第几（向量、关键词两张排名表）。 */}
              {total > 0 && (
                <ul className="ag-evidence-trace">
                  {Array.from({ length: total }, (_, evidence) => {
                    const best = route.best.find(
                      (item) => item.evidence === evidence,
                    );
                    return route.evidence.includes(evidence) ? (
                      <li key={evidence} className="is-hit">
                        <b>✓</b>计分项 {evidence + 1}
                        <small>召回到了</small>
                        {(best?.dense ?? 0) > 0 && (
                          <Tag size="sm" tone="info" plain>
                            向量第 {best?.dense} 名
                          </Tag>
                        )}
                        {(best?.keyword ?? 0) > 0 && (
                          <Tag size="sm" tone="warning" plain>
                            关键词第 {best?.keyword} 名
                          </Tag>
                        )}
                      </li>
                    ) : (
                      <li key={evidence} className="is-miss">
                        <b>—</b>计分项 {evidence + 1}
                        <small>这一路没召回</small>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="ag-merge-label">
        合并 → 前 {config.pool_size ?? "—"} 段进重排 → 过阈值{" "}
        {typeof config.min_score === "number"
          ? config.min_score.toFixed(2)
          : "—"}{" "}
        → 最多 {config.return_limit ?? "—"} 段交给模型
      </div>
      {mergedEvidence && mergedEvidence.length > 0 && (
        <ul
          className="ag-evidence-trace ag-merge-evidence"
          aria-label="合并过滤后的计分项命中情况"
        >
          {mergedEvidence.map((row, index) => (
            <li key={index}>
              <span
                className={`ag-evidence-name ${row.tone === "danger" || row.tone === "neutral" ? "is-missed" : ""}`}
              >
                计分项 {index + 1}
              </span>
              {(row.matches ?? [row]).map((match) => (
                <span className="ag-evidence-match" key={match.label}>
                  <Tag
                    tone={match.tone}
                    hue={match.hue}
                    size="sm"
                    outline={match.dashed}
                    className={match.dashed ? "is-dashed" : undefined}
                  >
                    {match.label}
                  </Tag>
                  {match.detail && <small>{match.detail}</small>}
                  {match.tone === "danger" &&
                    (() => {
                      const fixed = retrySearch
                        ? question.retry?.evidence?.[index]
                        : question.evidence[index];
                      const ids = evidenceChunkLists(question)[index] ?? [];
                      const candidates = !retrySearch
                        ? question.diagnostics?.candidates.filter((candidate) =>
                            ids.includes(candidate.chunk_id),
                          )
                        : undefined;
                      const text = filteredRankingText(
                        candidates?.length ? candidates : fixed ? [fixed] : [],
                      );
                      return text ? <small>{text}</small> : null;
                    })()}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {sourcesAvailable && (
        <ChunkTabs question={question} items={items} empty="过滤后没有分块。" />
      )}
    </>
  );
}

function FixedLog({
  question,
  params,
  config,
}: {
  question: EvalQuestion;
  params: string[];
  config: EvalRun["config"];
}) {
  const [expanded, setExpanded] = useState(false);
  // 计分项所在的分片（Agent 记的所在分块，或固定流程命中的分片）；来源是父块，父块里任何一片含计分项都算命中。
  const evidenceChunks = new Set<string>();
  for (const item of question.agent?.evidence ?? [])
    for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  for (const item of [
    ...(question.evidence ?? []),
    ...(question.retry?.evidence ?? []),
  ])
    if (item.chunk_id) evidenceChunks.add(item.chunk_id);
  const hitSources = new Set(
    (question.evidence ?? [])
      .filter((item) => item.status === "returned")
      .map((item) => item.source_id),
  );
  const items: ChunkItem[] = (question.sources ?? []).map((source) => {
    const extra = source as {
      chunk_id?: string;
      position?: number | null;
      parent_chunk_ids?: string[];
    };
    const parts =
      extra.parent_chunk_ids ?? (extra.chunk_id ? [extra.chunk_id] : []);
    return {
      key: source.id,
      id: source.id,
      chunkId: extra.chunk_id ?? null,
      position: extra.position ?? null,
      parts,
      title: source.title,
      heading: source.heading ?? null,
      text: source.text,
      relevance: source.relevance,
      evidenceParts: new Set(
        parts.filter((chunkId) => evidenceChunks.has(chunkId)),
      ),
      hit:
        hitSources.has(source.id) ||
        parts.some((chunkId) => evidenceChunks.has(chunkId)),
    };
  });
  // 补充检索的来源：父块里任何一片含计分项都算命中。
  const retry = question.retry;
  const retryItems: ChunkItem[] = (retry?.sources ?? []).map((source) => {
    const parts =
      source.parent_chunk_ids ?? (source.chunk_id ? [source.chunk_id] : []);
    return {
      key: `retry-${source.id}`,
      id: source.id,
      chunkId: source.chunk_id ?? null,
      position: source.position ?? null,
      parts,
      title: source.title,
      heading: source.heading ?? null,
      text: source.text,
      relevance: source.relevance,
      evidenceParts: new Set(
        parts.filter((chunkId) => evidenceChunks.has(chunkId)),
      ),
      hit: parts.some((chunkId) => evidenceChunks.has(chunkId)),
    };
  });
  const sufficiency = question.sufficiency;
  const searches = 1 + (sufficiency?.retried ? 1 : 0);
  const usedRetry = Boolean(sufficiency?.retry_used);
  // 每个计分项所在的分片（Agent 记的所在分块，旧记录用固定流程命中的分片），用来算每次检索命中了第几个计分项。
  const evidenceLists = evidenceChunkLists(question);
  const total = question.answerable ? evidenceLists.length : 0;
  const queries = question.queries ?? [];
  // 按扩展查询里的顺序排每一路（旧记录没有 query_routes 时是空的，退回只列检索词）。
  const routes = [...(question.query_routes ?? [])].sort(
    (a, b) => queries.indexOf(a.query) - queries.indexOf(b.query),
  );
  const retryQueries = retry?.queries ?? [
    ...queries,
    ...(sufficiency?.retry_query ? [sufficiency.retry_query] : []),
  ];
  const retryEvidence =
    retry?.evidence && retry.sources
      ? fixedEvidenceRows(
          {
            ...question,
            sources: retry.sources,
            evidence: retry.evidence,
            retry: undefined,
            sufficiency: undefined,
            cleared: false,
          },
          config,
        )
      : undefined;
  // 这里展示第一次检索合并后的结果，不受后续补充检索或充分性清空影响。
  const mergedEvidence = fixedEvidenceRows(
    { ...question, retry: undefined, sufficiency: undefined, cleared: false },
    config,
  );
  return (
    <section className="ag-log">
      <div className="ag-log-title">
        固定流程
        <small>
          检索 {searches} 次
          {sufficiency?.checked ? ` · 判断 ${sufficiency.calls ?? 1} 次` : ""} ·
          耗时 {formatMs(question.flow_latency_ms ?? question.latency_ms)}
        </small>
      </div>
      <EvidenceStatus
        question={question}
        rows={fixedEvidenceRows(question, config)}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        <FinalDelivery
          question={question}
          items={question.cleared ? [] : usedRetry ? retryItems : items}
          unavailable={
            !question.cleared &&
            (usedRetry ? !retry?.sources : !question.sources)
          }
        />
      </EvidenceStatus>
      <DetailDialog
        open={expanded}
        title="固定流程 · 检索详情"
        onClose={() => setExpanded(false)}
        className="ag-retrieval-dialog"
      >
        <div className="ag-retrieval-content">
          {expanded && (
            <p className="ag-muted ag-numbering-note">
              标签显示分片在文档中的位置；命中表示包含计分项，点击分片查看原文。
            </p>
          )}
          {expanded && (
            <>
              {question.rewrite && (
                <div className="ag-flow-step is-block">
                  <div className="ag-step-head">
                    <span className="ag-tool">改写</span>
                    <span>{rewriteLabel(question)}</span>
                    {question.rewrite.duration_ms !== undefined &&
                      question.rewrite.classifier === "llm" && (
                        <Tag outline plain>
                          耗时 {formatMs(question.rewrite.duration_ms)}
                          {question.rewrite.cached ? "（缓存，当时）" : ""}
                        </Tag>
                      )}
                  </div>
                  {question.rerank_query &&
                    question.rerank_query !== question.question && (
                      <div className="ag-step-row">
                        <span className="ag-row-label">补全后的问题</span>
                        <span>{question.rerank_query}</span>
                      </div>
                    )}
                  <div className="ag-step-row">
                    <span className="ag-row-label">
                      扩展查询（{queries.length} 路）
                    </span>
                    {routes.length ? (
                      <span className="ag-muted">
                        每一路分别检索，见下方检索
                      </span>
                    ) : (
                      <div>
                        <ul className="ag-query-list">
                          {queries.map((query) => (
                            <li key={query}>
                              <strong className="ag-query-title">
                                {queries.length > 1 ? "扩展查询" : "检索查询"}
                              </strong>
                              {query}
                            </li>
                          ))}
                        </ul>
                        {queries.length > 1 && (
                          <small className="ag-muted">
                            每一路分别检索，结果合并后再重排
                          </small>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className={`ag-call ${usedRetry ? "is-unused" : ""}`}>
                <div className="ag-call-head">
                  <span className="ag-tool">
                    {sufficiency?.retried ? "第 1 次 · " : ""}检索
                  </span>
                  <Tag outline plain>
                    耗时 {formatMs(question.latency_ms)}
                  </Tag>
                  <HitTag
                    hits={hitEvidence(items, evidenceLists)}
                    total={total}
                  />
                  {usedRetry && (
                    <Tag outline plain>
                      没采用（换成了补充检索的结果）
                    </Tag>
                  )}
                </div>
                <SearchParams values={params} />
                <FixedSearchResults
                  question={question}
                  items={items}
                  config={config}
                  queries={queries}
                  queryRoutes={question.query_routes}
                  mergedEvidence={mergedEvidence}
                />
              </div>
              {sufficiency && (
                <SufficiencySteps question={question} part="first" />
              )}
              {retry && (
                <div className={`ag-call ${usedRetry ? "" : "is-unused"}`}>
                  <div className="ag-call-head">
                    <span className="ag-tool">第 2 次 · 补充检索</span>
                    {retry.latency_ms != null && (
                      <Tag outline plain>
                        耗时 {formatMs(retry.latency_ms)}
                      </Tag>
                    )}
                    <HitTag
                      hits={hitEvidence(retryItems, evidenceLists)}
                      total={total}
                    />
                    <Tag outline plain>
                      {usedRetry ? "采用了" : "没变好，沿用第一次的"}
                    </Tag>
                  </div>
                  <SearchParams values={params} />
                  <FixedSearchResults
                    question={question}
                    items={retryItems}
                    config={config}
                    queries={retryQueries}
                    queryRoutes={retry.query_routes}
                    mergedEvidence={retryEvidence}
                    retrySearch
                    retryQuery={sufficiency?.retry_query}
                    sourcesAvailable={Boolean(retry.sources)}
                  />
                  {!retry.sources && (
                    <p className="ag-muted">这次评测没有保存补充检索的分块。</p>
                  )}
                </div>
              )}
              {sufficiency && retry && (
                <SufficiencySteps question={question} part="rest" />
              )}
              {question.cleared && (
                <div className="ag-flow-cleared">
                  判断资料不足，已清空：线上会直接拒答。
                </div>
              )}
              <MaterialLine material={fixedMaterial(question)} />
            </>
          )}
        </div>
      </DetailDialog>
    </section>
  );
}

const VERDICT_LABELS: Record<string, string> = {
  sufficient: "够了",
  partial: "只够一部分",
  insufficient: "不够",
};

// 充分性判断：每次判断的结论和缺什么。补充检索后会再判断一次，按发生的顺序放：
// part="first" 放在第一次检索后面（没有补充检索时放全部），part="rest" 放在补充检索后面。
function SufficiencySteps({
  question,
  part,
}: {
  question: EvalQuestion;
  part: "first" | "rest";
}) {
  const sufficiency = question.sufficiency!;
  if (part === "rest" && !sufficiency.checked) return null;
  if (!sufficiency.checked)
    return (
      <div className="ag-flow-step">
        <span className="ag-tool">充分性判断</span>
        <span className="ag-muted">
          {question.returned === 0
            ? "第一次检索没有来源，不用判断"
            : "没做（要真实大模型并打开充分性判断）"}
        </span>
      </div>
    );
  const judgements = sufficiency.judgements?.length
    ? sufficiency.judgements
    : [
        {
          verdict: sufficiency.verdict ?? "",
          missing:
            typeof sufficiency.missing === "string" ? sufficiency.missing : "",
          rewrite_query: sufficiency.retry_query ?? "",
        },
      ];
  const start = part === "rest" ? 1 : 0;
  const end = part === "first" && question.retry ? 1 : judgements.length;
  return (
    <>
      {judgements
        .slice(start, end)
        .map((judgement, offset) => ({ judgement, index: start + offset }))
        .map(({ judgement, index }) => (
          <div
            key={index}
            className={`ag-flow-step is-judge is-${judgement.verdict}`}
          >
            <span className="ag-tool">
              {judgements.length > 1 ? `第 ${index + 1} 次判断` : "充分性判断"}
            </span>
            <strong>
              {VERDICT_LABELS[judgement.verdict] ?? judgement.verdict}
            </strong>
            {judgement.missing && <span>缺：{judgement.missing}</span>}
            {judgement.error && (
              <span className="ag-warn">{judgement.error}</span>
            )}
            {index === 0 &&
              judgement.rewrite_query &&
              judgement.verdict !== "sufficient" && (
                <span>
                  补充检索词 <code>{judgement.rewrite_query}</code>
                </span>
              )}
          </div>
        ))}
    </>
  );
}

// （资料池逐段列表已去掉，只显示段数；计分项怎么拿到的看「计分项命中情况」。）
function AgentLog({ question }: { question: EvalQuestion }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedStep, setSelectedStep] = useState(0);
  const [reasoningDetail, setReasoningDetail] = useState<{
    round: number | null;
    text: string;
  } | null>(null);
  const agent = question.agent!;
  const rounds = [
    ...(agent.round_logs?.length
      ? agent.round_logs.map((record) => ({
          ...record,
          calls: agent.calls.filter((call) => call.round === record.round),
        }))
      : groupByRound(agent.calls).map(([round, calls]) => ({
          round,
          calls,
          kind: "normal",
          reasoning: null,
          content: "",
          error: null,
        }))),
  ];
  if (agent.forced && !agent.round_logs?.length) {
    rounds.push({
      round: agent.rounds,
      calls: [],
      kind: "forced",
      reasoning: null,
      content: "",
      error: null,
    });
  }
  const activeStep = Math.min(selectedStep, rounds.length);
  const fresh = freshness(question);
  const evidenceChunks = new Set<string>();
  for (const item of agent.evidence ?? [])
    for (const chunkId of item.chunk_ids ?? []) evidenceChunks.add(chunkId);
  return (
    <section className="ag-log">
      <div className="ag-log-title">
        Agent
        <small>
          检索 {agent.searches} 次
          {fresh.wasted > 0 ? `（${fresh.wasted} 次无新增）` : ""} ·{" "}
          {agent.rounds} 轮 · {agent.prompt_tokens} token ·{" "}
          {agent.search_ms !== undefined
            ? `检索 ${formatMs(agent.search_ms)} + 写回答 ${formatMs(agent.answer_ms)}`
            : `耗时 ${formatMs(agent.latency_ms)}`}{" "}
          · {STOP_LABELS[agent.stop_reason ?? ""] ?? agent.stop_reason ?? "—"}
        </small>
      </div>
      <EvidenceStatus
        question={question}
        agent
        rows={agentEvidenceRows(question)}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        <FinalDelivery question={question} items={agentDelivery(question)} />
      </EvidenceStatus>
      <DetailDialog
        open={expanded}
        title="Agent · 检索详情"
        onClose={() => setExpanded(false)}
        className="ag-retrieval-dialog"
      >
        <div className="ag-retrieval-content">
          {expanded && (
            <p className="ag-muted ag-numbering-note">
              每次调用按计分项列出命中情况和实际所在分片；“扩展分片”表示通过相邻分片扩展拿到。点击分片查看原文。
            </p>
          )}
          {expanded && (
            <>
              {agent.question_sent !== question.question && (
                <div className="ag-call-meta">
                  实际提问（多轮追问按规则补全）：{agent.question_sent}
                </div>
              )}
              {agent.calls.length === 0 && (
                <p className="ag-muted">没有调用任何工具，直接回答了。</p>
              )}
              <nav className="ag-round-steps" aria-label="Agent 检索步骤">
                {rounds.map(({ round }, index) => (
                  <button
                    type="button"
                    key={`${round}-${index}`}
                    className={activeStep === index ? "is-active" : ""}
                    aria-current={activeStep === index ? "step" : undefined}
                    onClick={() => setSelectedStep(index)}
                  >
                    <span>{index + 1}</span>第 {round ?? "—"} 轮
                  </button>
                ))}
                <button
                  type="button"
                  className={activeStep === rounds.length ? "is-active" : ""}
                  aria-current={
                    activeStep === rounds.length ? "step" : undefined
                  }
                  onClick={() => setSelectedStep(rounds.length)}
                >
                  <span>✓</span>结束
                </button>
              </nav>
              {rounds.map(
                ({ round, calls, kind, reasoning, content, error }, index) =>
                  activeStep === index && (
                    <div key={`${round}-${index}`} className="ag-round-detail">
                      {reasoning ? (
                        <div className="ag-round-reasoning">
                          <div className="ag-reasoning-head">
                            <span className="ag-tool">Agent 推理过程</span>
                            <button
                              type="button"
                              className="ag-more-link"
                              aria-haspopup="dialog"
                              onClick={() =>
                                setReasoningDetail({ round, text: reasoning })
                              }
                            >
                              展开更多
                            </button>
                          </div>
                          <div className="ag-round-text ag-reasoning-preview">
                            {reasoning}
                          </div>
                        </div>
                      ) : (
                        <div className="ag-round-reasoning">
                          <div className="ag-tool">Agent 推理过程</div>
                          <p className="ag-muted">
                            {reasoning === null
                              ? "这条历史记录没有保存本轮推理过程。"
                              : "模型未返回本轮推理过程。"}
                          </p>
                        </div>
                      )}
                      {error && <p className="ag-warn">本轮出错：{error}</p>}
                      {kind === "forced" && (
                        <p className="ag-muted">
                          {agent.stop_reason === "timeout"
                            ? "时间到了"
                            : "工具预算用完"}
                          ，不带工具直接回答。
                        </p>
                      )}
                      {content && (
                        <details className="ag-round-output">
                          <summary>
                            {calls.length ? "本轮模型说明" : "本轮回答"}
                          </summary>
                          <div className="ag-round-text">{content}</div>
                        </details>
                      )}
                      {calls.map((call) => (
                        <AgentCall
                          question={question}
                          key={call.call}
                          call={call}
                          fresh={fresh.perCall.get(call.call) ?? new Set()}
                          evidenceChunks={evidenceChunks}
                        />
                      ))}
                    </div>
                  ),
              )}
              {activeStep === rounds.length && (
                <MaterialLine material={agentMaterial(question)} />
              )}
            </>
          )}
        </div>
      </DetailDialog>
      <DetailDialog
        open={reasoningDetail !== null}
        title={`第 ${reasoningDetail?.round ?? "—"} 轮 · Agent 推理过程`}
        onClose={() => setReasoningDetail(null)}
        className="ag-reasoning-dialog"
      >
        <div className="ag-round-text">{reasoningDetail?.text}</div>
      </DetailDialog>
    </section>
  );
}

// 把调用按轮次分组（保持原来的顺序）；旧记录没有轮次时每次调用单独一组。
function groupByRound(calls: EvalAgentCall[]) {
  const groups: [number | null, EvalAgentCall[]][] = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (
      last &&
      call.round !== null &&
      call.round !== undefined &&
      last[0] === call.round
    )
      last[1].push(call);
    else groups.push([call.round ?? null, [call]]);
  }
  return groups;
}

// 每次工具调用按计分项展示，标签指向实际含有该计分项的分片。
function AgentCallEvidence({
  question,
  call,
  items,
}: {
  question: EvalQuestion;
  call: EvalAgentCall;
  items: ChunkItem[];
}) {
  const [selected, setSelected] = useState<ChunkOriginal | null>(null);
  const evidence = question.answerable ? (question.agent?.evidence ?? []) : [];
  const freshHits = newEvidenceHits(
    question.agent?.calls ?? [],
    call,
    evidence,
  );
  const returned = new Map<
    string,
    {
      item: ChunkItem;
      chunkId: string | null;
      position?: number | null;
      extended: boolean;
    }
  >();
  for (const item of items) {
    for (const chunkId of item.parts?.length
      ? item.parts
      : [item.chunkId ?? null]) {
      const key = `${item.key}:${chunkId ?? "unknown"}`;
      const direct = chunkId === item.chunkId;
      if (!returned.has(key) || direct)
        returned.set(key, {
          item,
          chunkId,
          position: direct
            ? item.position
            : call.name === "read_context"
              ? call.positions?.[call.chunk_ids.indexOf(chunkId ?? "")]
              : undefined,
          extended: call.name !== "read_context" && !direct,
        });
    }
  }
  return (
    <>
      <ul className="ag-evidence-trace ag-call-evidence">
        {evidence.map((quote, index) => {
          const rows = new Map<
            string,
            {
              item: ChunkItem;
              chunkId: string | null;
              position?: number | null;
              extended: boolean;
            }
          >();
          for (const item of items) {
            const ids = item.parts?.length
              ? item.parts
              : item.chunkId
                ? [item.chunkId]
                : [];
            const matched = ids.filter((id) => quote.chunk_ids?.includes(id));
            for (const chunkId of matched)
              if (!rows.has(chunkId) || chunkId === item.chunkId)
                rows.set(chunkId, {
                  item,
                  chunkId,
                  position:
                    quote.positions?.[quote.chunk_ids!.indexOf(chunkId)] ??
                    (chunkId === item.chunkId ? item.position : undefined),
                  extended:
                    call.name !== "read_context" && chunkId !== item.chunkId,
                });
            // 旧记录未保存计分项分片 ID 时，使用这次调用保存的逐计分项命中记录。
            if (
              !matched.length &&
              !quote.chunk_ids?.length &&
              (call.results
                ?.find((result) => result.evidence_id === item.id)
                ?.hits.includes(index) ||
                call.read_hits?.includes(index))
            ) {
              rows.set(item.key, {
                item,
                chunkId: item.chunkId ?? null,
                position: item.position,
                extended: false,
              });
            }
          }
          const hit =
            rows.size > 0 ||
            call.hits.includes(index) ||
            Boolean(call.read_hits?.includes(index));
          const rejected = !hit
            ? call.retrieval_diagnostics?.candidates
                .filter(
                  (candidate) =>
                    candidate.hits?.includes(index) &&
                    (candidate.agent_status ?? candidate.status) !== "returned",
                )
                .sort(
                  (a, b) => (a.rrf_rank ?? Infinity) - (b.rrf_rank ?? Infinity),
                )[0]
            : undefined;
          return (
            <li
              key={index}
              className={
                hit
                  ? "is-hit"
                  : `is-miss${rejected && rejected.agent_status !== "beyond_top_k" ? " is-filtered" : ""}`
              }
            >
              <b>{hit ? "✓" : "—"}</b>
              <span>
                {quote.label
                  ? `[计分项 ${index + 1}：${quote.label}]`
                  : `[计分项 ${index + 1}]`}
              </span>
              {hit ? (
                <small>命中了</small>
              ) : (
                <Tag
                  tone={
                    rejected && rejected.agent_status !== "beyond_top_k"
                      ? "danger"
                      : "neutral"
                  }
                  size="sm"
                >
                  {rejected
                    ? rejected.agent_status === "beyond_top_k"
                      ? "未返回"
                      : "被过滤"
                    : "本次没命中"}
                </Tag>
              )}
              {rejected && (
                <>
                  <small>（{evidenceFilterReason(call, rejected)}）</small>
                  {filteredRankingText([rejected]) && (
                    <small>{filteredRankingText([rejected])}</small>
                  )}
                </>
              )}
              {hit && freshHits.has(index) && (
                <Tag tone="success" size="sm">
                  本次新命中
                </Tag>
              )}
              {[...rows].map(([key, row]) => (
                <Tag
                  key={key}
                  size="sm"
                  tone={row.extended ? "accent" : "info"}
                  outline={row.extended}
                  className={row.extended ? "is-dashed" : undefined}
                  title={[
                    row.item.title,
                    row.extended ? "通过相邻分片扩展拿到" : "",
                    "点击查看原文",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onClick={() =>
                    setSelected({
                      label: chunkLabel(row.position, row.chunkId),
                      chunkId: row.chunkId,
                      sources: [row.item],
                      evidence: [{ number: index + 1, text: quote.text }],
                    })
                  }
                >
                  {row.extended
                    ? "扩展命中 "
                    : call.name === "read_context"
                      ? "读前后文命中 "
                      : "检索命中 "}
                  {row.chunkId || row.position != null
                    ? chunkLabel(row.position, row.chunkId)
                    : "查看原文"}
                </Tag>
              ))}
              {hit && !rows.size && <small>历史记录未保存对应分片</small>}
            </li>
          );
        })}
      </ul>
      <div className="ag-returned-chunks">
        <strong>
          {call.name === "read_context"
            ? "本次读取到的分片"
            : "本次检索到的分片"}
        </strong>
        <div className="ag-returned-groups">
          {returned.size ? (
            items.map((item) => (
              <div key={item.key}>
                <div className="ag-call-param-values">
                  {[...returned]
                    .filter(([, row]) => row.item.key === item.key)
                    .map(([key, row]) => (
                      <Tag
                        key={key}
                        size="sm"
                        tone={row.extended ? "accent" : "info"}
                        outline={row.extended}
                        className={row.extended ? "is-dashed" : undefined}
                        title={[row.item.title, "点击查看原文"]
                          .filter(Boolean)
                          .join(" · ")}
                        onClick={() => {
                          const hits = evidence.flatMap((quote, index) =>
                            row.chunkId &&
                            quote.chunk_ids?.includes(row.chunkId)
                              ? [{ number: index + 1, text: quote.text }]
                              : [],
                          );
                          setSelected({
                            label: chunkLabel(row.position, row.chunkId),
                            chunkId: row.chunkId,
                            sources: [row.item],
                            evidence: hits,
                          });
                        }}
                      >
                        {row.extended ? "扩展 " : ""}
                        {row.chunkId || row.position != null
                          ? chunkLabel(row.position, row.chunkId)
                          : "查看原文"}
                      </Tag>
                    ))}
                </div>
                {call.name === "search_knowledge" &&
                  (() => {
                    const result = call.results?.find(
                      (source) => source.chunk_id === item.chunkId,
                    );
                    const absent = result?.retrieval_recorded
                      ? "未召回"
                      : "未记录";
                    return (
                      <blockquote className="ag-chunk-ranks">
                        向量排名：{result?.vector_rank ?? absent} · 关键词排名：
                        {result?.keyword_rank ?? absent} · 重排分数：
                        {(result?.rerank_score ?? result?.relevance)?.toFixed(
                          4,
                        ) ?? "未记录"}
                      </blockquote>
                    );
                  })()}
              </div>
            ))
          ) : (
            <small className="ag-muted">没有返回分片</small>
          )}
        </div>
      </div>
      <ChunkOriginalDialog value={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function QueryExplanation({
  call,
  question,
}: {
  call: EvalAgentCall;
  question: EvalQuestion;
}) {
  const raw = call.arguments.query_explanation;
  const outer =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const nested = outer.query_explanation;
  const inner =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : {};
  // 校验失败的调用也展示模型已返回的字段；嵌套错误仅在展示时展开，不改变执行参数。
  const fields = { ...inner, ...outer, ...call.query_explanation };
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const explanation = {
    purpose: typeof fields.purpose === "string" ? fields.purpose : "",
    basis: strings(fields.basis),
    references: Array.isArray(fields.references) ? fields.references : [],
    assumptions: strings(fields.assumptions),
  };
  const labels: Record<string, string> = {
    user_question: "用户问题",
    previous_results: "此前返回资料",
    hypothesis: "待验证假设",
  };
  return (
    <div className="ag-query-explanation">
      <div className="ag-query-explanation-head">
        <strong>查询说明</strong>
        <small>模型自述，引用与依据尚未核验</small>
      </div>
      <dl>
        <dt>查询目的</dt>
        <dd>{explanation.purpose || "大模型没有返回查询目的"}</dd>
        <dt>查询依据</dt>
        <dd className="ag-call-param-values">
          {explanation.basis.length === 0 && (
            <span className="ag-muted">大模型没有返回有效的查询依据</span>
          )}
          {explanation.basis.map((basis) => (
            <Tag
              key={basis}
              size="sm"
              tone={basis === "hypothesis" ? "warning" : "info"}
              plain
            >
              {labels[basis] ?? basis}
            </Tag>
          ))}
        </dd>
        {explanation.references.length === 0 && (
          <>
            <dt>参考资料</dt>
            <dd className="ag-muted">大模型没有返回引用依据</dd>
          </>
        )}
        {explanation.references.length > 0 && (
          <>
            <dt>参考资料</dt>
            <dd>
              {explanation.references.map((value: unknown, index: number) => {
                const reference =
                  value && typeof value === "object"
                    ? (value as Record<string, unknown>)
                    : {};
                if (
                  typeof reference.quote !== "string" ||
                  typeof reference.source_id !== "string"
                ) {
                  return (
                    <div className="ag-query-reference" key={index}>
                      <p>{JSON.stringify(value)}</p>
                      <small>
                        大模型返回的引用格式不完整，缺少资料编号或引用原文
                      </small>
                    </div>
                  );
                }
                const previous = question.agent?.calls.find(
                  (item) =>
                    item.round != null &&
                    call.round != null &&
                    item.round < call.round &&
                    item.results?.some(
                      (source) => source.evidence_id === reference.source_id,
                    ),
                );
                const source = previous?.results?.find(
                  (item) => item.evidence_id === reference.source_id,
                );
                return (
                  <div className="ag-query-reference" key={index}>
                    <small>
                      {source
                        ? `第 ${previous?.round} 轮返回 · ${chunkLabel(source.position, source.chunk_id)} · ${source.title ?? "来源资料"}`
                        : `${reference.source_id} · 未定位到此前轮次的引用资料`}
                    </small>
                    <p>“{reference.quote}”</p>
                  </div>
                );
              })}
            </dd>
          </>
        )}
        {explanation.assumptions.length > 0 && (
          <>
            <dt>待验证假设</dt>
            <dd>
              <ul>
                {explanation.assumptions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {nested != null && (
        <p className="ag-muted">
          大模型没有按约定组织查询说明：出现重复嵌套，以上列出已返回字段。
        </p>
      )}
    </div>
  );
}

function RawArguments({ value }: { value: Record<string, unknown> }) {
  let formatted = value;
  let parsed = false;
  if (typeof value.query_explanation === "string") {
    try {
      const explanation: unknown = JSON.parse(value.query_explanation);
      if (explanation && typeof explanation === "object") {
        formatted = { ...value, query_explanation: explanation };
        parsed = true;
      }
    } catch {
      // 非法 JSON 保留原始字符串，不能为了展示修改模型返回的内容。
    }
  }
  return (
    <details className="ag-call-query">
      <summary>查看模型返回的原始参数</summary>
      {parsed && (
        <small>query_explanation 为字符串，以下为字符串解析视图</small>
      )}
      <JsonView value={formatted} wrap />
    </details>
  );
}

function AgentCall({
  call,
  fresh,
  evidenceChunks,
  question,
}: {
  question: EvalQuestion;
  call: EvalAgentCall;
  fresh: Set<string>;
  evidenceChunks: Set<string>;
}) {
  const query = call.query ?? call.arguments.query;
  const rawExplanation = call.arguments.query_explanation;
  const rawTopK =
    rawExplanation &&
    typeof rawExplanation === "object" &&
    "top_k" in rawExplanation
      ? rawExplanation.top_k
      : undefined;
  const topK = call.top_k ?? call.arguments.top_k ?? rawTopK;
  const mode = call.mode ?? call.arguments.mode;
  const status = CALL_STATUS[call.status] ?? call.status;
  const hit = call.hits.length > 0;
  const executed = call.status === "ok" || call.status === "error";
  const newCount = call.new_chunks ?? fresh.size;
  let items: ChunkItem[] = [];
  if (call.results)
    items = call.results.map((result) => ({
      key: `${call.call}-${result.evidence_id}`,
      id: result.evidence_id,
      chunkId: result.chunk_id,
      position: result.position ?? null,
      parts: result.parent_chunk_ids,
      evidenceParts: new Set(
        (result.parent_chunk_ids ?? []).filter((chunkId) =>
          evidenceChunks.has(chunkId),
        ),
      ),
      title: result.title,
      heading: result.heading ?? null,
      text: result.text,
      relevance: result.relevance,
      low: result.low_relevance,
      hit: result.hits.length > 0,
      fresh: Boolean(result.chunk_id) && fresh.has(result.chunk_id as string),
      snapshotNote: call.full_text
        ? undefined
        : "历史记录仅保存正文摘要，可能不完整。",
    }));
  else if (call.name === "read_context" && call.text)
    items = [
      {
        key: `${call.call}-read`,
        id: `${call.source_id ?? ""} ${call.direction === "before" ? "前文" : "后文"}`,
        position: call.positions?.length ? call.positions[0] : null,
        chunkId: call.chunk_ids[0] ?? null,
        fresh: call.chunk_ids.some((chunkId) => fresh.has(chunkId)),
        title: null,
        heading: null,
        text: call.text,
        hit: (call.read_hits ?? []).length > 0,
        snapshotNote: call.full_text
          ? undefined
          : "历史记录仅保存正文摘要，可能不完整。",
      },
    ];
  return (
    <div
      className={`ag-call ${call.status !== "ok" ? "is-off" : ""} ${hit ? "is-hit" : ""}`}
    >
      {/* 标题行放结果（耗时、命中、新增）；下面一行是检索的问题，再下一行是参数。 */}
      <div className="ag-call-head">
        <span className="ag-tool">
          第 {call.call} 次 · {TOOL_LABELS[call.name] ?? call.name}
        </span>
        {call.duration_ms !== undefined && call.duration_ms !== null && (
          <Tag outline plain>
            耗时 {formatMs(call.duration_ms)}
          </Tag>
        )}
        {hit ? (
          <Tag tone="success" dot>
            命中计分项 {call.hits.map((index) => index + 1).join("、")}
          </Tag>
        ) : executed &&
          (call.name === "search_knowledge" || call.name === "read_context") ? (
          <Tag tone="danger" plain>
            没命中计分项
          </Tag>
        ) : null}
        {executed &&
          (call.name === "search_knowledge" || call.name === "read_context") &&
          (newCount > 0 ? (
            <Tag>新增 {newCount} 片</Tag>
          ) : (
            <Tag tone="warning" title="这次拿回的分块，前面的调用都已经拿到过">
              无新增
            </Tag>
          ))}
      </div>
      {call.name === "search_knowledge" && typeof query === "string" ? (
        <>
          <div className="ag-call-query">
            <strong className="ag-query-title">Agent 查询</strong>
            <span>{query}</span>
          </div>
          <SearchParams
            values={[
              typeof mode === "string"
                ? (SEARCH_MODE_LABELS[mode] ?? mode)
                : "默认检索",
              `Top K ${typeof topK === "number" ? topK : "—"}`,
            ]}
          />
        </>
      ) : call.name === "read_context" && call.source_id ? (
        <div className="ag-call-query">
          {call.source_id} 的{call.direction === "before" ? "前文" : "后文"}
        </div>
      ) : (
        <div className="ag-call-query">
          <code>{JSON.stringify(call.arguments)}</code>
        </div>
      )}
      {(call.name === "search_knowledge" || call.name === "read_context") && (
        <QueryExplanation call={call} question={question} />
      )}
      {call.error && <RawArguments value={call.arguments} />}
      {status && (
        <div className="ag-call-meta">
          {status}
          {call.error ? `：${call.error}` : ""}
        </div>
      )}
      {call.error?.includes("依据此前返回资料时") && (
        <p className="ag-muted">
          这是当次运行保存的校验错误。修复不会改写历史结果，需重新运行评测确认检索结果。
        </p>
      )}
      {call.note && call.status !== "ok" && (
        <div className="ag-call-meta">{call.note}</div>
      )}
      {(call.results || call.name === "read_context") && (
        <AgentCallEvidence question={question} call={call} items={items} />
      )}
    </div>
  );
}

// ---------- 专项评测里的 Agent ----------

// 和上次比：上次没通过、这次通过算新通过，反过来算新失败；上次没跑过这个模式就不标。
function change(now: boolean | undefined, before: boolean | null | undefined) {
  if (
    now === undefined ||
    before === undefined ||
    before === null ||
    before === now
  )
    return null;
  return now ? "新通过" : "新失败";
}

// 专项的一道题转成调参评测逐题对比用的格式，复用同一个列表和左右两栏的检索日志。
function fromSpecial(
  question: EvalSpecialQuestion,
  hasFixed: boolean,
  seq: number,
): EvalQuestion {
  const notes = [
    hasFixed
      ? change(question.fixed_passed, question.previous_passed) &&
        `固定流程${change(question.fixed_passed, question.previous_passed)}`
      : null,
    change(question.agent_passed, question.previous_agent_passed) &&
      `Agent ${change(question.agent_passed, question.previous_agent_passed)}`,
  ].filter(Boolean);
  const recall = question.recall_final ?? (question.fixed_passed ? 1 : 0);
  return {
    id: question.id,
    seq,
    question: question.question,
    type: question.type ?? "未分类",
    answerable: true,
    evidence_count:
      question.evidence_count ?? question.agent?.evidence.length ?? 0,
    stages: (hasFixed
      ? {
          pool: { recall, rr: 0, rank: null },
          top: { recall, rr: 0, rank: null },
          final: { recall, rr: 0, rank: null },
        }
      : undefined) as EvalQuestion["stages"],
    lost_stage: question.lost_stage ?? null,
    evidence: (question.fixed_evidence ?? []).map((item) => ({
      ...item,
      rrf_rank: item.rrf_rank ?? null,
      rerank_rank: item.rerank_rank ?? null,
      rerank_probability: item.rerank_probability ?? null,
      status: item.status ?? "not_recalled",
    })),
    given_recall: question.given_recall,
    returned: question.returned ?? 0,
    max_probability: null,
    latency_ms: question.latency_ms ?? 0,
    queries: question.queries ?? [],
    rerank_query: question.rerank_query ?? "",
    query_source: question.rewrite?.classifier ?? "rule",
    first_given_recall: question.first_given_recall,
    given_hits: question.given_hits,
    ext_hits: question.ext_hits,
    rewrite: question.rewrite,
    retry: question.retry,
    cleared: question.cleared,
    flow_latency_ms: question.flow_latency_ms,
    material: question.material,
    sufficiency: question.sufficiency ?? undefined,
    query_routes: question.query_routes,
    sources: question.sources,
    agent: question.agent,
    compare: question.compare,
    note: notes.join(" · ") || undefined,
  };
}

// 按类型统计：从逐题结果现算（通过数、计分项命中条数、得分），旧记录后端没存计分项命中和得分也能显示。
function specialTypeStats(
  questions: EvalSpecialQuestion[],
  hasFixed: boolean,
  hasAgent: boolean,
): TypeStat[] | null {
  const groups = new Map<
    string,
    TypeStat & {
      fixedDirectKnown: boolean;
      agentDirectKnown: boolean;
      fixedScores: number[];
      agentScores: number[];
      fixedMaterials: EvalMaterial[];
      agentMaterials: EvalMaterial[];
    }
  >();
  for (const question of questions) {
    if (!question.type) continue;
    const group = groups.get(question.type) ?? {
      type: question.type,
      count: 0,
      passed: 0,
      fixedDirectKnown: true,
      agentDirectKnown: true,
      fixedScores: [],
      agentScores: [],
      fixedMaterials: [],
      agentMaterials: [],
    };
    if (hasFixed && question.material)
      group.fixedMaterials.push(question.material);
    else if (hasFixed && question.cleared)
      group.fixedMaterials.push({ count: 0, chars: 0, tokens: 0 });
    else if (hasFixed && question.sources)
      group.fixedMaterials.push({
        count: question.sources.length,
        chars: 0,
        tokens: question.sources.reduce(
          (sum, source) => sum + textTokens(source.text ?? ""),
          0,
        ),
      });
    if (hasAgent && question.agent?.material)
      group.agentMaterials.push(question.agent.material);
    groups.set(question.type, group);
    const total =
      question.evidence_count ??
      question.fixed_evidence?.length ??
      question.agent?.evidence.length ??
      0;
    group.count += 1;
    group.passed += question.passed ? 1 : 0;
    group.evidence_total = (group.evidence_total ?? 0) + total;
    if (hasFixed) {
      const hits = question.cleared
        ? 0
        : question.fixed_evidence?.length
          ? question.fixed_evidence.filter((item) => item.given).length
          : (question.given_hits ?? 0);
      group.fixed_passed =
        (group.fixed_passed ?? 0) + (question.fixed_passed ? 1 : 0);
      group.fixed_hits = (group.fixed_hits ?? 0) + hits;
      const found = (question.fixed_evidence ?? []).filter(
        (item) => item.given,
      );
      if (
        hits > 0 &&
        (found.length !== hits || found.some((item) => !item.via))
      )
        group.fixedDirectKnown = false;
      group.fixed_direct =
        (group.fixed_direct ?? 0) +
        (question.cleared
          ? 0
          : found.filter((item) => item.via === "direct").length);
      group.fixed_extension =
        (group.fixed_extension ?? 0) +
        (question.cleared
          ? 0
          : found.filter((item) => item.via === "extension").length);
      const score = questionScore(true, hits, total);
      if (score !== null) group.fixedScores.push(score);
    }
    if (hasAgent && question.agent) {
      const hits = question.agent.evidence.filter((item) => item.found).length;
      group.agent_passed =
        (group.agent_passed ?? 0) + (question.agent_passed ? 1 : 0);
      group.agent_hits = (group.agent_hits ?? 0) + hits;
      const found = question.agent.evidence.filter((item) => item.found);
      if (found.some((item) => !item.via)) group.agentDirectKnown = false;
      group.agent_direct =
        (group.agent_direct ?? 0) +
        found.filter((item) => item.via === "direct").length;
      group.agent_extension =
        (group.agent_extension ?? 0) +
        found.filter((item) => item.via === "extension").length;
      const score = questionScore(
        true,
        hits,
        question.agent.evidence.length || total,
      );
      if (score !== null) group.agentScores.push(score);
    }
  }
  const average = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : undefined;
  const stats = [...groups.values()].map(
    ({
      fixedDirectKnown,
      agentDirectKnown,
      fixedScores,
      agentScores,
      fixedMaterials,
      agentMaterials,
      ...group
    }) => ({
      ...group,
      fixed_direct: fixedDirectKnown ? group.fixed_direct : undefined,
      fixed_extension: fixedDirectKnown ? group.fixed_extension : undefined,
      agent_direct: agentDirectKnown ? group.agent_direct : undefined,
      agent_extension: agentDirectKnown ? group.agent_extension : undefined,
      fixed_score: average(fixedScores),
      agent_score: average(agentScores),
      fixed_material_count: average(fixedMaterials.map((item) => item.count)),
      fixed_material_tokens: average(fixedMaterials.map((item) => item.tokens)),
      agent_material_count: average(agentMaterials.map((item) => item.count)),
      agent_material_tokens: average(agentMaterials.map((item) => item.tokens)),
    }),
  );
  return stats.length ? stats : null;
}

// 检索方式的专项勾了 Agent 时的结果：两边的通过数（和上次比）、对比分类，下面是逐题对比列表。
export function SpecialAgentResults({
  section,
}: {
  section: EvalSpecialSection;
}) {
  const modes = section.modes ?? ["fixed"];
  const hasFixed = modes.includes("fixed");
  const questions = section.questions.map((question, index) =>
    fromSpecial(question, hasFixed, index + 1),
  );
  const counts = {
    both: 0,
    fixed_only: 0,
    agent_only: 0,
    neither: 0,
  } as Record<EvalCompareKey, number>;
  for (const question of section.questions)
    if (question.compare) counts[question.compare] += 1;
  const run = {
    questions,
    config: {
      ...section.run_config,
      split: null,
      suites: [],
      modes,
      search_label: section.search_mode_label,
    },
  } as unknown as EvalRun;
  const typeStats = specialTypeStats(
    section.questions,
    hasFixed,
    modes.includes("agent"),
  );
  return (
    <div className="ev-overview ag-eval ag-special">
      {hasFixed && section.search_mode && section.search_mode !== "hybrid" && (
        <p className="ev-settings-diff">
          这个专项设置了「{section.search_mode_label}」，和 Agent
          比不公平，请用混合检索。
        </p>
      )}
      <ModeCards
        questions={questions}
        config={
          {
            ...section.run_config,
            agent: section.agent ?? section.run_config?.agent,
            search_label: section.search_mode_label,
          } as EvalConfig
        }
        hasFixed={hasFixed}
        hasAgent={modes.includes("agent")}
      />
      {hasFixed && <CompareLine counts={counts} />}
      {typeStats && (
        <>
          <div className="ev-section-title">
            按类型<small>哪类题 Agent 更强、哪类固定流程就够了</small>
          </div>
          <TypeStats
            stats={typeStats}
            hues={typeHues(section.questions.map((question) => question.type))}
            both={hasFixed}
          />
        </>
      )}
      <AgentQuestionList run={run} hasFixed={hasFixed} />
    </div>
  );
}
