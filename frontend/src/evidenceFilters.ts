import type { EvalQuestion, RetrievalCandidate } from "./api";

export const FILTER_LABELS = {
  not_in_pool: "召回后未进候选池",
  rerank_limit: "重排后超出返回数量",
  threshold: "低于分数阈值",
  return_limit: "未重排，超出返回数量",
  tool_limit: "超出工具 Top K",
} as const;
export type FilterStage = keyof typeof FILTER_LABELS;
type Event = {
  status: string;
  reranked?: boolean;
  vector_rank?: number | null;
  keyword_rank?: number | null;
  rrf_rank?: number | null;
  rerank_probability?: number | null;
};
export type FilterItem = {
  question: string;
  label: string;
  stage: FilterStage;
  ranks?: Event;
};

function rankOf(candidate: RetrievalCandidate | undefined, method: string) {
  const ranks = (candidate?.contributions ?? [])
    .filter((part) => part.method === method && part.rank > 0)
    .map((part) => part.rank);
  return ranks.length ? Math.min(...ranks) : null;
}

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
  let unrecalled = 0;
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
          if (entry.filter_candidates) {
            events.push(
              ...entry.filter_candidates.map((candidate) => ({
                ...candidate,
                reranked: entry.filter_reranked,
              })),
            );
          } else {
            const candidate =
              rows === question.evidence
                ? question.diagnostics?.candidates.find(
                    (row) => row.chunk_id === entry.chunk_id,
                  )
                : undefined;
            entry.filter_stages.forEach((status) =>
              events.push({
                status,
                reranked: entry.filter_reranked,
                ...(status === entry.status
                  ? {
                      vector_rank: rankOf(candidate, "dense"),
                      keyword_rank: rankOf(candidate, "keyword"),
                      rrf_rank: entry.rrf_rank,
                      rerank_probability: entry.rerank_probability,
                    }
                  : {}),
              }),
            );
          }
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
                vector_rank: rankOf(candidate, "dense"),
                keyword_rank: rankOf(candidate, "keyword"),
                rrf_rank: candidate.rrf_rank,
                rerank_probability: candidate.rerank_probability,
              });
          }
        }
      }
      if (!recorded) {
        unknown++;
        continue;
      }
      const stage = classify(events);
      if (events.every((event) => event.status === "not_recalled"))
        unrecalled++;
      if (stage)
        items.push({
          question: question.question,
          label: item?.label || `计分项 ${index + 1}`,
          stage,
          ranks: events
            .filter((event) => classify([event]) === stage)
            .sort(
              (a, b) => (a.rrf_rank ?? Infinity) - (b.rrf_rank ?? Infinity),
            )[0],
        });
    }
  }
  return { items, total, missing, unrecalled, unknown };
}
