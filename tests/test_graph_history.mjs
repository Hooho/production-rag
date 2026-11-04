// Run with: node tests/test_graph_history.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Exercise the history hook with a small synchronous hook scheduler.
const source = readFileSync(
  new URL("../frontend/src/GraphHistory.tsx", import.meta.url),
  "utf8",
);
const hookSource = stripTypeScriptTypes(
  source
    .slice(0, source.indexOf("export function GraphHistoryControls"))
    .replace(/^import .*;$/gm, "")
    .replaceAll("export ", ""),
);
let slots = [],
  slot = 0,
  effects = [],
  dirty = false;
const hooks = {
  useRef(initial) {
    const i = slot++;
    return (slots[i] ??= { current: initial });
  },
  useState(initial) {
    const i = slot++;
    if (!(i in slots)) slots[i] = initial;
    return [
      slots[i],
      (value) => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) {
          slots[i] = next;
          dirty = true;
        }
      },
    ];
  },
  useLayoutEffect(effect, deps) {
    const i = slot++,
      old = slots[i];
    if (!old || deps.some((value, index) => !Object.is(value, old[index]))) {
      slots[i] = deps;
      effects.push(effect);
    }
  },
};
const useGraphHistory = vm.runInNewContext(
  `${hookSource}\nuseGraphHistory`,
  hooks,
);
const overview = {
  selected: null,
  category: null,
  relation: null,
  edge: null,
  scope: "visible",
};
let selection = overview,
  exploration = { query: "", search: "", center: null, focus: [], limit: 20 };
let context = "document-a",
  history;
function render() {
  do {
    dirty = false;
    slot = 0;
    effects = [];
    history = useGraphHistory(
      context,
      selection,
      exploration,
      (next, expanded) => {
        selection = next;
        exploration = expanded;
      },
    );
    effects.forEach((effect) => effect());
  } while (dirty);
  return history;
}
render();
assert.equal(history.back, undefined);
selection = { ...overview, selected: "duan" };
render();
selection = {
  ...selection,
  category: { entityId: "duan", category: "投资" },
  scope: "all",
};
render();
const investment = selection;
exploration = { ...exploration, focus: ["duan|投资", "duan|投资"] };
render();
const expanded = exploration;
const canvas = {
  zoom: 1.5,
  pan: { x: 10, y: 20 },
  positions: { duan: { x: 100, y: 200 } },
  edges: [],
};
history.saveCanvas(canvas);
selection = {
  ...overview,
  edge: {
    id: "duan>tesla|投资",
    source: "duan",
    target: "tesla",
    categories: ["投资"],
  },
};
render();
assert.equal(history.back.selection, investment);
selection = { ...overview, selected: "apple" };
render();
history.go(-1);
render();
assert.equal(selection.edge.id, "duan>tesla|投资");
history.go(-1);
render();
assert.equal(selection, investment);
assert.equal(exploration, expanded);
assert.equal(history.canvasRestore.state, canvas);
history.go(-1);
render();
assert.equal(selection.selected, "duan");
assert.equal(selection.category, null);
history.go(-1);
render();
assert.equal(selection, overview);
assert.equal(history.back, undefined);
selection = { ...overview, selected: "new-entity" };
render();
assert.equal(history.back.selection, overview);
context = "document-b";
render();
assert.equal(history.back, undefined);
console.log(
  "Graph history passed: cross-entity back, category/scope, expansion and canvas restoration, context reset.",
);
