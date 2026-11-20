import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
test("entity filtering is a separate step after entity recall", async () => {
  const server = await createServer({
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
      pipeline: "hybrid_relations_v2",
      scope: [],
      keywords: null,
      name_score_query: "问题",
      name_matches: [],
      entities: [],
      entity_relations: [],
      relation_matches: [],
      relation_candidates: [],
      tables: { entity: [], relation: [], unified: [] },
      dropped_more: {},
      timings: {},
    };
    const html = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, { graph }),
    );
    assert.ok(html.indexOf("② 找实体") < html.indexOf("③ 实体过滤"));
    assert.ok(html.indexOf("③ 实体过滤") < html.indexOf("④ 实体的关系"));
    assert.match(html, /⑧ 关系图/);
  } finally {
    await server.close();
  }
});
