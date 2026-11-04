const assert = require("node:assert/strict");
const fs = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");

// Exercise the renderer's actual element mapping without a browser or React mount.
const source = fs.readFileSync(`${__dirname}/../src/GraphView.tsx`, "utf8");
const helpers = source
  .slice(
    source.indexOf("const TYPE_HUES"),
    source.indexOf("export function GraphView"),
  )
  .replace("export function typeColor", "function typeColor");
const compiled = stripTypeScriptTypes(helpers);
const { size, elements, STYLE } = new Function(
  "labelHue",
  compiled + "\nreturn { size, elements, STYLE };",
)(() => 200);
assert.deepEqual(
  [0, 2, 3, 5, 6, 10, 11, 20, 21, 1000].map(size),
  [28, 28, 38, 38, 50, 50, 66, 66, 84, 84],
);
const node = (id, hidden = 0) => ({
  id,
  name: id,
  type: "人物",
  hidden_neighbors: hidden,
  relation_count: 999,
  mention_count: 1,
});
const edge = (id, source, target) => ({
  id,
  source,
  target,
  count: 100,
  categories: ["任职"],
  descriptions: [],
});
const result = elements(
  [node("a", 2), node("b")],
  [
    edge("ab", "a", "b"),
    edge("ba", "b", "a"),
    edge("self", "a", "a"),
    edge("missing", "a", "missing"),
  ],
);
assert.equal(result[0].data.size, 38); // One unique visible neighbor + two hidden.
assert.equal(result[1].data.size, 28);
assert.match(result[0].data.title, /连接 3 个实体/);
assert.equal(result.length, 5); // Invalid endpoint omitted, self-loop retained.
const curve = STYLE.find((style) => style.selector === "edge").style;
assert.equal(curve["curve-style"], "unbundled-bezier");
assert.ok(curve["control-point-distances"][0] > 0);
assert.equal(
  STYLE.find((style) => style.selector === "edge:loop").style["curve-style"],
  "bezier",
);
console.log("Graph sizes, unique neighbors, curves and self-loops passed.");
