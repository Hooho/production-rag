import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("evaluation annotations follow scoring chunks without claiming relation support", async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { matchingScoringItems, EvalEvidenceAnnotation, withEvalEvidence } =
      await server.ssrLoadModule("/src/EvalEvidenceAnnotation.tsx");
    const items = [
      {
        label: "理念甲",
        targets: [
          { chunk_id: "a", quote: "依据甲" },
          { chunk_id: "b", quote: "另一处依据" },
        ],
      },
      { label: "理念乙", targets: [{ chunk_id: "a", quote: "依据乙" }] },
    ];
    assert.deepEqual(
      matchingScoringItems(items, "a").map((hit) => hit.number),
      [1, 2],
    );
    assert.equal(matchingScoringItems(items, "b").length, 1);
    assert.equal(matchingScoringItems(items, "other", "依据甲").length, 0);
    assert.equal(
      matchingScoringItems([{ text: "自己的观点" }], "legacy", "⾃⼰ 的观点")
        .length,
      1,
    );
    const render = (props, evidence = items) =>
      renderToStaticMarkup(
        withEvalEvidence(
          evidence,
          React.createElement(EvalEvidenceAnnotation, props),
        ),
      );
    assert.match(render({ chunkId: "a" }), /计分证据 · 第 1 项：理念甲/);
    assert.match(
      render({ chunkId: "a", relationEvidence: "学习巴菲特" }),
      /关联计分证据/,
    );
    assert.match(render({ chunkId: "other" }), /未匹配计分证据/);
    assert.doesNotMatch(
      render({ chunkId: "a" }, [{ targets: [{ chunk_id: "z" }] }]),
      /理念甲/,
    );
    assert.equal(
      renderToStaticMarkup(
        React.createElement(EvalEvidenceAnnotation, { chunkId: "a" }),
      ),
      "",
    );
  } finally {
    await server.close();
  }
});
