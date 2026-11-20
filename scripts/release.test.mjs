import test from "node:test";
import assert from "node:assert/strict";
import {
  validVersion,
  compare,
  nextVersions,
  blockedPaths,
  verifyReport,
} from "./release.mjs";

test("stable versions reject prereleases and leading zeros", () => {
  for (const v of ["1.0.0", "0.1.2"]) assert.ok(validVersion(v));
  for (const v of ["01.0.0", "1.0", "v1.0.0", "1.0.0-rc.1", "1.0.0\n"])
    assert.equal(validVersion(v), false);
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.deepEqual(nextVersions("1.2.3", false), ["1.2.4", "1.3.0", "2.0.0"]);
  assert.deepEqual(nextVersions("0.1.0", true), ["1.0.0"]);
});
test("archive excludes sensitive runtime files but keeps env example", () => {
  assert.deepEqual(
    blockedPaths([
      ".env",
      ".env.prod",
      "uploads/a",
      "x/node_modules/a",
      "secret.pem",
      "data.sql",
      ".env.example",
      "app/main.py",
    ]),
    [
      ".env",
      ".env.prod",
      "uploads/a",
      "x/node_modules/a",
      "secret.pem",
      "data.sql",
    ],
  );
});
test("release requires executed tests without skips or failures", () => {
  verifyReport(
    '<testsuites><testsuite tests="2" errors="0" failures="0" skipped="0"></testsuite></testsuites>',
  );
  for (const xml of [
    "",
    '<testsuite tests="0"/>',
    '<testsuite tests="2" skipped="1"/>',
    '<testsuite tests="2" failures="1"/>',
    '<testsuite tests="2" errors="1"/>',
  ])
    assert.throws(() => verifyReport(xml));
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pack } from "./release.mjs";

test("archive uses Git tree, verifies contents and never overwrites output", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-archive-test-"));
  const exec = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  exec("init", "-b", "main");
  mkdirSync(join(dir, "frontend"));
  for (const p of [
    "compose.yaml",
    ".env.example",
    "Dockerfile",
    "frontend/Dockerfile",
    "CHANGELOG.md",
  ])
    writeFileSync(join(dir, p), "example\n");
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  exec("add", ".");
  const tree = exec("write-tree");
  writeFileSync(join(dir, ".env"), "secret");
  const output = join(dir, "output");
  mkdirSync(output);
  const archive = pack(dir, tree, output, "production-rag-1.0.0", "1.0.0");
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.equal(
    readFileSync(join(output, "SHA256SUMS"), "utf8"),
    `${sum}  production-rag-1.0.0.tar.gz\n`,
  );
  assert.throws(
    () => pack(dir, tree, output, "production-rag-1.0.0", "1.0.0"),
    /拒绝覆盖/,
  );
  const wrong = join(dir, "wrong");
  mkdirSync(wrong);
  assert.throws(() => pack(dir, tree, wrong, "wrong", "2.0.0"), /版本不一致/);
  exec("add", ".env");
  const unsafe = exec("write-tree");
  assert.throws(() => pack(dir, unsafe, output, "unsafe", "1.0.0"), /禁止打包/);
});

import { githubRepository } from "./release.mjs";
test("release repository is derived from origin, not gh environment defaults", () => {
  assert.equal(
    githubRepository("https://github.com/Hooho/production-rag.git"),
    "Hooho/production-rag",
  );
  assert.equal(
    githubRepository("git@github.com:Hooho/production-rag.git"),
    "Hooho/production-rag",
  );
  assert.throws(() => githubRepository("https://example.com/user/repo"));
  assert.throws(() => githubRepository("https://github.com/user/repo/extra"));
});

import { copyFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";

for (const failing of [false, true]) {
  test(
    `preview orchestration with simulated dependencies: ${failing ? "test failure leaves source unchanged" : "successful archive leaves source unchanged"}`,
    { timeout: 30000 },
    async () => {
      const base = mkdtempSync(join(tmpdir(), "release-flow-test-"));
      const source = join(base, "repo");
      mkdirSync(source);
      const git = (...args) => {
        const r = spawnSync("git", args, { cwd: source, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
      };
      git("init", "-b", "main");
      git("config", "user.name", "Release Test");
      git("config", "user.email", "release@example.invalid");
      mkdirSync(join(source, "scripts"));
      mkdirSync(join(source, "frontend"));
      mkdirSync(join(source, "frontend/tests"));
      copyFileSync(
        new URL("./release.mjs", import.meta.url),
        join(source, "scripts/release.mjs"),
      );
      writeFileSync(
        join(source, "scripts/release.test.mjs"),
        "import assert from 'node:assert/strict'; assert.ok(true);\n",
      );
      writeFileSync(
        join(source, "frontend/tests/example.test.mjs"),
        "import assert from 'node:assert/strict'; assert.ok(true);\n",
      );
      for (const p of [
        "compose.yaml",
        ".env.example",
        "Dockerfile",
        "frontend/Dockerfile",
      ])
        writeFileSync(join(source, p), "example\n");
      writeFileSync(join(source, "VERSION"), "0.1.0\n");
      writeFileSync(join(source, "CHANGELOG.md"), "# Changelog\n");
      writeFileSync(
        join(source, "frontend/package.json"),
        JSON.stringify({ version: "0.1.0" }),
      );
      writeFileSync(
        join(source, "frontend/package-lock.json"),
        JSON.stringify({
          version: "0.1.0",
          packages: { "": { version: "0.1.0" } },
        }),
      );
      git("add", ".");
      git("commit", "-m", "baseline");
      const head = git("rev-parse", "HEAD");
      const remote = join(base, "remote.git");
      git("clone", "--bare", source, remote);
      git("remote", "add", "origin", remote);
      const bin = join(base, "bin");
      mkdirSync(bin);
      const npm = join(bin, "npm");
      writeFileSync(npm, "#!/usr/bin/env node\nprocess.exit(0);\n");
      chmodSync(npm, 0o755);
      const python = join(bin, "python");
      writeFileSync(
        python,
        `#!/usr/bin/env node\nimport('node:fs').then(fs => {const file=process.argv.find(a=>a.startsWith('--junitxml=')).slice(11); fs.writeFileSync(file,'<testsuite tests="1" failures="${failing ? 1 : 0}" errors="0" skipped="0"/>'); process.exit(${failing ? 1 : 0});});\n`,
      );
      chmodSync(python, 0o755);
      const preload = join(base, "tty.mjs");
      writeFileSync(
        preload,
        "Object.defineProperty(process.stdin,'isTTY',{value:true}); process.stdin.setRawMode = () => {};\n",
      );
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(
        process.execPath,
        ["--import", preload, join(source, "scripts/release.mjs")],
        {
          cwd: source,
          env: {
            ...childEnv,
            PATH: `${bin}:${process.env.PATH}`,
            RELEASE_PYTHON: python,
          },
        },
      );
      let output = "";
      let promptCount = 0;
      child.stdout.on("data", (data) => {
        output += data;
        const count = [...output.matchAll(/（↑↓ 选择，回车确认）/g)].length;
        while (promptCount < count) {
          child.stdin.write(
            ["\r", "\r", "\x1b[B\r", "\x1b[B\r"][promptCount++],
          );
        }
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(code, failing ? 1 : 0, output);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(git("tag", "--list"), "");
      assert.equal(readFileSync(join(source, "VERSION"), "utf8"), "0.1.0\n");
      assert.equal(
        readFileSync(join(source, "CHANGELOG.md"), "utf8"),
        "# Changelog\n",
      );
      assert.match(output, failing ? /检查失败/ : /预览完成/);
    },
  );
}
