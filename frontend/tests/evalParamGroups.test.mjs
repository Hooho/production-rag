import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/Evaluation.tsx", import.meta.url),
  "utf8",
);
const groupsCode = source.slice(
  source.indexOf("  const tuningParamGroups:"),
  source.indexOf("\n  return (", source.indexOf("  const tuningParamGroups:")),
);
const panel = await readFile(
  new URL("../src/EvalParamsPanel.tsx", import.meta.url),
  "utf8",
);
const filterCode = panel
  .slice(
    panel.indexOf("export function visibleParams("),
    panel.indexOf("// 评测记录上"),
  )
  .replace("export ", "");
function check(methods, modes, expected) {
  const context = vm.createContext({
    launchKind: "retrieval",
    launchModes: modes,
    specialModes: modes,
    specialSuites: methods.map((method, id) => ({ id: String(id), method })),
    pickedSuites: methods.map((_, id) => String(id)),
  });
  vm.runInContext(
    stripTypeScriptTypes(
      `${filterCode}\n${groupsCode}\nglobalThis.result = specialParamGroups; globalThis.judge = specialJudge; globalThis.tuning = tuningParamGroups;`,
    ),
    context,
  );
  assert.deepEqual(Array.from(context.result), expected);
  const params = {
    settings: { fixed: 1, agent: 2 },
    prompts: { fixed: 1, agent: 2 },
    judge: { model: "judge" },
  };
  const options = {
    settings: ["fixed", "agent"].map((key) => ({ key, eval: key })),
    prompts: ["fixed", "agent"].map((id) => ({ id, eval: id })),
  };
  const filtered = context.visibleParams(
    params,
    options,
    context.result,
    context.judge,
  );
  for (const group of ["fixed", "agent"]) {
    assert.equal(
      filtered.settings?.[group] !== undefined,
      expected.includes(group),
    );
    assert.equal(
      filtered.prompts?.[group] !== undefined,
      expected.includes(group),
    );
  }
  assert.equal(
    !!filtered.judge,
    methods.some((method) => ["answer", "dialogue"].includes(method)),
  );
  assert.deepEqual(Array.from(context.tuning), [
    "common",
    ...["fixed", "agent"].filter((mode) => modes.includes(mode)),
  ]);
}
check(["retrieval"], ["agent"], ["common", "agent"]);
check(["retrieval"], ["fixed"], ["common", "fixed"]);
check(["retrieval"], ["fixed", "agent"], ["common", "fixed", "agent"]);
check(["retrieval", "answer"], ["agent"], ["common", "fixed", "agent"]);
check(["retrieval", "dialogue"], ["agent"], ["common", "fixed", "agent"]);
check(["answer", "dialogue"], ["agent"], ["common", "fixed"]);
check([], ["fixed", "agent"], ["common"]);
console.log("Evaluation parameter group and submission checks passed.");
