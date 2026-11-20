// Run with: node tests/test_graph_entity_search.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const source = readFileSync(
  new URL("../frontend/src/graphEntitySearch.ts", import.meta.url),
  "utf8",
);
const code = stripTypeScriptTypes(
  source.replace(/^import .*;$/gm, "").replaceAll("export ", ""),
);
const { matchesEntityName, filterRelatedEntities } = vm.runInNewContext(
  `${code}\n({ matchesEntityName, filterRelatedEntities })`,
);
assert(matchesEntityName("腾讯控股ADR", " 腾讯 "));
assert(matchesEntityName("Tencent ADR", "ｔｅｎｃｅｎｔ"));
assert(!matchesEntityName("苹果公司", "腾讯"));
const rows = [
  {
    source_id: "duan",
    target_id: "tencent",
    source_entity: "段永平",
    target_entity: "腾讯控股",
  },
  {
    source_id: "adr",
    target_id: "duan",
    source_entity: "腾讯控股ADR",
    target_entity: "段永平",
  },
  {
    source_id: "duan",
    target_id: "apple",
    source_entity: "段永平",
    target_entity: "苹果公司",
  },
];
assert.equal(filterRelatedEntities(rows, "duan", "腾讯").length, 2);
assert.equal(filterRelatedEntities(rows, "duan", "段永平").length, 0);
assert.equal(filterRelatedEntities(rows, "duan", "不存在").length, 0);
assert.equal(filterRelatedEntities(rows, "duan", " ").length, 3);
console.log(
  "Entity name search passed: incoming/outgoing neighbors, substring, case/width normalization, clearing and no matches.",
);
