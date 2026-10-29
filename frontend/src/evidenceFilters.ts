import type { EvalQuestion } from "./api";

export const FILTER_LABELS = {
  not_in_pool: "召回后未进候选池",
  rerank_limit: "重排后超出返回数量",
  threshold: "低于分数阈值",
  return_limit: "未重排，超出返回数量",
  tool_limit: "超出工具 Top K",
} as const;
export type FilterStage = keyof typeof FILTER_LABELS;
type Event = { status: string; reranked?: boolean };
export type FilterItem = {
  question: string;
  label: string;
  stage: FilterStage;
};

function classify(events: Event[]): FilterStage | null {
  // 多分片、多次检索取走得最远的阶段；已返回但后来被清空，不归因于检索过滤。
  if (events.some((item) => item.status === "returned")) return null;
  if (events.some((item) => item.status === "beyond_top_k"))
    return "tool_limit";
  if (events.some((item) => item.status === "filtered_low_score"))
    return "threshold";
  const limited = events.filter((item) => item.status === "beyond_limit");
  if (limited.length)
    return limited.some((item) => item.reranked)
      ? "rerank_limit"
      : "return_limit";
  return events.some((item) => item.status === "not_in_pool")
    ? "not_in_pool"
    : null;
}

export function evidenceFilters(
  questions: EvalQuestion[],
  mode: "fixed" | "agent",
) {
  const items: FilterItem[] = [];
  let total = 0;
  let missing = 0;
  let unknown = 0;
  for (const question of questions) {
    if (!question.answerable) continue;
    const evidence =
      mode === "agent" ? question.agent?.evidence : question.evidence;
    total += question.evidence_count;
    if (!evidence) {
      missing += question.evidence_count;
      unknown += question.evidence_count;
      continue;
    }
    for (let index = 0; index < question.evidence_count; index++) {
      const item = evidence[index];
      const final =
        mode === "agent"
          ? question.agent?.evidence[index]?.found
          : !question.cleared && question.evidence[index]?.given;
      if (final) continue;
      missing++;
      const events: Event[] = [];
      let recorded = true;
      if (mode === "fixed") {
        for (const rows of [
          question.evidence,
          ...(question.retry ? [question.retry.evidence] : []),
        ]) {
          const entry = rows?.[index];
          if (!entry?.filter_stages) {
            recorded = false;
            continue;
          }
          entry.filter_stages.forEach((status) =>
            events.push({ status, reranked: entry.filter_reranked }),
          );
        }
      } else {
        for (const call of question.agent?.calls ?? []) {
          if (
            call.name !== "search_knowledge" ||
            !["ok", "error"].includes(call.status)
          )
            continue;
          const diagnostics = call.retrieval_diagnostics;
          if (
            !diagnostics ||
            diagnostics.candidates.some(
              (candidate) => !Array.isArray(candidate.hits),
            )
          ) {
            recorded = false;
            continue;
          }
          for (const candidate of diagnostics.candidates) {
            if (candidate.hits?.includes(index))
              events.push({
                status: candidate.agent_status ?? candidate.status,
                reranked: diagnostics.config.reranked,
              });
          }
        }
      }
      if (!recorded) {
        unknown++;
        continue;
      }
      const stage = classify(events);
      if (stage)
        items.push({
          question: question.question,
          label: item?.label || `计分项 ${index + 1}`,
          stage,
        });
    }
  }
  return { items, total, missing, unknown };
}
