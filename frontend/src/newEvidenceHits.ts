import type {
  EvalAgentCall,
  EvalAgentQuestion,
  RetrievalCandidate,
} from "./api";

type RankedCandidate = {
  status?: string;
  agent_status?: string;
  rrf_rank?: number | null;
  rerank_rank?: number | null;
  rerank_probability?: number | null;
  contributions?: RetrievalCandidate["contributions"];
};

export function filteredRankingText(candidates: RankedCandidate[]): string {
  const candidate = [...candidates].sort(
    (a, b) => (a.rrf_rank ?? Infinity) - (b.rrf_rank ?? Infinity),
  )[0];
  if (
    !candidate ||
    !["filtered_low_score", "beyond_limit"].includes(
      candidate.agent_status ?? candidate.status ?? "",
    )
  )
    return "";
  if (candidate.rerank_rank == null && candidate.rerank_probability == null)
    return "";
  const ranks: string[] = [];
  for (const [method, label] of [
    ["dense", "向量"],
    ["keyword", "关键词"],
  ]) {
    const values = (candidate.contributions ?? [])
      .filter(
        (item) =>
          item.method === method && Number.isFinite(item.rank) && item.rank > 0,
      )
      .map((item) => item.rank);
    if (values.length) ranks.push(`${label}第 ${Math.min(...values)} 名`);
  }
  if (
    candidate.rrf_rank != null &&
    Number.isFinite(candidate.rrf_rank) &&
    candidate.rrf_rank > 0
  )
    ranks.push(`合并后第 ${candidate.rrf_rank} 名`);
  return ranks.length ? `（${ranks.join("，")}）` : "";
}

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
