import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// 同一个组件必须正确解释历史记录和新流程，避免把旧的主题词数据当成完整问题。
test("graph trace renders new relation pipeline and preserves legacy records", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { GraphRetrievalTrace } = await server.ssrLoadModule(
      "/src/GraphRetrievalTrace.tsx",
    );
    const graph = {
      status: "ok",
      reason: null,
      scope: [],
      keywords: {
        source: "agent",
        entities: ["段永平"],
        themes: ["投资"],
        question: "段永平投资哪些公司",
      },
      name_matches: [],
      entities: [],
      entity_relations: [],
      relation_matches: [],
      tables: { entity: [], relation: [] },
      dropped_more: {},
      timings: {},
    };
    const legacy = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, { graph }),
    );
    const modern = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, {
        graph: {
          ...graph,
          pipeline: "hybrid_relations_v2",
          relation_candidates: [],
        },
      }),
    );
    assert.match(modern, /候选合并与关系重排/);
    assert.doesNotMatch(modern, /<td>概括<\/td>/);
    assert.match(legacy, /<td>概括<\/td>/);
    assert.doesNotMatch(legacy, /候选合并与关系重排/);
  } finally {
    await server.close();
  }
});
