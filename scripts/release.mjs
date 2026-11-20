import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

export function githubRepository(remote) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (!match) throw new Error("仅支持 github.com 的 HTTPS 或 SSH origin 地址");
  return match[1];
}
export function validVersion(v) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
}
export function compare(a, b) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}
export function nextVersions(v, first) {
  if (first) return ["1.0.0"];
  const [a, b, c] = v.split(".").map(Number);
  return [`${a}.${b}.${c + 1}`, `${a}.${b + 1}.0`, `${a + 1}.0.0`];
}
export function blockedPaths(paths) {
  return paths.filter((p) =>
    /(^|\/)(\.env(?!\.example$)[^/]*|node_modules|uploads|\.venv|\.git|id_rsa|id_ed25519)(\/|$)|\.(pem|key|p12|sql|sqlite3?)$/i.test(
      p,
    ),
  );
}
export function verifyReport(xml) {
  const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
  if (
    !suites.length ||
    suites.some((s) => /(?:failures|errors|skipped)="[1-9]\d*"/.test(s)) ||
    !suites.some((s) => /tests="[1-9]\d*"/.test(s))
  )
    throw new Error("后端测试失败、被跳过或未收集到测试");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(cmd, args = [], cwd = root, options = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")}\n${r.error?.message || r.stderr || r.stdout || `退出码 ${r.status}`}`,
    );
  return (r.stdout || "").trim();
}
const git = (...args) => run("git", args);
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
function clean() {
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("工作区有未提交改动，请先处理");
}
function remoteCheck(expected) {
  const remote = git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
  if (remote !== expected)
    throw new Error("远端 main 与发布基准不一致，请先同步后重新验证");
}
function versions(cwd) {
  const v = read(join(cwd, "VERSION")).trim();
  const pkg = json(join(cwd, "frontend/package.json"));
  const lock = json(join(cwd, "frontend/package-lock.json"));
  if (
    !validVersion(v) ||
    pkg.version !== v ||
    lock.version !== v ||
    lock.packages[""].version !== v
  )
    throw new Error("VERSION 与前端版本不一致");
  return v;
}
function checkFiles(cwd, paths) {
  const blocked = blockedPaths(paths);
  if (blocked.length) throw new Error(`禁止打包的文件：${blocked.join(", ")}`);
  for (const p of paths) {
    const mode = run("git", ["ls-files", "-s", "--", p], cwd).split(" ")[0];
    if (mode === "120000" || mode === "160000")
      throw new Error(`发布暂不支持符号链接或子模块：${p}`);
    const content = readFileSync(join(cwd, p)).toString("utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}/.test(
        content,
      )
    )
      throw new Error(`发现疑似凭证：${p}`);
  }
  for (const p of [
    "compose.yaml",
    ".env.example",
    "Dockerfile",
    "frontend/Dockerfile",
    "VERSION",
    "CHANGELOG.md",
  ])
    if (!paths.includes(p)) throw new Error(`缺少运行文件：${p}`);
}
export function pack(cwd, ref, output, name, version) {
  const paths = run("git", ["ls-tree", "-r", "--name-only", "-z", ref], cwd)
    .split("\0")
    .filter(Boolean);
  checkFiles(cwd, paths);
  const archive = join(output, `${name}.tar.gz`);
  if (existsSync(archive)) throw new Error(`拒绝覆盖 ${archive}`);
  run(
    "git",
    [
      "archive",
      "--format=tar.gz",
      `--prefix=${name}/`,
      `--output=${archive}`,
      ref,
    ],
    cwd,
  );
  const entries = run("tar", ["-tzf", archive])
    .split("\n")
    .filter((p) => !p.endsWith("/"));
  if (
    entries.length !== paths.length ||
    paths.some((p) => !entries.includes(`${name}/${p}`))
  )
    throw new Error("压缩包文件清单不一致");
  if (run("tar", ["-xOzf", archive, `${name}/VERSION`]) !== version)
    throw new Error("压缩包版本不一致");
  const sum = `${hash(archive)}  ${name}.tar.gz\n`;
  writeFileSync(join(output, "SHA256SUMS"), sum);
  if (read(join(output, "SHA256SUMS")) !== `${hash(archive)}  ${name}.tar.gz\n`)
    throw new Error("校验和不一致");
  return archive;
}
export function preparePython(source, cache, execute = run) {
  const requirements = ["requirements.txt", "requirements-test.txt"];
  const fingerprint = createHash("sha256")
    .update(requirements.map((p) => read(join(source, p))).join("\n"))
    .digest("hex");
  const python = join(cache, "bin", "python");
  const marker = join(cache, "release-requirements.sha256");
  if (!existsSync(python)) {
    console.log("初始化发布测试环境（Python 3.11）");
    let systemPython = false;
    try {
      execute("python3.11", ["--version"]);
      systemPython = true;
    } catch {}
    if (systemPython) {
      execute("python3.11", ["-m", "venv", cache]);
    } else {
      console.log("未找到 Python 3.11，使用 uv 自动下载并创建测试环境");
      execute("uv", ["venv", "--python", "3.11", "--seed", cache], source, {
        timeout: 900_000,
        stdio: "inherit",
      });
    }
  }
  let healthy = false;
  try {
    execute(python, ["-c", "import pytest"]);
    execute(python, ["-m", "pip", "check"]);
    healthy = true;
  } catch {}
  if (!healthy || !existsSync(marker) || read(marker) !== fingerprint) {
    console.log("安装或更新发布测试依赖（后续发布复用）");
    execute(
      python,
      ["-m", "pip", "install", "-r", join(source, "requirements-test.txt")],
      source,
      { timeout: 900_000, stdio: "inherit" },
    );
    execute(python, ["-m", "pip", "check"]);
    execute(python, ["-c", "import pytest"]);
    writeFileSync(marker, fingerprint);
  }
  return python;
}

