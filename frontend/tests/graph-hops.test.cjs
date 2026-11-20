const assert = require("node:assert/strict");
const fs = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const source = fs
  .readFileSync(`${__dirname}/../src/graphHops.ts`, "utf8")
  .replace(/^import type .*;$/m, "")
  .replace(/export /g, "");
const graphHops = new Function(
  stripTypeScriptTypes(source) + ";return graphHops;",
)();
const network = {
  nodes: ["a", "b", "c", "isolated"].map((id) => ({ id, name: id })),
  edges: [
    { source: "b", target: "a" },
    { source: "b", target: "c" },
    { source: "a", target: "a" },
    { source: "a", target: "hidden" },
  ],
};
const before = JSON.stringify(network);
assert.deepEqual(
  [...graphHops(network, "a").distances],
  [
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ],
);
assert.equal(graphHops(network, "a").distances.has("isolated"), false);
assert.equal(graphHops(network, "a").distances.has("hidden"), false);
assert.equal(graphHops(network, null), null);
assert.equal(graphHops(network, "missing"), null);
assert.equal(graphHops(undefined, "a"), null);
assert.equal(JSON.stringify(network), before); // No graph elements are mutated.
assert.equal(graphHops(network, "c").distances.get("a"), 2);
network.edges.push({ source: "a", target: "c" });
assert.equal(graphHops(network, "a").distances.get("c"), 1);
console.log(
  "Visible hop distances, reverse edges, cycles, disconnected nodes and shortcuts passed.",
);
