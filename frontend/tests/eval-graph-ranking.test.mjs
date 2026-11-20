import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
test("graph-only candidates explain their own admission limit", async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { evidenceFilterReason, filteredRankingText } =
      await server.ssrLoadModule("/src/newEvidenceHits.ts");
    const candidate = {
      status: "not_in_pool",
      retrieval_methods: ["graph"],
      graph_only_rank: 9,
      rrf_rank: 33,
    };
    const reason = evidenceFilterReason(
      { retrieval_diagnostics: { config: { graph_pool_size: 8 } } },
      candidate,
    );
    assert.match(reason, /图独有第 9 名/);
    assert.match(reason, /上限 8 段/);
    assert.doesNotMatch(reason, /33/);
    assert.match(
      filteredRankingText([
        {
          status: "filtered_low_score",
          rerank_rank: 1,
          contributions: [{ method: "graph", rank: 2 }],
        },
      ]),
      /图检索第 2 名/,
    );
  } finally {
    await server.close();
  }
});
