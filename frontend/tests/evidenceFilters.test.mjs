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
assert.equal(many.items.length, 1); // 1/4，不是1/已召回
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
assert.equal(agent([{ name: "search_knowledge", status: "ok" }]).unknown, 1);
console.log("evidence filter coverage passed");
