import assert from "node:assert/strict";
import { diffPlan } from "../src/graphReviewDiff.ts";

const X = { name: "X", type: "组织" };
const Y = { name: "Y", type: "组织" };
const old = (ids, naming = X) => ({ ...naming, ids });
const now = (entityIds, naming = X) => ({ entityIds, naming });
const kinds = (groups, applied) =>
  diffPlan(groups, applied).diffs.map((d) => d.change);

// 1 不变 / 2 全新 / 3 整条撤掉
assert.deepEqual(kinds([now(["a", "b"])], [old(["a", "b"])]), [
  { kind: "same" },
]);
assert.deepEqual(kinds([now(["c", "d"])], []), [{ kind: "new" }]);
assert.deepEqual(
  diffPlan([], [old(["a", "b"])]).dropped.map((o) => o.ids),
  [["a", "b"]],
);
// 4 扩大 / 5 缩小 / 有增有减
assert.deepEqual(kinds([now(["a", "b", "c"])], [old(["a", "b"])]), [
  { kind: "grow", added: ["c"] },
]);
assert.deepEqual(kinds([now(["a", "b"])], [old(["a", "b", "c"])]), [
  { kind: "shrink", removed: ["c"] },
]);
assert.deepEqual(kinds([now(["a", "b", "d"])], [old(["a", "b", "c"])]), [
  { kind: "adjust", added: ["d"], removed: ["c"] },
]);
// 6 两条接成一条（新带进来的实体也列出）
const joined = diffPlan(
  [now(["a", "b", "c", "d", "e"])],
  [old(["a", "b"]), old(["c", "d"])],
);
assert.deepEqual(joined.diffs[0].change, {
  kind: "join",
  sources: [
    ["a", "b"],
    ["c", "d"],
  ],
  added: ["e"],
});
assert.deepEqual(joined.dropped, []);
// 7 一条断成两条
assert.deepEqual(
  kinds([now(["a", "b"]), now(["c", "d"])], [old(["a", "b", "c", "d"])]),
  [
    { kind: "split", source: ["a", "b", "c", "d"] },
    { kind: "split", source: ["a", "b", "c", "d"] },
  ],
);
// 8 改名：实体不变或扩大时都要标出来；名字还没选（naming 为空）时不算改名
const renamed = diffPlan([now(["a", "b"], Y)], [old(["a", "b"])]).diffs[0];
assert.deepEqual(renamed, {
  change: { kind: "same" },
  rename: { from: X, to: Y },
});
assert.equal(
  diffPlan([now(["a", "b", "c"], Y)], [old(["a", "b"])]).diffs[0].rename?.to
    .name,
  "Y",
);
assert.equal(
  diffPlan([{ entityIds: ["a", "b"] }], [old(["a", "b"])]).diffs[0].rename,
  undefined,
);
console.log("Graph review diff checks passed.");
