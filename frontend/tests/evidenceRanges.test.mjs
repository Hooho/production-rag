import assert from "node:assert/strict";
import { evidenceRanges } from "../src/evidenceRanges.ts";

const text = "😀购买ＧＥ\n股票，持有苹果 股票；ＧＥ股票";
const ranges = evidenceRanges(text, ["购买GE股票||持有苹果股票", "GE股票", " || "]);
assert.deepEqual(ranges.map(([start, end]) => text.slice(start, end)), ["购买ＧＥ\n股票", "持有苹果 股票", "ＧＥ\n股票", "ＧＥ股票"]);
assert.deepEqual(evidenceRanges(text, ["不存在的证据"]), []);
assert.deepEqual(evidenceRanges("股票股票", ["股票"]), [[0, 2], [2, 4]]);
console.log("Evidence highlight checks passed.");
