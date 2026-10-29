import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const source = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const routeFunction = source.slice(
  source.indexOf("function readRoute("),
  source.indexOf("\nfunction App()"),
);
const context = vm.createContext({ MAINTENANCE_TABS: [] });
vm.runInContext(stripTypeScriptTypes(routeFunction), context);
for (const url of ["/eval", "/eval/runs", "/eval/runs/"]) {
  assert.equal(context.readRoute(url).section, "history");
  assert.equal(context.readRoute(url).runId, undefined);
}
assert.equal(context.readRoute("/eval/runs/run-123").runId, "run-123");
assert.equal(context.readRoute("/eval/runs/run%20one/").runId, "run one");
assert.equal(context.readRoute("/eval/special/suite-1").suiteId, "suite-1");
assert.equal(context.readRoute("/eval/regression/set-1").setId, "set-1");

const server = await createServer({
  root: new URL("../", import.meta.url).pathname,
  server: { middlewareMode: true, ws: false },
});
try {
  const { default: Evaluation } = await server.ssrLoadModule(
    "/src/Evaluation.tsx",
  );
  const props = {
    section: "history",
    onNavigate() {},
    onToast() {},
    Diagnostics: () => null,
  };
  const list = renderToStaticMarkup(React.createElement(Evaluation, props));
  const detail = renderToStaticMarkup(
    React.createElement(Evaluation, { ...props, runId: "run-123" }),
  );
  assert.ok(list.includes('class="ev-launch"'));
  assert.ok(!detail.includes('class="ev-launch"'));
  assert.ok(detail.includes("返回历次记录"));
  console.log("Evaluation route and layout checks passed.");
} finally {
  await server.close();
}
