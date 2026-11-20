import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("graph hit summary distinguishes unavailable history, zero, and disabled graph", async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { GraphHitSummary } =
      await server.ssrLoadModule("/src/AgentEval.tsx");
    const render = (props) =>
      renderToStaticMarkup(React.createElement(GraphHitSummary, props));
    const hits = { entity_only: 3, global_only: 2, both: 5 };
    assert.equal(render({ enabled: false, hits }), "");
    const html = render({ enabled: true, hits });
    assert.match(html, /图检索命中/);
    assert.match(
      html,
      /实体关系独有 <b>3<\/b> · 全局关系独有 <b>2<\/b> · 两路共同 <b>5<\/b>/,
    );
    assert.match(render({ enabled: true }), /未保存命中路径，无法统计/);
    assert.doesNotMatch(
      render({
        enabled: true,
        hits: { entity_only: 0, global_only: 0, both: 0 },
      }),
      /无法统计/,
    );
  } finally {
    await server.close();
  }
});
