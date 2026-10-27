import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), "retry-retrieval-"));
const entry = path.join(work, "entry.tsx");
await writeFile(entry, `
import React from ${JSON.stringify(path.join(root, "node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(path.join(root, "node_modules/react-dom/client.js"))};
import { ComparePanel } from ${JSON.stringify(path.join(root, "src/AgentEval.tsx"))};
const evidence = { text: "证据原文", chunk_id: "doc:38", rrf_rank: 1, rerank_rank: 1, rerank_probability: 0.99, source_id: "S1", status: "returned" };
const source = { id: "S1", title: "测试资料", text: "证据原文", relevance: 0.99, heading: null, chunk_id: "doc:38", position: 38, parent_chunk_ids: ["doc:38"] };
const route = { query: "原始查询", recalled: 5, kept: 1, evidence: [0], best: [{ evidence: 0, dense: 1 }] };
const question = { id: "q1", question: "测试补充检索", type: "基础", answerable: true, evidence_count: 1, evidence: [evidence], sources: [source],
  queries: ["原始查询"], query_routes: [route], latency_ms: 10, returned: 1, given_recall: 1, given_hits: 1,
  stages: { pool: { recall: 1, rr: 1, rank: 1 }, top: { recall: 1, rr: 1, rank: 1 }, final: { recall: 1, rr: 1, rank: 1 } },
  sufficiency: { checked: true, verdict: "sufficient", retried: true, retry_used: true, retry_query: "补充查询" },
  retry: { returned: 1, used: true, given_recall: 1, latency_ms: 20, sources: [{ ...source, chunk_id: "doc:85", position: 85, parent_chunk_ids: ["doc:85"] }],
    queries: ["原始查询", "补充查询"], query_routes: [{ ...route, recalled: 0, kept: 0, evidence: [], best: [] }, { ...route, query: "补充查询", best: [{ evidence: 0, keyword: 3 }] }],
    evidence: [{ ...evidence, chunk_id: "doc:85", rerank_probability: 0.95 }] } };
const run = { config: { pool_size: 12, return_limit: 6, min_score: 0.85 }, questions: [question], summary: {}, by_type: {} };
createRoot(document.getElementById("root")!).render(<ComparePanel run={run as any} />);
`);
await build({ root, define: { "process.env.NODE_ENV": JSON.stringify("production") }, resolve: { alias: { "react/jsx-runtime": path.join(root, "node_modules/react/jsx-runtime.js") } }, logLevel: "silent", build: { outDir: path.join(work, "dist"), emptyOutDir: false, lib: { entry, name: "RetryTest", formats: ["iife"], fileName: () => "test.js" } } });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ path: path.join(work, "dist", "production-rag-console.css") });
  await page.addScriptTag({ path: path.join(work, "dist", "test.js") });
  await page.locator(".ag-q-head").click();
  await page.getByRole("button", { name: "检索详情", exact: true }).click();
  const calls = page.locator(".ag-retrieval-content > .ag-call");
  assert.equal(await calls.count(), 2);
  assert.equal(await calls.nth(0).locator(".ag-route").count(), 1);
  assert.equal(await calls.nth(1).locator(".ag-route").count(), 2);
  assert.match(await calls.nth(1).innerText(), /关键词第 3 名/);
  assert.match(await calls.nth(1).innerText(), /检索的第 86 片（重排分 0.99）/);
  assert.match(await calls.nth(1).locator(".ag-route").nth(1).locator(".ag-query-title").innerText(), /补充查询/);
  assert.equal(await calls.nth(1).locator(".ag-merge-evidence").count(), 1);
  assert.deepEqual(errors, []);
  console.log("First and supplementary retrieval share route, ranking, and merge displays.");
} finally { await browser.close(); }
