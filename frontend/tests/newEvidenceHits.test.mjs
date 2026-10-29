import assert from "node:assert/strict";
import { newEvidenceHits } from "../src/newEvidenceHits.ts";

const call = (number, changes = {}) => ({
  call: number,
  status: "ok",
  hits: [],
  chunk_ids: [],
  ...changes,
});
const evidence = [
  { chunk_ids: ["a"], where: [] },
  { chunk_ids: ["b"], where: [] },
  { chunk_ids: ["c"], where: [] },
];
const first = call(1, { hits: [0], chunk_ids: ["a"] });
const second = call(2, { hits: [0, 1], chunk_ids: ["a", "b"] });
assert.deepEqual([...newEvidenceHits([first, second], first, evidence)], [0]);
assert.deepEqual([...newEvidenceHits([first, second], second, evidence)], [1]);
const read = call(3, { read_hits: [1, 2], chunk_ids: ["b", "c"] });
assert.deepEqual(
  [...newEvidenceHits([first, second, read], read, evidence)],
  [2],
);
const extension = call(2, {
  results: [{ hits: [], chunk_id: "x", parent_chunk_ids: ["a", "b"] }],
});
assert.deepEqual(
  [...newEvidenceHits([first, extension], extension, evidence)],
  [1],
);
assert.deepEqual(
  [
    ...newEvidenceHits(
      [first, call(2, { status: "skipped", hits: [1] })],
      call(2, { status: "skipped", hits: [1] }),
      evidence,
    ),
  ],
  [],
);
assert.deepEqual(
  [...newEvidenceHits([], second, [{ where: [{ call: 1 }] }, { where: [] }])],
  [1],
);
assert.deepEqual(
  [
    ...newEvidenceHits(
      [first, call(2, { hits: [0] })],
      call(2, { hits: [0] }),
      evidence,
    ),
  ],
  [],
);
console.log("New scoring evidence hit checks passed.");