async function main() {
  if (compare(process.versions.node, "22.18.0") < 0)
    throw new Error("需要 Node.js 22.18.0 或以上");
  if (!process.stdin.isTTY) throw new Error("请在交互终端运行 npm run release");
  const ask = async (q) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await rl.question(`${q} `)).trim();
    } finally {
      rl.close();
    }
  };
  const choice = async (title, labels, fallback = 0) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let selected = fallback;
    console.log(`\n${title}（↑↓ 选择，回车确认）`);
    const render = () =>
      output.write(
        labels
          .map((label, i) => `\x1b[2K${i === selected ? "❯" : " "} ${label}\n`)
          .join(""),
      );
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    render();
    try {
      return await new Promise((resolveChoice, reject) => {
        const onKey = (_text, key = {}) => {
          if (key.name === "return" || (key.ctrl && key.name === "c")) {
            input.removeListener("keypress", onKey);
            if (key.ctrl) reject(new Error("已取消操作"));
            else resolveChoice(selected);
            return;
          }
          if (key.name !== "up" && key.name !== "down") return;
          selected =
            (selected + (key.name === "up" ? -1 : 1) + labels.length) %
            labels.length;
          output.write(`\x1b[${labels.length}A`);
          render();
        };
        input.on("keypress", onKey);
      });
    } finally {
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\x1b[?25h");
    }
  };
  const yes = async (q) => (await choice(q, ["取消", "确认执行"])) === 1;
  let stateFile;
  let lockFile;
  const stop = () => {
    if (lockFile) {
      unlinkSync(lockFile);
      lockFile = undefined;
    }
    console.error(
      "发布已中断。临时文件和已创建的发布记录保留，可重新运行检查恢复。",
    );
    process.exit(130);
  };
  process.once("SIGINT", stop);
  try {
    run("node", ["--version"]);

    if (git("branch", "--show-current") !== "main")
      throw new Error("正式发布和预览都请在 main 独立工作目录中运行");
    const stateDir = git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "release-state",
    );
    mkdirSync(stateDir, { recursive: true });
    const lock = join(stateDir, "active.lock");
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch {
      throw new Error(
        `已有发布进程或遗留锁：${lock}。确认没有运行中的发布后再处理该文件。`,
      );
    }
    closeSync(fd);
    lockFile = lock;
    const pending = readdirSync(stateDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ file: join(stateDir, n), ...json(join(stateDir, n)) }))
      .filter((s) => !s.complete);
    const mode = await choice("选择操作", [
      "预览打包（不修改项目）",
      "发布版本号到 GitHub（不测试、不打包）",
      ...(pending.length ? ["继续未完成的发布"] : []),
    ]);
    const publish = mode !== 0;
    if (publish) {
      git("var", "GIT_AUTHOR_IDENT");
      git("var", "GIT_COMMITTER_IDENT");
    }
    if (mode === 2) {
      const index = await choice(
        "选择待恢复版本",
        pending.map((s) => `${s.version}：${s.stage}`),
      );
      const s = pending[index];
      stateFile = s.file;
      if (!(await yes(`继续 ${s.tag}，当前阶段 ${s.stage}？`))) return;
      await finish(s, stateFile);
      return;
    }
    clean();
    const base = git("rev-parse", "HEAD");
    if (publish) {
      console.log("检查远端 main 与本地提交是否一致…");
      remoteCheck(base);
    }
    const current = versions(root);
    const tags = git("tag", "--list")
      .split("\n")
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
      .sort((a, b) => compare(a.slice(1), b.slice(1)));
    const previous = tags.at(-1);
    if (
      previous &&
      (previous !== `v${current}` ||
        git("merge-base", "--is-ancestor", previous, "HEAD") !== "")
    )
      throw new Error("当前版本与最后正式标签不一致");
    const options = nextVersions(current, !previous);
    let version;
    for (;;) {
      const i = await choice(`当前版本 ${current}，选择发布版本`, [
        ...options.map(
          (v, i) =>
            `${[options.length === 1 ? "首次正式发布" : "修复版本", "功能版本", "大版本"][i]} → ${v}`,
        ),
        "自定义",
      ]);
      version = i === options.length ? await ask("版本号：") : options[i];
      if (
        validVersion(version) &&
        compare(version, current) > 0 &&
        !git("tag", "--list", `v${version}`)
      )
        break;
      console.log("版本格式错误、未递增或标签已存在，请重选");
    }
    if (
      publish &&
      git(
        "ls-remote",
        "origin",
        `refs/tags/v${version}`,
        `refs/tags/v${version}^{}`,
      )
    )
      throw new Error("远端已有该版本标签");
    const temp = mkdtempSync(join(tmpdir(), "prod-rag-release-"));
    console.log(`临时目录和日志保留在 ${temp}`);
    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    let notes = `## ${version} - ${date}\n\n`;
    if (!previous)
      notes +=
        "### 新增\n\n- 文档导入、解析、分片、版本管理、审核上架与安全扫描。\n- 向量和关键词混合检索、查询改写、重排、引用与处理过程诊断。\n- LangGraph Agent、工具调用、多轮检索、会话记忆与长期记忆。\n- 检索评测、Agent 对比、多配置批量评测、证据诊断与知识巡检。\n- 用户、部门、文档权限、三层输入安全检查与系统管理。\n";
    else {
      const subjects = git("log", "--format=%s", `${previous}..HEAD`)
        .split("\n")
        .filter(
          (s) =>
            !/^(docs|style|chore|refactor|test|build|ci)(\(|:)|^(文案|格式)/i.test(
              s,
            ),
        );
      for (const [heading, pattern] of [
        ["新增", /^feat(?:\([^)]*\))?:/],
        ["修复", /^fix(?:\([^)]*\))?:/],
        ["改进", /^(?!feat(?:\([^)]*\))?:|fix(?:\([^)]*\))?:)/],
      ]) {
        const group = subjects.filter((s) => pattern.test(s));
        if (group.length)
          notes += `### ${heading}\n\n${group.map((s) => `- ${s}`).join("\n")}\n\n`;
      }
    }
    const notesFile = join(temp, "notes.md");
    writeFileSync(notesFile, notes);
    for (;;) {
      notes = read(notesFile);
      console.log(`\n本次 changelog：\n${notes}`);
      const c = await choice("确认 changelog", [
        "取消",
        "确认，继续",
        "打开编辑器",
      ]);
      if (c === 0) return;
      if (c === 2) {
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        if (!/^[\w/.-]+$/.test(editor)) {
          console.log("EDITOR/VISUAL 请设置为单个可执行文件路径");
          continue;
        }
        try {
          run(editor, [notesFile], root, { stdio: "inherit", timeout: 0 });
        } catch (e) {
          console.log(e.message);
        }
      } else if (notes.startsWith(`## ${version} - `) && /^- \S/m.test(notes))
        break;
      else console.log("请保留版本标题，并填写至少一条更新内容");
    }
    if (
      previous &&
      Number(version.split(".")[0]) > Number(current.split(".")[0]) &&
      !/### 不兼容变更与升级说明\s+\S/.test(notes)
    )
      throw new Error("大版本必须在 changelog 填写“### 不兼容变更与升级说明”");
    const candidate = join(temp, "source");
    run("git", ["clone", "--no-hardlinks", "--no-checkout", root, candidate]);
    run("git", ["checkout", "--detach", base], candidate);
    const changed = [
      "VERSION",
      "frontend/package.json",
      "frontend/package-lock.json",
      "CHANGELOG.md",
    ];
    writeFileSync(join(candidate, "VERSION"), `${version}\n`);
    for (const p of changed.slice(1, 3)) {
      const data = json(join(candidate, p));
      data.version = version;
      if (data.packages?.[""]) data.packages[""].version = version;
      writeFileSync(join(candidate, p), `${JSON.stringify(data, null, 2)}\n`);
    }
    writeFileSync(
      join(candidate, "CHANGELOG.md"),
      `# Changelog\n\n${notes.trim()}\n\n${read(join(root, "CHANGELOG.md")).replace(/^# Changelog\s*/, "")}`,
    );
    versions(candidate);
    const log = join(temp, "checks.log");
    writeFileSync(log, "");
    const check = (cmd, args) => {
      console.log(`检查：${cmd} ${args.join(" ")}`);
      const r = spawnSync(cmd, args, {
        cwd: candidate,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 900_000,
      });
      writeFileSync(
        log,
        `${read(log)}\n$ ${cmd} ${args.join(" ")}\n${r.stdout || ""}${r.stderr || ""}${r.error || ""}`,
      );
      if (r.error || r.status !== 0) throw new Error(`检查失败，日志：${log}`);
      return r.stdout || "";
    };
    const skipChecks =
      publish ||
      (await choice("打包检查方式", [
        "运行测试和构建后打包",
        "跳过测试和构建，直接打包源码",
      ])) === 1;
    if (!skipChecks) {
      check(process.execPath, ["--test", "scripts/release.test.mjs"]);
      const python =
        process.env.RELEASE_PYTHON ||
        preparePython(candidate, join(stateDir, "python-env"));
      check(python, [
        "-m",
        "pytest",
        "tests",
        `--junitxml=${join(temp, "pytest.xml")}`,
      ]);
      verifyReport(read(join(temp, "pytest.xml")));
      check("npm", ["ci", "--prefix", "frontend"]);
      const frontendTests = readdirSync(join(candidate, "frontend/tests"))
        .filter((n) => /\.test\.(mjs|cjs|js)$/.test(n))
        .sort();
      if (!frontendTests.length) throw new Error("未找到前端测试");
      const tap = check(process.execPath, [
        "--test",
        "--test-reporter=tap",
        ...frontendTests.map((n) => `frontend/tests/${n}`),
      ]);
      if (
        !/# tests [1-9]\d*/.test(tap) ||
        !/# skipped 0(?:\r?\n|$)/.test(tap) ||
        !/# todo 0(?:\r?\n|$)/.test(tap)
      )
        throw new Error("前端测试被跳过或没有实际运行");
      check("npm", ["run", "build", "--prefix", "frontend"]);
    } else {
      writeFileSync(log, "用户选择跳过测试和构建，仅执行源码打包检查。\n");
    }
    run("git", ["add", "--", ...changed], candidate);
    if (run("git", ["diff"], candidate))
      throw new Error("检查改变了源码，请处理后重新验证");
    const tree = run("git", ["write-tree"], candidate);
    const paths = run("git", ["ls-files", "-z"], candidate)
      .split("\0")
      .filter(Boolean);
    if (!publish) checkFiles(candidate, paths);
    console.log(
      `\n最终清单\n版本：${version}\n标签：v${version}\n基准：main ${base}\n修改：${changed.join(", ")}\n目标：${git("remote", "get-url", "origin")}\n方式：${publish ? "仅更新版本并推送 main 和 Git 标签" : "仅生成 preview 包"}\n输出：${temp}\n测试及构建：${skipChecks ? "已跳过（未经测试和构建验证）" : "全部通过，无后端测试跳过"}\n${notes}`,
    );
    if (!(await yes("确认执行？"))) return;
    clean();
    if (git("rev-parse", "HEAD") !== base)
      throw new Error("基准提交已变化，请重新验证");
    if (publish) remoteCheck(base);
    if (!publish) {
      pack(candidate, tree, temp, `production-rag-${version}-preview`, version);
      console.log(`预览完成：${temp}`);
      return;
    }
    const origin = git("remote", "get-url", "origin");
    const repo = githubRepository(origin);
    const s = {
      versionOnly: true,
      origin,
      notesHash: hash(notesFile),
      version,
      tag: `v${version}`,
      base,
      tree,
      temp,
      notesFile,
      changed,
      repo,
      stage: "prepared",
    };
    stateFile = join(stateDir, `${version}.json`);
    if (existsSync(stateFile)) throw new Error("已有发布状态，请使用继续发布");
    writeFileSync(stateFile, JSON.stringify(s, null, 2));
    await finish(s, stateFile, candidate);
  } finally {
    process.removeListener("SIGINT", stop);
    if (lockFile) unlinkSync(lockFile);
  }
}
async function finish(s, file, candidate) {
  const save = (stage) => {
    s.stage = stage;
    writeFileSync(file, JSON.stringify(s, null, 2));
  };
  if (git("remote", "get-url", "origin") !== s.origin)
    throw new Error("远端地址已变化，停止发布");
  if (hash(s.notesFile) !== s.notesHash)
    throw new Error("发布说明已变化，请重新验证");
  const localHead = git("rev-parse", "HEAD");
  if (!s.commit) {
    if (localHead !== s.base) {
      if (
        git("rev-parse", "HEAD^{tree}") !== s.tree ||
        git("rev-parse", "HEAD^") !== s.base ||
        git("log", "-1", "--format=%s") !== `chore(release): ${s.tag}`
      )
        throw new Error("发布状态与当前提交不符，请人工检查");
    } else {
      remoteCheck(s.base);
      if (s.stage === "files-written") {
        if (
          git("diff") ||
          git("ls-files", "--others", "--exclude-standard") ||
          git("write-tree") !== s.tree
        )
          throw new Error("现场内容与已验证版本不同，请人工检查");
      } else {
        candidate ||= join(s.temp, "source");
        if (
          run("git", ["write-tree"], candidate) !== s.tree ||
          run("git", ["diff"], candidate)
        )
          throw new Error("临时目录内容已变化");
        clean();
        for (const p of s.changed)
          writeFileSync(join(root, p), readFileSync(join(candidate, p)));
        git("add", "--", ...s.changed);
        save("files-written");
      }
      git("commit", "-m", `chore(release): ${s.tag}`);
    }
    if (git("rev-parse", "HEAD^{tree}") !== s.tree)
      throw new Error("提交钩子改变了已验证内容，请重新验证，停止发布");
    s.commit = git("rev-parse", "HEAD");
    save("committed");
  }
  clean();
  if (
    git("rev-parse", "HEAD") !== s.commit ||
    git("rev-parse", `${s.commit}^{tree}`) !== s.tree
  )
    throw new Error("发布提交已变化");
  if (git("tag", "--list", s.tag)) {
    if (git("rev-list", "-1", s.tag) !== s.commit)
      throw new Error("标签指向其他提交，拒绝覆盖");
  } else git("tag", "-a", s.tag, "-m", `Release ${s.tag}`, s.commit);
  save("tagged");
  const name = `production-rag-${s.version}`;
  const archive = join(s.temp, `${name}.tar.gz`);
  if (!s.versionOnly) {
    if (!existsSync(archive)) pack(root, s.tag, s.temp, name, s.version);
    else if (
      !existsSync(join(s.temp, "SHA256SUMS")) ||
      read(join(s.temp, "SHA256SUMS")) !== `${hash(archive)}  ${name}.tar.gz\n`
    )
      throw new Error("已有发布包校验失败，拒绝覆盖");
    save("packed");
  }
  const remote = git(
    "ls-remote",
    "origin",
    "refs/heads/main",
    `refs/tags/${s.tag}`,
    `refs/tags/${s.tag}^{}`,
  );
  const refs = new Map(
    remote
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [a, b] = l.split(/\s+/);
        return [b, a];
      }),
  );
  const remoteMain = refs.get("refs/heads/main");
  const remoteTag =
    refs.get(`refs/tags/${s.tag}^{}`) || refs.get(`refs/tags/${s.tag}`);
  if (remoteTag && remoteTag !== s.commit) throw new Error("远端标签冲突");
  if (remoteMain !== s.base && remoteMain !== s.commit)
    throw new Error("远端 main 已变化，停止推送");
  if (remoteMain !== s.commit || !remoteTag)
    git(
      "push",
      "--atomic",
      "origin",
      `${s.commit}:refs/heads/main`,
      `refs/tags/${s.tag}:refs/tags/${s.tag}`,
    );
  save("pushed");
  s.complete = true;
  save("complete");
  console.log(
    `发布完成：${s.tag}\n提交：${s.commit}\n${s.versionOnly ? "仅发布版本号，无打包附件" : `附件：${s.temp}`}\nhttps://github.com/${s.repo}/tree/${s.tag}`,
  );
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(
      `\n发布停止：${e.message}\n最终确认前项目不变；确认后请检查发布状态，禁止覆盖标签。`,
    );
    process.exitCode = 1;
  });
}
