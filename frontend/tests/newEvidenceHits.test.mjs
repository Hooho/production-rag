import assert from "node:assert/strict";
import {
  newEvidenceHits,
  evidenceFilterReason,
  filteredRankingText,
} from "../src/newEvidenceHits.ts";

const call = (number, changes = {}) => ({
  call: number,
  status: "ok",
  hits: [],
  chunk_ids: [],
  ...changes,
});
const evidence = [
  { chunk_ids: ["a"], where: [] },
  { chunk_ids: ["b"], where: [] },
  { chunk_ids: ["c"], where: [] },
];
const first = call(1, { hits: [0], chunk_ids: ["a"] });
const second = call(2, { hits: [0, 1], chunk_ids: ["a", "b"] });
assert.deepEqual([...newEvidenceHits([first, second], first, evidence)], [0]);
assert.deepEqual([...newEvidenceHits([first, second], second, evidence)], [1]);
const read = call(3, { read_hits: [1, 2], chunk_ids: ["b", "c"] });
assert.deepEqual(
  [...newEvidenceHits([first, second, read], read, evidence)],
  [2],
);
const extension = call(2, {
  results: [{ hits: [], chunk_id: "x", parent_chunk_ids: ["a", "b"] }],
});
assert.deepEqual(
  [...newEvidenceHits([first, extension], extension, evidence)],
  [1],
);
assert.deepEqual(
  [
    ...newEvidenceHits(
      [first, call(2, { status: "skipped", hits: [1] })],
      call(2, { status: "skipped", hits: [1] }),
      evidence,
    ),
  ],
  [],
);
assert.deepEqual(
  [...newEvidenceHits([], second, [{ where: [{ call: 1 }] }, { where: [] }])],
  [1],
);
assert.deepEqual(
  [
    ...newEvidenceHits(
      [first, call(2, { hits: [0] })],
      call(2, { hits: [0] }),
      evidence,
    ),
  ],
  [],
);
console.log("New scoring evidence hit checks passed.");

const retrievalCall = {
  top_k: 5,
  retrieval_diagnostics: {
    config: { min_score: 0.85, rerank_candidates: 12, return_limit: 8 },
  },
};
assert.match(
  evidenceFilterReason(retrievalCall, {
    status: "filtered_low_score",
    rerank_probability: 0.02,
  }),
  /重排分 0.02，低于阈值 0.85/,
);
assert.match(
  evidenceFilterReason(retrievalCall, { status: "not_in_pool", rrf_rank: 35 }),
  /第 35 名，没进候选池（前 12 段）/,
);
assert.match(
  evidenceFilterReason(retrievalCall, {
    status: "beyond_limit",
    rerank_rank: 9,
    rerank_probability: 0.91234,
  }),
  /重排第 9 名，重排分 0.91，超出返回的 8 段/,
);
assert.match(
  evidenceFilterReason(retrievalCall, {
    status: "returned",
    agent_status: "beyond_top_k",
  }),
  /通过检索过滤，但超出本次 Top K 5/,
);
console.log("Scoring evidence filter reason checks passed.");

const rankingCandidates = [
  {
    status: "filtered_low_score",
    rrf_rank: 7,
    rerank_probability: 0.02,
    contributions: [
      { method: "dense", rank: 1 },
      { method: "keyword", rank: 2 },
    ],
  },
  {
    status: "filtered_low_score",
    rrf_rank: 3,
    rerank_probability: 0.03,
    contributions: [
      { method: "dense", rank: 8 },
      { method: "keyword", rank: 5 },
    ],
  },
];
assert.equal(
  filteredRankingText(rankingCandidates),
  "（向量第 8 名，关键词第 5 名，合并后第 3 名）",
);
assert.equal(
  filteredRankingText([
    {
      status: "filtered_low_score",
      rerank_probability: 0.02,
      contributions: [{ method: "keyword", rank: 4 }],
    },
  ]),
  "（关键词第 4 名）",
);
assert.equal(
  filteredRankingText([{ status: "not_in_pool", rrf_rank: 35 }]),
  "",
);
assert.equal(
  filteredRankingText([
    { status: "returned", rrf_rank: 1, rerank_probability: 0.9 },
  ]),
  "",
);
assert.equal(
  filteredRankingText([
    { status: "filtered_low_score", rerank_probability: 0.02 },
  ]),
  "",
);
assert.equal(
  filteredRankingText([{ status: "beyond_limit", rrf_rank: 9 }]),
  "",
);
console.log("Filtered ranking checks passed.");
