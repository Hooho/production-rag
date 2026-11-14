import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
test("retrieval display follows actual methods and retains zero recall", async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { FixedSearchResults, graphRelationFilter } =
      await server.ssrLoadModule("/src/AgentEval.tsx");
    const question = {
      evidence: [{ targets: [{ chunk_id: "target" }], status: "not_recalled" }],
      diagnostics: {
        graph: {
          relation_candidates: [
            { chunk_id: "target", kept: false, reason: "超过关系保留上限" },
          ],
        },
      },
    };
    assert.equal(graphRelationFilter(question, 0), "超过关系保留上限");
    question.diagnostics.graph.relation_candidates.push({
      chunk_id: "target",
      kept: true,
    });
    assert.equal(graphRelationFilter(question, 0), null);
    const render = (methods, actual, retrySearch = false) =>
      renderToStaticMarkup(
        createElement(FixedSearchResults, {
          question: {
            answerable: false,
            evidence: [],
            question: "问题",
            diagnostics: actual && {
              config: { methods: actual },
              candidates: [],
            },
            retry: retrySearch
              ? {
                  diagnostics: {
                    config: { methods: ["graph"] },
                    candidates: [],
                  },
                }
              : undefined,
          },
          config: { methods },
          items: [],
          queries: ["查询一", "查询二"],
          queryRoutes: [],
          sourcesAvailable: false,
          retrySearch,
        }),
      );
    assert.doesNotMatch(render(["graph"]), /同时检索|融合排名入池/);
    assert.match(render(["graph"]), /图候选入池/);
    assert.match(render(["dense"]), /同时检索 2 路/);
    assert.match(render(["dense", "graph"]), /融合排名入池/);
    assert.doesNotMatch(render(["dense"], ["graph"]), /同时检索/);
    assert.match(render(undefined), /同时检索/);
    assert.doesNotMatch(render(["dense"], undefined, true), /同时检索/);
  } finally {
    await server.close();
  }
});
