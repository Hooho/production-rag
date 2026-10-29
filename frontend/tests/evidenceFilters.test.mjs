import assert from "node:assert/strict";
import { evidenceFilters } from "../src/evidenceFilters.ts";

const evidence = (stages, changes = {}) => ({
  label: "苹果",
  filter_stages: stages,
  filter_reranked: true,
  given: false,
  ...changes,
});
const question = (rows, changes = {}) => ({
  question: "买了哪些股票",
  answerable: true,
  evidence_count: rows.length,
  evidence: rows,
  ...changes,
});
const summary = (rows, changes) =>
  evidenceFilters([question(rows, changes)], "fixed");
assert.equal(
  summary([
    evidence(["not_in_pool", "filtered_low_score", "returned"], {
      given: true,
    }),
  ]).items.length,
  0,
);
assert.equal(
  summary([evidence(["not_in_pool", "filtered_low_score"])]).items[0].stage,
  "threshold",
);
assert.equal(
  summary([evidence(["not_in_pool", "beyond_limit"])]).items[0].stage,
  "rerank_limit",
);
assert.equal(
  summary([evidence(["not_in_pool"])]).items[0].stage,
  "not_in_pool",
);
assert.equal(
  summary([evidence(["beyond_limit"], { filter_reranked: false })]).items[0]
    .stage,
  "return_limit",
);
assert.equal(summary([evidence([])]).items.length, 0); // 根本未召回不算过滤
assert.equal(
  summary([evidence(["returned"])], { cleared: true }).items.length,
  0,
); // 充分性清空不是重排过滤
assert.equal(
  summary([evidence(["not_in_pool"])], {
    retry: { evidence: [evidence(["returned"])] },
  }).items.length,
  0,
);
assert.equal(summary([evidence(["not_in_pool"])], { retry: {} }).unknown, 1);
assert.equal(summary([evidence(undefined)]).unknown, 1);
const many = summary([
  evidence(["not_in_pool"]),
  evidence([], { given: true }),
  evidence([]),
  evidence([]),
]);
assert.equal(many.total, 4);
assert.equal(many.items.length, 1);
assert.equal(many.missing, 3); // 1/3：分母包含未召回的计分项，不包含最终命中的。
assert.equal(many.unrecalled, 2); // 完全未召回 2/3，和被过滤 1/3 使用同一分母。
assert.equal(
  summary([evidence(["returned"])], { cleared: true }).unrecalled,
  0,
);
assert.equal(summary([evidence(undefined)]).unrecalled, 0);
assert.equal(summary([evidence([], { given: true })]).missing, 0);
assert.equal(summary([evidence(["returned"])], { cleared: true }).missing, 1);
const call = (status, reranked = true) => ({
  name: "search_knowledge",
  status: "ok",
  retrieval_diagnostics: {
    config: { reranked },
    candidates: [{ status, hits: [0] }],
  },
});
const agent = (calls, found = false) =>
  evidenceFilters(
    [
      question([], {
        evidence_count: 1,
        agent: { calls, evidence: [{ found, label: "苹果" }] },
      }),
    ],
    "agent",
  );
assert.equal(
  agent([call("not_in_pool"), call("returned")], true).items.length,
  0,
);
assert.equal(
  agent([call("not_in_pool"), call("beyond_limit")]).items[0].stage,
  "rerank_limit",
);
assert.equal(
  agent([call("not_in_pool"), call("filtered_low_score")]).items[0].stage,
  "threshold",
);
assert.equal(agent([call("beyond_top_k")]).items[0].stage, "tool_limit");
assert.equal(agent([call("returned")], true).missing, 0);
assert.equal(agent([call("filtered_low_score")]).missing, 1);
assert.equal(agent([call("filtered_low_score")]).unrecalled, 0);
assert.equal(
  agent([
    {
      name: "search_knowledge",
      status: "ok",
      retrieval_diagnostics: { config: {}, candidates: [] },
    },
  ]).unrecalled,
  1,
);
assert.equal(agent([{ name: "search_knowledge", status: "ok" }]).unknown, 1);
console.log("evidence filter coverage passed");

const fixedRanks = summary([
  evidence(["not_in_pool", "filtered_low_score"], {
    filter_candidates: [
      { status: "not_in_pool", vector_rank: 1, keyword_rank: 2, rrf_rank: 30 },
      {
        status: "filtered_low_score",
        vector_rank: 8,
        keyword_rank: 6,
        rrf_rank: 3,
        rerank_probability: 0.068,
      },
      {
        status: "filtered_low_score",
        vector_rank: 2,
        keyword_rank: 1,
        rrf_rank: 7,
        rerank_probability: 0.04,
      },
    ],
  }),
]);
assert.equal(fixedRanks.items[0].ranks.vector_rank, 8);
assert.equal(fixedRanks.items[0].ranks.keyword_rank, 6);
assert.equal(fixedRanks.items[0].ranks.rrf_rank, 3);
assert.equal(fixedRanks.items[0].ranks.rerank_probability, 0.068);
const numericAgent = agent([
  {
    name: "search_knowledge",
    status: "ok",
    retrieval_diagnostics: {
      config: { reranked: true },
      candidates: [
        {
          status: "filtered_low_score",
          hits: [0],
          rrf_rank: 4,
          rerank_probability: 0.1,
          contributions: [
            { method: "dense", rank: 9 },
            { method: "keyword", rank: 2 },
          ],
        },
      ],
    },
  },
]);
assert.equal(numericAgent.items[0].ranks.vector_rank, 9);
assert.equal(numericAgent.items[0].ranks.keyword_rank, 2);
assert.equal(numericAgent.items[0].ranks.rrf_rank, 4);
assert.equal(numericAgent.items[0].ranks.rerank_probability, 0.1);
console.log("filter diagnostic numeric checks passed");

// 腾讯：第3次检索未进候选池，第4次参数校验失败，第5次超出返回数量。
const invalidCall = {
  name: "search_knowledge",
  status: "error",
  note: "参数错误：query_explanation.assumptions 应为字符串数组",
};
const tencent = agent([call("not_in_pool"), invalidCall, call("beyond_limit")]);
assert.equal(tencent.items.length, 1);
assert.equal(tencent.items[0].stage, "rerank_limit");
assert.equal(tencent.unknown, 0);
assert.equal(tencent.unrecalled, 0);
// 失败调用不否定其他轮次已经确认的过滤，但真实诊断缺失仍需保守处理。
assert.equal(
  agent([call("not_in_pool"), { name: "search_knowledge", status: "error" }])
    .items.length,
  1,
);
const emptySearch = {
  name: "search_knowledge",
  status: "ok",
  retrieval_diagnostics: { config: {}, candidates: [] },
};
assert.equal(agent([emptySearch, invalidCall]).unrecalled, 1);
assert.equal(agent([emptySearch, invalidCall]).unknown, 0);
assert.equal(
  agent([emptySearch, { name: "search_knowledge", status: "error" }]).unknown,
  1,
);
console.log("Agent failed-call filter regression checks passed.");
