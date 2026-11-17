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
    const {
      matchingScoringItems,
      EvalEvidenceAnnotation,
      withEvalEvidence,
      filterEvidenceRows,
      EvalEvidenceFilter,
    } = await server.ssrLoadModule("/src/EvalEvidenceAnnotation.tsx");
    const items = [
      {
        label: "理念甲",
        relations: [{ relation_id: "Y" }],
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
      render({ chunkId: "a", relationId: "Y", relationEvidence: "学习巴菲特" }),
      /关系证据/,
    );
    assert.equal(render({ chunkId: "other" }), "");
    assert.equal(
      render({ chunkId: "a", relationId: "X", relationEvidence: "其他关系" }),
      "",
    );
    assert.match(render({ chunkId: "a", origin: true }), /分片证据/);
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
    const rows = [
      { chunk_id: "a", kept: false },
      { chunk_id: "b", kept: true },
      { chunk_id: "other", kept: true },
    ];
    const matches = (row) =>
      matchingScoringItems(items, row.chunk_id).length > 0;
    const all = filterEvidenceRows(rows, matches, "all");
    assert.deepEqual(all.counts, { all: 3, evidence: 2, "non-evidence": 1 });
    assert.deepEqual(
      filterEvidenceRows(rows, matches, "evidence").rows,
      rows.slice(0, 2),
    );
    assert.deepEqual(
      filterEvidenceRows(rows, matches, "non-evidence").rows,
      rows.slice(2),
    );
    assert.deepEqual(
      filterEvidenceRows(
        rows.filter((row) => row.kept),
        matches,
        "all",
      ).counts,
      { all: 2, evidence: 1, "non-evidence": 1 },
    );
    assert.deepEqual(filterEvidenceRows([], matches, "evidence").counts, {
      all: 0,
      evidence: 0,
      "non-evidence": 0,
    });
    const filter = {
      enabled: true,
      value: "all",
      counts: all.counts,
      setValue() {},
    };
    const controls = renderToStaticMarkup(
      React.createElement(EvalEvidenceFilter, { filter }),
    );
    assert.match(controls, /证据筛选/);
    assert.match(controls, /全部 3/);
    assert.match(controls, /非证据 1/);
    assert.equal(
      renderToStaticMarkup(
        React.createElement(EvalEvidenceFilter, {
          filter: { ...filter, enabled: false },
        }),
      ),
      "",
    );
  } finally {
    await server.close();
  }
});
