import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const source = await readFile(
  new URL("../src/AgentEval.tsx", import.meta.url),
  "utf8",
);
const start = source.indexOf("    agent = {");
const predicate = source.slice(
  source.indexOf("passed:", start),
  source.indexOf("      count:", start),
);
const question = (status, hits) => ({
  evidence_count: 2,
  agent: {
    status,
    evidence: Array.from({ length: 2 }, (_, i) => ({ found: i < hits })),
  },
});
const ran = [
  ...Array.from({ length: 10 }, () => question("completed", 2)),
  question("completed", 1),
  question("failed", 2),
];
const found = ran.map((q) => q.agent.evidence.filter((e) => e.found).length);
const passed = vm.runInNewContext(
  stripTypeScriptTypes(`({${predicate}}).passed`),
  { ran, found },
);
assert.equal(passed, 10);
assert.equal(ran.length, 12);
assert.equal(found.at(-1), 2); // 失败前已命中的证据仍保留。
console.log("Agent completed-only pass count check passed.");
