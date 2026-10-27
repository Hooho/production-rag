import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), "detail-dialog-"));
const entry = path.join(work, "entry.tsx");
await writeFile(entry, `
import React, { useState } from ${JSON.stringify(path.join(root, "node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(path.join(root, "node_modules/react-dom/client.js"))};
import { DetailDialog } from ${JSON.stringify(path.join(root, "src/DetailDialog.tsx"))};
function Demo() {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  return <><DetailDialog open={open} title="主弹窗" onClose={() => setOpen(false)}>
    <button onClick={() => setValue("分片 A")}>选择 A</button>
    <button onClick={() => setValue("分片 B")}>选择 B</button>
    <button onClick={() => setOther(true)}>另一个入口</button>
    <p>主弹窗空白内容</p>
    <DetailDialog open={value !== null} title={value ?? "原文"} onClose={() => setValue(null)}><p>分片内容</p></DetailDialog>
    <DetailDialog open={other} title="其他预览" onClose={() => setOther(false)}><p>其他内容</p></DetailDialog>
  </DetailDialog></>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
`);
await build({ root, define: { "process.env.NODE_ENV": JSON.stringify("production") }, resolve: { alias: { "react/jsx-runtime": path.join(root, "node_modules/react/jsx-runtime.js") } }, logLevel: "silent", build: { outDir: path.join(work, "dist"), emptyOutDir: false, lib: { entry, name: "DialogTest", formats: ["iife"], fileName: () => "test.js" } } });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => (errors.push(error.message), console.error(error.message)));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ path: path.join(work, "dist", "production-rag-console.css") });
  await page.addScriptTag({ path: path.join(work, "dist", "test.js") });
  await page.getByRole("button", { name: "选择 A" }).click();
  await page.locator('dialog[aria-label="分片 A"]:popover-open').waitFor();
  assert.equal(await page.locator("dialog:modal").count(), 1);
  await page.getByText("分片内容", { exact: true }).click();
  assert.equal(await page.locator(":popover-open").count(), 1);
  await page.getByText("主弹窗空白内容", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(":popover-open"));
  assert.equal(await page.locator("dialog:modal").count(), 1);
  await page.getByRole("button", { name: "选择 A" }).click();
  await page.locator('dialog[aria-label="分片 A"]:popover-open').waitFor();
  await page.getByRole("button", { name: "选择 B" }).click();
  await page.locator('dialog[aria-label="分片 B"]:popover-open').waitFor();
  assert.equal(await page.locator(":popover-open").count(), 1);
  await page.getByRole("button", { name: "另一个入口" }).click();
  await page.locator('dialog[aria-label="其他预览"]:popover-open').waitFor();
  await page.waitForFunction(() => document.querySelectorAll(":popover-open").length === 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(":popover-open"));
  assert.equal(await page.locator("dialog:modal").count(), 1);
  await page.getByRole("button", { name: "选择 A" }).click();
  await page.locator('dialog[aria-label="分片 A"]:popover-open').waitFor();
  await page.getByRole("dialog", { name: "主弹窗", exact: true }).getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector(":popover-open") && !document.querySelector("dialog:modal"));
  assert.deepEqual(errors, []);
  console.log("Outside dismissal, inside clicks, switching, Escape, and parent close checks passed.");
} finally { await browser.close(); }
