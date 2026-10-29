import type { EvalAgentCall, EvalAgentQuestion } from "./api";

type Candidate = NonNullable<
  EvalAgentCall["retrieval_diagnostics"]
>["candidates"][number];

export function evidenceFilterReason(
  call: EvalAgentCall,
  candidate: Candidate,
): string {
  const config = call.retrieval_diagnostics?.config;
  switch (candidate.agent_status ?? candidate.status) {
    case "filtered_low_score":
      return `进了重排，重排分 ${candidate.rerank_probability?.toFixed(4) ?? "未记录"}，低于阈值 ${config?.min_score ?? "未记录"}`;
    case "not_in_pool":
      return `合并后排第 ${candidate.rrf_rank} 名，没进候选池（前 ${config?.rerank_candidates ?? "未记录"} 段）`;
    case "beyond_limit":
      return `重排第 ${candidate.rerank_rank ?? "未记录"} 名，超出返回的 ${config?.return_limit ?? "未记录"} 段`;
    case "beyond_top_k":
      return `通过检索过滤，但超出本次 Top K ${call.top_k ?? "未记录"} 的返回范围`;
    default:
      return "进了候选池，但没交给模型";
  }
}

// 首次命中按工具调用顺序计算，包含直接检索、父块扩展和读前后文。
export function newEvidenceHits(
  calls: EvalAgentCall[],
  current: EvalAgentCall,
  evidence: EvalAgentQuestion["evidence"],
): Set<number> {
  function hits(call: EvalAgentCall) {
    if (call.status !== "ok" && call.status !== "error")
      return new Set<number>();
    const found = new Set([...call.hits, ...(call.read_hits ?? [])]);
    const chunks = new Set(call.chunk_ids);
    for (const result of call.results ?? []) {
      result.hits.forEach((index) => found.add(index));
      if (result.chunk_id) chunks.add(result.chunk_id);
      result.parent_chunk_ids?.forEach((id) => chunks.add(id));
    }
    evidence.forEach((item, index) => {
      if (
        item.chunk_ids?.some((id) => chunks.has(id)) ||
        item.where?.some((entry) => entry.call === call.call)
      )
        found.add(index);
    });
    return found;
  }
  const seen = new Set<number>();
  for (const call of calls) {
    if (call.call >= current.call) break;
    hits(call).forEach((index) => seen.add(index));
  }
  // 历史记录的逐计分项位置也可证明它在更早的调用中已经命中过。
  evidence.forEach((item, index) => {
    if (item.where?.some((entry) => entry.call < current.call)) seen.add(index);
  });
  return new Set([...hits(current)].filter((index) => !seen.has(index)));
}
