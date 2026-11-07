import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  checkAction,
  decideCheck,
  getCheckDetail,
  getLLMSettings,
  startCheck,
  type LLMProfile,
  type CheckJudgment,
  type CheckReport,
  type CheckStepName,
} from "./api";
import { ConfirmPopover } from "./ConfirmPopover";
import { DetailDialog } from "./DetailDialog";
import { VerticalSteps, type CheckStep } from "./GraphCheckSteps";
import { formatShortTime } from "./format";
import { Tag } from "./Tag";
import { errorText, useToast } from "./Toast";

// 图谱检查前 4 步（补抽、关系核对、类型核对、拆分）共用的页面：
// 左边竖直小步骤：找出可疑项 → AI 判断 → 逐条决定 → 确认写入；右边是这一小步的内容。

type Item = Record<string, unknown> & { id: string };
type ShowOriginal = (title: string, body: string) => void;
const PAGE_SIZE = 20;
type Decision = NonNullable<CheckReport["decisions"]>[string];

export const CHECK_INFO: Record<
  CheckStepName,
  {
    title: string;
    hint: string;
    example: string;
    accept: string;
    reject: string;
  }
> = {
  glean: {
    title: "补抽",
    hint: "补抽漏掉的实体和关系：把【分片原文和已经抽出的】一起交给 AI，让它只补漏掉的。",
    example:
      "原文「段永平 2002 年买入了网易的股票」，建图时只抽出了「段永平」。AI 补抽后补上实体「网易」，和关系「段永平 → 买入 → 网易」。",
    accept: "采纳补抽",
    reject: "不补",
  },
  relation: {
    title: "关系核对",
    hint: "核对关系：原文引用能不能在分片里找到；可疑的交给 AI 看整片原文，判断原文是否支持这条关系。",
    example:
      "关系「段永平 → 投资 → 腾讯」的原文引用是「腾讯的用户黏性很强」：这句话在原文里找得到，但没说段永平投资腾讯。AI 判断「原文不支持」，建议删除。",
    accept: "删除这条关系",
    reject: "保留",
  },
  type: {
    title: "类型核对",
    hint: "核对类型：同一个名字被抽成了不同类型，或者类型不在清单里。",
    example:
      "「腾讯」在 1 片里被抽成「产品」，在另外 5 片里是「组织」。AI 看原文后建议统一成「组织」。",
    accept: "改类型",
    reject: "不改",
  },
  split: {
    title: "拆分",
    hint: "拆开错误的合并：同一个实体下的名字其实指不同的东西（用向量找出），改名拆开。",
    example:
      "「苹果」下面，有几处说的是「段永平长期持有的公司」，有几处说的是「一种水果，用来打比方」。AI 建议把水果那几处拆出去，改名「苹果（水果）」。",
    accept: "按建议拆分",
    reject: "不拆",
  },
};

const REASONS: Record<string, string> = {
  no_evidence: "没写原文引用",
  not_found: "引用在原文里找不到",
  context_only: "引用只在标题或上下文说明里",
  name_not_in_chunk: "起点或终点不在这片原文里",
  name_not_in_quote: "引用里没提到起点或终点（只作提示）",
  sampled: "抽查",
};

const VERDICTS: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" }
> = {
  supported: { label: "原文支持", tone: "success" },
  partial: { label: "部分支持", tone: "warning" },
  unsupported: { label: "原文不支持", tone: "danger" },
};

const ACTIVE = ["queued", "running", "rewriting"];
const loadingClass = (on: boolean) => (on ? " is-loading" : "");

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// 打开时停在哪一小步。
function defaultSub(report: CheckReport | null) {
  if (!report?.items || report.status === "scanned") return 1;
  if (["queued", "running", "stopped"].includes(report.status)) return 2;
  const decisions = report.decisions ?? {};
  const pending = report.items.filter(
    (item) =>
      report.judgments?.[item.id]?.decision?.suggest && !decisions[item.id],
  ).length;
  return pending > 0 ? 3 : 4;
}

export function GraphCheckStep({
  documentId,
  step,
  onChanged,
}: {
  documentId: string;
  step: CheckStepName;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const info = CHECK_INFO[step];
  const [data, setData] = useState<Awaited<
    ReturnType<typeof getCheckDetail>
  > | null>(null);
  const [poll, setPoll] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const [sub, setSub] = useState<number | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [page, setPage] = useState(1);
  const [original, setOriginal] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const showOriginal: ShowOriginal = (title, body) =>
    setOriginal({ title, body });
  const [scope, setScope] = useState<"few" | "all">("few");
  const [sample, setSample] = useState(0);
  // 检查用的模型：空 = 和建图时一样。
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [provider, setProvider] = useState("");
  useEffect(() => {
    getLLMSettings()
      .then((value) => setProfiles(value?.profiles ?? []))
      .catch(() => undefined);
  }, []);
  const [now, setNow] = useState(() => Date.now());
  const busy = action !== null;
  const report = data?.report ?? null;
  const active = !!report && ACTIVE.includes(report.status);

  useEffect(() => {
    let cancelled = false;
    getCheckDetail(documentId, step)
      .then((value) => !cancelled && setData(value))
      .catch((reason) => !cancelled && toast("error", errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, [documentId, step, poll]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setPoll((value) => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [active, poll]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => setSub(null), [step]);
  useEffect(() => setPage(1), [sub, filter]);
  useEffect(() => {
    if (sub === null && data) setSub(defaultSub(report));
  }, [data, sub, report]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) onChanged?.();
    wasActive.current = active;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(
    name: string,
    task: () => Promise<unknown>,
    done?: string,
  ) {
    if (busy || !data?.build_id) return;
    setAction(name);
    try {
      await task();
      if (done) toast("success", done);
      setData(await getCheckDetail(documentId, step));
      onChanged?.();
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setAction(null);
    }
  }
  const buildId = data?.build_id ?? "";
  const canEdit = !!data?.can_confirm;
  const start = () =>
    run(
      "start",
      async () => {
        const profile = profiles.find((item) => item.provider === provider);
        await startCheck(documentId, step, buildId, {
          ...(step === "glean" ? { scope } : {}),
          ...(step === "relation" && sample > 0 ? { sample } : {}),
          ...(profile
            ? { llm: { provider: profile.provider, model: profile.model } }
            : {}),
        });
        setSub(1);
      },
      "已开始找可疑项（不调用模型），找完会列出来",
    );
  const act = (
    name: "judge" | "stop" | "write" | "skip" | "retry-failed" | "rejudge",
    done: string,
  ) => run(name, () => checkAction(documentId, step, name, buildId), done);
  const decide = (
    ids: string[],
    decision: "accept" | "reject" | null,
    edit?: Record<string, unknown> | null,
  ) =>
    run(`decide:${ids.join(",")}:${decision}`, () =>
      decideCheck(documentId, step, buildId, ids, decision, edit),
    );

  if (!data) return <p className="graph-note">正在读取…</p>;

  const status = report?.status ?? "idle";
  const items = (report?.items ?? []) as Item[];
  const judgments = report?.judgments ?? {};
  const decisions = report?.decisions ?? {};
  const finished = Object.values(judgments).filter(
    (row) => row.status !== "running",
  );
  const failed = finished.filter((row) => row.status === "failed").length;
  const suggested = items.filter(
    (item) => judgments[item.id]?.decision?.suggest,
  );
  const pending = suggested.filter((item) => !decisions[item.id]);
  const accepted = items.filter(
    (item) => decisions[item.id]?.decision === "accept",
  );
  const toJudge = items.length - finished.length;
  const unwritten = unwrittenOf(report ?? {});
  const canDecide =
    canEdit &&
    ["ready", "stopped", "scanned", "queued", "running"].includes(status);
  const canWrite = canEdit && ["ready", "stopped", "scanned"].includes(status);

  const startPanel = (
    <div className="gr-method">
      <p>{info.hint}</p>
      <p className="gc-example">例如：{info.example}</p>
      {step === "glean" && (
        <p className="gc-options">
          补抽范围：
          <label>
            <input
              type="radio"
              checked={scope === "few"}
              onChange={() => setScope("few")}
            />
            抽出很少的分片（0～1 个实体）
          </label>
          <label>
            <input
              type="radio"
              checked={scope === "all"}
              onChange={() => setScope("all")}
            />
            全部分片（调用次数接近重新抽取一次）
          </label>
        </p>
      )}
      {step === "relation" && (
        <p className="gc-options">
          另外从核对通过的关系里抽查：
          <select
            value={sample}
            onChange={(event) => setSample(Number(event.target.value))}
          >
            {[0, 5, 10, 20, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value === 0 ? "不抽查" : `${value}%`}
              </option>
            ))}
          </select>
        </p>
      )}
      {profiles.length > 0 && (
        <p className="gc-options">
          AI 判断用的模型：
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="">和建图时一样</option>
            {profiles.map((item) => (
              <option key={item.provider} value={item.provider}>
                {item.provider} · {item.model}
                {item.is_active ? "（当前启用）" : ""}
              </option>
            ))}
          </select>
        </p>
      )}
      {canEdit && (
        <div className="gr-actions">
          <ConfirmPopover
            message="跳过这一步？不检查、不写入，直接到下一步。之后也可以回来开始检查。"
            confirmText="跳过"
            onConfirm={() => act("skip", "已跳过这一步")}
          >
            <button type="button" className="secondary-button" disabled={busy}>
              跳过这一步
            </button>
          </ConfirmPopover>
          <button
            type="button"
            className={`primary-button${loadingClass(action === "start")}`}
            disabled={busy}
            onClick={() => void start()}
          >
            {report?.items ? "重新检查" : "开始检查"}
          </button>
        </div>
      )}
    </div>
  );

  if (!report || status === "idle" || status === "skipped" || !report.items) {
    return (
      <div className="gr-body">
        {status === "skipped" && <p className="gr-hint">这一步已跳过。</p>}
        {status === "failed" && (
          <p className="gr-warn">检查失败：{report?.error ?? "未知原因"}</p>
        )}
        {status === "queued" || status === "running" ? (
          <p className="graph-note">
            正在找可疑项（不调用模型），找完会列出来，确认后再让 AI 判断…
          </p>
        ) : (
          startPanel
        )}
      </div>
    );
  }

  const steps: CheckStep[] = [
    {
      key: 1,
      title: step === "glean" ? "选出要补抽的分片" : "找出可疑项",
      text: step === "glean" ? `${items.length} 片` : `${items.length} 项`,
      state: "done",
    },
    {
      key: 2,
      title: "AI 判断",
      text:
        status === "scanned"
          ? `待开始 · 约 ${toJudge} 次调用`
          : status === "stopped"
            ? `已停止 ${finished.length}/${items.length}`
            : `${finished.length}/${items.length}${failed ? ` · 失败 ${failed}` : ""}`,
      state: ["scanned", "queued", "running", "stopped"].includes(status)
        ? "current"
        : failed
          ? "failed"
          : "done",
    },
    {
      key: 3,
      title: "逐条决定",
      text: `待处理 ${pending.length} · 采纳 ${accepted.length}`,
      state:
        status === "scanned" ? "waiting" : pending.length ? "current" : "done",
    },
    {
      key: 4,
      title: "确认写入",
      // 采纳了但还没写入：这一步是当前步骤，不算完成。
      text:
        status === "rewriting"
          ? "正在写入"
          : unwritten
            ? accepted.length
              ? `${accepted.length} 项待写入`
              : "撤掉上次写入的内容，待写入"
            : report.applied
              ? `已写入 ${countApplied(report.applied.items)} 项`
              : "没有采纳的项",
      state:
        status === "rewriting" || unwritten
          ? "current"
          : report.applied
            ? "done"
            : "waiting",
    },
  ];
  const shown = sub ?? 1;
  const list = shown === 3 && filter === "pending" ? pending : items;
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const started = report.started ? Date.parse(report.started) : NaN;
  const durations = finished
    .map((row) => row.duration_ms ?? 0)
    .filter((value) => value > 0);
  const average = durations.length
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : 0;
  const tokens = finished.reduce(
    (sum, row) => sum + (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
    0,
  );
  const running = status === "queued" || status === "running";

  return (
    <div className="gr gr-split">
      <VerticalSteps
        steps={steps}
        selected={shown}
        onSelect={(key) => setSub(key)}
      />
      <div className="gr-split-main">
        {report.stale && (
          <p className="gr-warn">
            前面的步骤写入了新结果，这一步需要重新检查。
            {canEdit && (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => void start()}
              >
                重新检查
              </button>
            )}
          </p>
        )}
        {status === "failed" && (
          <p className="gr-warn">检查失败：{report.error ?? "未知原因"}</p>
        )}

        {shown === 1 && (
          <div className="gr-method">
            {step === "glean" ? (
              <p>
                按开始时选的范围（
                {report.params?.scope === "all"
                  ? "全部分片"
                  : "抽出很少的分片：0～1 个实体"}
                ），选出 <strong>{items.length}</strong> 片要让 AI 补抽。下一步
                AI 会逐片看原文和这片已经抽出的实体，只补漏掉的实体和关系。
              </p>
            ) : (
              <p>
                {info.hint} 找出 <strong>{items.length}</strong> 项可疑
                {report.scan ? `（${report.scan.duration_ms} 毫秒）` : ""}。
              </p>
            )}
            <p className="gc-example">例如：{info.example}</p>
            {status === "scanned" && (
              <div className="gr-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setSub(2)}
                >
                  确认，进入下一步，让 AI 判断
                </button>
              </div>
            )}
            {canEdit && status !== "scanned" && !running && (
              <div className="gr-actions">
                <button
                  type="button"
                  className={`secondary-button${loadingClass(action === "start")}`}
                  disabled={busy}
                  onClick={() => void start()}
                >
                  重新检查
                </button>
              </div>
            )}
          </div>
        )}

        {shown === 2 && (
          <>
            {(running || status === "stopped") && (
              <div className={`gc-progress${running ? "" : " is-stopped"}`}>
                <div className="gc-progress-head">
                  <span className="gc-progress-phases">
                    <span>① 找可疑项：{items.length} 项</span>
                    <span className={running ? "is-active" : ""}>
                      ② AI 判断：{finished.length} / {items.length}
                    </span>
                  </span>
                  {canEdit &&
                    (running ? (
                      <button
                        type="button"
                        className={`secondary-button button-sm${loadingClass(action === "stop")}`}
                        disabled={busy}
                        onClick={() => void act("stop", "已停止：判断完的保留")}
                      >
                        停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`primary-button button-sm${loadingClass(action === "judge")}`}
                        disabled={busy}
                        onClick={() =>
                          void act("judge", "已继续：只判断还没判断的")
                        }
                      >
                        继续检查
                      </button>
                    ))}
                </div>
                <div className="gc-progress-bar">
                  <span
                    style={{
                      width: `${items.length ? (finished.length / items.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="gc-progress-stats">
                  <span>
                    {running ? "检查中" : "已停止"} · 已判断 {finished.length} /{" "}
                    {items.length}
                  </span>
                  {failed > 0 && <span>失败 {failed}</span>}
                  {running && !Number.isNaN(started) && (
                    <span>已用时 {clock(now - started)}</span>
                  )}
                  {running && average > 0 && (
                    <span>预计还要 {clock(average * toJudge)}</span>
                  )}
                  <span>token {tokens.toLocaleString()}</span>
                  {running && <span>判断完的可以先到第 3 步处理</span>}
                </div>
              </div>
            )}
            <div className="gr-method">
              {status === "scanned" ? (
                <p>
                  每项调用一次 AI。共 {items.length} 项
                  {finished.length
                    ? `，其中 ${finished.length} 项之前判断过`
                    : ""}
                  ，还要判断 <strong>{toJudge}</strong> 项，约{" "}
                  <strong>{toJudge} 次</strong>调用。
                </p>
              ) : (
                <p>
                  已判断 {finished.length}/{items.length} 项
                  {failed ? `，失败 ${failed} 项` : ""}；AI 建议处理{" "}
                  {suggested.length} 项。
                </p>
              )}
              {report.prompt_tag && (
                <p className="gr-small">
                  用的提示词：<code>{report.prompt_tag}</code>
                  （在「提示词管理 ·
                  知识图谱」里修改，改完点「全部重新判断」生效）
                </p>
              )}
              {canEdit && (
                <div className="gr-actions">
                  {status === "scanned" && (
                    <button
                      type="button"
                      className={`primary-button${loadingClass(action === "judge")}`}
                      disabled={busy}
                      onClick={() =>
                        void act("judge", "已开始 AI 判断").then(() =>
                          setSub(2),
                        )
                      }
                    >
                      开始 AI 判断（约 {toJudge} 次调用）
                    </button>
                  )}
                  {failed > 0 && ["ready", "stopped"].includes(status) && (
                    <button
                      type="button"
                      className={`secondary-button${loadingClass(action === "retry-failed")}`}
                      disabled={busy}
                      onClick={() =>
                        void act("retry-failed", `已排队重试 ${failed} 项`)
                      }
                    >
                      重试失败的 {failed} 项
                    </button>
                  )}
                  {["ready", "stopped"].includes(status) &&
                    finished.length > 0 && (
                      <ConfirmPopover
                        message={`用当前提示词把 ${items.length} 项全部重新判断（约 ${items.length} 次调用）？现有的 AI 判断和还没写入的采纳 / 不采纳都会清掉；已写入图谱的不受影响。`}
                        confirmText="全部重新判断"
                        onConfirm={() =>
                          act("rejudge", "已开始全部重新判断").then(() =>
                            setSub(2),
                          )
                        }
                      >
                        <button
                          type="button"
                          className={`secondary-button${loadingClass(action === "rejudge")}`}
                          disabled={busy}
                        >
                          全部重新判断
                        </button>
                      </ConfirmPopover>
                    )}
                </div>
              )}
            </div>
          </>
        )}

        {shown === 3 && (
          <div className="gr-method">
            <p>
              每项点「{info.accept}」或「{info.reject}
              」，随时可以撤销；这里只记录决定，到第 4 步确认后才写入。
            </p>
            <div className="gr-actions gc-filter">
              <button
                type="button"
                className={
                  filter === "pending"
                    ? "primary-button button-sm"
                    : "secondary-button button-sm"
                }
                onClick={() => setFilter("pending")}
              >
                AI 建议、待处理 {pending.length}
              </button>
              <button
                type="button"
                className={
                  filter === "all"
                    ? "primary-button button-sm"
                    : "secondary-button button-sm"
                }
                onClick={() => setFilter("all")}
              >
                全部 {items.length}
              </button>
              {canDecide && pending.length > 0 && (
                <ConfirmPopover
                  message={`采纳全部 ${pending.length} 项 AI 建议？之后还可以逐项撤销。`}
                  confirmText="全部采纳"
                  onConfirm={() =>
                    decide(
                      pending.map((item) => item.id),
                      "accept",
                    )
                  }
                >
                  <button
                    type="button"
                    className="secondary-button button-sm"
                    disabled={busy}
                  >
                    采纳全部建议
                  </button>
                </ConfirmPopover>
              )}
            </div>
          </div>
        )}

        {shown === 4 && (
          <div className="gr-confirm">
            <p className="gr-small">
              确认后，按「抽取结果 +
              各步已写入的决定」重算整份图谱，存成一个新版本，
              <strong>不会马上生效</strong>，要在「图谱版本」里设为生效。
              {DEPENDENT[step]}
            </p>
            {report.applied && !unwritten && (
              <p className="gc-written">
                已写入：{report.applied.by} ·{" "}
                {formatShortTime(report.applied.at)}，下面{" "}
                {countApplied(report.applied.items)}{" "}
                项已经在新版本里。移除某一项或回到第 3
                步改了决定后，才需要再写入。
              </p>
            )}
            {accepted.length ? (
              <ol className="gr-plan">
                {accepted.map((item) => (
                  <li key={item.id}>
                    <span>
                      {summaryLine(
                        step,
                        item,
                        judgments[item.id],
                        decisions[item.id],
                      )}
                      {canDecide && (
                        <button
                          type="button"
                          className={`link-button gr-remove${loadingClass(action === `decide:${item.id}:null`)}`}
                          disabled={busy}
                          title="撤销采纳，回到第 3 步待处理；写入时不包含这一项"
                          onClick={() => void decide([item.id], null)}
                        >
                          移除
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="graph-note">
                {report.applied
                  ? `上次已写入 ${countApplied(report.applied.items)} 项；现在没有采纳的项，写入会撤掉上次写入的内容。`
                  : "还没有采纳任何建议。"}
              </p>
            )}
            {canWrite && unwritten && (
              <div className="gr-actions">
                <ConfirmPopover
                  message={`写入 ${accepted.length} 项？结果存成新版本，不会马上生效。`}
                  confirmText="写入"
                  onConfirm={() =>
                    act("write", "已提交：写入后存成新版本（不自动生效）")
                  }
                >
                  <button
                    type="button"
                    className={`primary-button${loadingClass(action === "write")}`}
                    disabled={busy}
                  >
                    确认写入（{accepted.length} 项）
                  </button>
                </ConfirmPopover>
              </div>
            )}
            {status === "rewriting" && (
              <p className="gr-hint">正在写入图谱（不调用模型）…</p>
            )}
          </div>
        )}

        {shown <= 3 && (
          <div className="gr-list">
            {list.length === 0 && (
              <p className="graph-note">
                {shown === 3 && filter === "pending"
                  ? "没有待处理的建议了，可以去第 4 步确认写入。"
                  : "没有可疑项。"}
              </p>
            )}
            {list
              .slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
              .map((item) => (
                <ItemCard
                  key={item.id}
                  step={step}
                  item={item}
                  judgment={shown >= 2 ? judgments[item.id] : undefined}
                  decision={decisions[item.id]}
                  editable={shown === 3 && canDecide}
                  busy={busy}
                  onOriginal={showOriginal}
                  onDecide={(decision, edit) =>
                    void decide([item.id], decision, edit)
                  }
                />
              ))}
            {list.length > PAGE_SIZE && (
              <nav className="gr-pager" aria-label="分页">
                <span>
                  第 {(current - 1) * PAGE_SIZE + 1}–
                  {Math.min(current * PAGE_SIZE, list.length)} 项，共{" "}
                  {list.length} 项
                </span>
                <span className="gr-pager-controls">
                  <button
                    type="button"
                    className="secondary-button button-sm"
                    disabled={current === 1}
                    onClick={() => setPage(current - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {current} / {pageCount}
                  </span>
                  <button
                    type="button"
                    className="secondary-button button-sm"
                    disabled={current === pageCount}
                    onClick={() => setPage(current + 1)}
                  >
                    下一页
                  </button>
                </span>
              </nav>
            )}
          </div>
        )}
        {original && (
          <DetailDialog
            open
            title={original.title}
            onClose={() => setOriginal(null)}
          >
            <p className="graph-chunk-text">{original.body}</p>
          </DetailDialog>
        )}
      </div>
    </div>
  );
}

const DEPENDENT: Record<CheckStepName, string> = {
  glean: "写入后，后面的关系核对、类型核对、拆分、合并都要重新检查。",
  relation: "只删关系，不影响后面的步骤。",
  type: "写入后，后面的拆分、合并要重新检查。",
  split: "写入后，后面的合并要重新检查。",
};

// 采纳的和上次写入的不一样：还没写入（和后端 checks.unwritten 同一规则）。
// 老的写入记录没记 ids，有写入就当作已经写入了现在的采纳。
export function unwrittenOf(report: {
  items?: { id: string }[];
  decisions?: Record<string, { decision: string } | undefined>;
  applied?: { items: unknown; ids?: string[] } | null;
}) {
  const ids = new Set((report.items ?? []).map((item) => item.id));
  const accepted = Object.entries(report.decisions ?? {})
    .filter(([key, row]) => ids.has(key) && row?.decision === "accept")
    .map(([key]) => key)
    .sort();
  const written =
    report.applied?.ids ??
    (report.applied && countApplied(report.applied.items) > 0 ? accepted : []);
  return accepted.join(",") !== [...written].sort().join(",");
}

function countApplied(items: unknown) {
  if (Array.isArray(items)) return items.length;
  if (items && typeof items === "object") return Object.keys(items).length;
  return 0;
}

function summaryLine(
  step: CheckStepName,
  item: Item,
  judgment: CheckJudgment | undefined,
  decision: Decision | undefined,
): ReactNode {
  const value = judgment?.decision ?? {};
  const edit = decision?.edit ?? {};
  if (step === "glean") {
    const entities = (value.entities as { name: string }[] | undefined) ?? [];
    const relations = (value.relations as unknown[] | undefined) ?? [];
    return `第 ${Number(item.position) + 1} 片：补 ${entities.length} 个实体（${entities
      .map((row) => row.name)
      .join("、")}）、${relations.length} 条关系`;
  }
  if (step === "relation")
    return `删除：${text(item.source)} → ${text(item.target)}（${text(item.description)}）`;
  if (step === "type")
    return `${(item.names as string[]).join(" / ")} 改成「${text(edit.type ?? value.type)}」`;
  const groups =
    (edit.groups as { name: string }[] | undefined) ??
    (value.groups as { name: string }[] | undefined) ??
    [];
  return `${text(item.name)} 拆成：${groups.map((row) => row.name).join("、")}`;
}

function ItemCard({
  step,
  item,
  judgment,
  decision,
  editable,
  busy,
  onOriginal,
  onDecide,
}: {
  step: CheckStepName;
  item: Item;
  judgment?: CheckJudgment;
  decision?: Decision;
  editable: boolean;
  busy: boolean;
  onOriginal: ShowOriginal;
  onDecide: (
    decision: "accept" | "reject" | null,
    edit?: Record<string, unknown> | null,
  ) => void;
}) {
  const info = CHECK_INFO[step];
  const value = judgment?.decision ?? {};
  const [edit, setEdit] = useState<Record<string, unknown> | null>(
    decision?.edit ?? null,
  );
  return (
    <article className={`gr-card gc-card${value.suggest ? " is-merge" : ""}`}>
      <header className="gr-card-head">
        {itemTitle(step, item)}
        {judgment?.status === "failed" && (
          <Tag size="sm" tone="danger" title={judgment.error}>
            判断失败
          </Tag>
        )}
        {judgment?.status === "completed" && (
          <Tag size="sm" tone={value.suggest ? "info" : "neutral"}>
            {value.suggest
              ? `AI 建议：${info.accept}`
              : `AI 建议：${info.reject}`}
          </Tag>
        )}
      </header>
      {itemBody(step, item, onOriginal)}
      {judgment?.status === "completed" && (
        <div className="gc-judgment">
          {judgmentBody(step, item, value, edit, setEdit, editable)}
          {value.reason && (
            <p className="gr-reason">理由：{text(value.reason)}</p>
          )}
        </div>
      )}
      {(editable || decision) && (
        <div className="gc-decide">
          {decision ? (
            <>
              <Tag
                size="sm"
                tone={decision.decision === "accept" ? "info" : "neutral"}
              >
                {decision.decision === "accept"
                  ? `已决定：${info.accept}`
                  : `已决定：${info.reject}`}
              </Tag>
              {editable && (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => onDecide(null)}
                >
                  撤销
                </button>
              )}
            </>
          ) : (
            editable && (
              <>
                <button
                  type="button"
                  className="secondary-button button-sm"
                  disabled={busy}
                  onClick={() => onDecide("reject")}
                >
                  {info.reject}
                </button>
                <button
                  type="button"
                  className="primary-button button-sm"
                  disabled={
                    busy ||
                    (step === "type" && !edit?.type && !value.type) ||
                    (step === "split" && !edit?.groups && !value.split) ||
                    (step === "glean" && judgment?.status !== "completed")
                  }
                  onClick={() => onDecide("accept", edit)}
                >
                  {info.accept}
                </button>
              </>
            )
          )}
        </div>
      )}
    </article>
  );
}

function itemTitle(step: CheckStepName, item: Item): ReactNode {
  if (step === "glean")
    return <strong>第 {Number(item.position) + 1} 片</strong>;
  if (step === "relation")
    return (
      <strong>
        {text(item.source)} <span className="gr-arrow">→</span>{" "}
        <Tag size="sm" plain hue>
          {text(item.category)}
        </Tag>{" "}
        <span className="gr-arrow">→</span> {text(item.target)}
      </strong>
    );
  if (step === "type")
    return <strong>{(item.names as string[]).join(" / ")}</strong>;
  return (
    <strong>
      {text(item.name)}（{text(item.type)}）· 相似度 {text(item.similarity)}
    </strong>
  );
}

function originalButton(
  label: string,
  title: string,
  body: string,
  onOriginal: ShowOriginal,
) {
  return (
    <button
      type="button"
      className="link-button gc-original"
      onClick={() => onOriginal(title, body)}
    >
      {label}
    </button>
  );
}

function itemBody(
  step: CheckStepName,
  item: Item,
  onOriginal: ShowOriginal,
): ReactNode {
  const chunkTitle = `第 ${Number(item.position) + 1} 片 · 原文`;
  if (step === "glean")
    return (
      <p className="gr-small">
        {(item.names as string[]).length > 0
          ? `之前建图时从这片已经抽出了 ${(item.names as string[]).length} 个实体：${(item.names as string[]).join("、")}`
          : "建图时没从这片抽出任何实体"}
        {originalButton("原文", chunkTitle, text(item.excerpt), onOriginal)}
      </p>
    );
  if (step === "relation")
    return (
      <>
        <p>
          {text(item.description)}
          {item.evidence ? (
            <small className="gc-quote">「{text(item.evidence)}」</small>
          ) : null}
        </p>
        <p className="gc-tags">
          {(item.reasons as string[]).map((reason) => (
            <Tag
              key={reason}
              size="sm"
              tone={
                reason === "name_not_in_quote" || reason === "sampled"
                  ? "neutral"
                  : "warning"
              }
            >
              {REASONS[reason] ?? reason}
            </Tag>
          ))}
          <span className="gr-small">第 {Number(item.position) + 1} 片</span>
          {originalButton("原文", chunkTitle, text(item.excerpt), onOriginal)}
        </p>
      </>
    );
  if (step === "type")
    return (
      <ul className="gc-types">
        {(
          item.types as {
            type: string;
            count: number;
            samples: {
              position: number;
              description?: string;
              excerpt: string;
            }[];
          }[]
        ).map((row) => (
          <li key={row.type}>
            <Tag size="sm" plain hue>
              {row.type}
            </Tag>{" "}
            {row.count} 处
            {row.samples.map((sample, index) => (
              <p key={index} className="gr-small">
                第 {sample.position + 1} 片：{sample.description ?? ""}
                {originalButton(
                  "原文",
                  `第 ${sample.position + 1} 片 · 原文`,
                  sample.excerpt,
                  onOriginal,
                )}
              </p>
            ))}
          </li>
        ))}
      </ul>
    );
  return (
    <details className="gc-mentions">
      <summary>{(item.mentions as unknown[]).length} 处出现</summary>
      <ul className="gc-types">
        {(
          item.mentions as {
            key: string;
            position: number;
            name: string;
            description?: string;
            excerpt: string;
          }[]
        ).map((row) => (
          <li key={row.key} className="gr-small">
            第 {row.position + 1} 片「{row.name}」：{row.description ?? ""}
            {originalButton(
              "原文",
              `第 ${row.position + 1} 片 · 原文`,
              row.excerpt,
              onOriginal,
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function judgmentBody(
  step: CheckStepName,
  item: Item,
  value: Record<string, unknown>,
  edit: Record<string, unknown> | null,
  setEdit: (value: Record<string, unknown> | null) => void,
  editable: boolean,
): ReactNode {
  if (step === "glean") {
    const entities =
      (value.entities as {
        name: string;
        type: string;
        description?: string;
      }[]) ?? [];
    const relations =
      (value.relations as {
        source: string;
        target: string;
        description?: string;
        evidence?: string;
      }[]) ?? [];
    // 程序过滤：只有真的去掉了东西才显示，用引用样式写明查了什么、去掉了什么。
    const dropped =
      (value.dropped as
        | { kind?: string; name: string; reason: string }[]
        | undefined) ?? [];
    const droppedCount = Number(value.dropped_count ?? dropped.length);
    const droppedNote = droppedCount > 0 && (
      <blockquote className="gc-filter-note">
        <strong>程序过滤（不调用模型）：去掉了 {droppedCount} 个</strong>
        <span>
          检查了：实体名字在不在这一片原文里；关系的起点、终点是不是实体，原文引用在不在这一片里，这两个实体之间是不是已经有关系。
        </span>
        <ul>
          {dropped.map((row, index) => (
            <li key={index}>
              {(row.kind ??
                (row.name.includes("→") ? "relation" : "entity")) === "relation"
                ? "关系"
                : "实体"}
              「{row.name}」：{row.reason}
            </li>
          ))}
          {droppedCount > dropped.length && (
            <li>还有 {droppedCount - dropped.length} 个没有列出</li>
          )}
        </ul>
      </blockquote>
    );
    if (!entities.length && !relations.length)
      return (
        <>
          <p>AI 没有找到漏掉的。</p>
          {droppedNote}
        </>
      );
    // 和关系表一样：起点 → 终点、AI 基于原文的总结用正常文字，只有原文引用是灰色小字。
    return (
      <div className="gc-glean">
        {entities.length > 0 && (
          <div className="gc-glean-row">
            <span className="gc-label">补实体</span>
            <span className="gc-chips">
              {entities.map((row) => (
                <Tag key={row.name} size="sm" plain hue>
                  {row.name}（{row.type}）
                </Tag>
              ))}
            </span>
          </div>
        )}
        {relations.length > 0 && (
          <div className="gc-glean-row">
            <span className="gc-label">补关系</span>
            <ul className="gc-relations">
              {relations.map((row, index) => (
                <li key={index}>
                  <strong>
                    {row.source} → {row.target}
                  </strong>
                  ：{row.description ?? ""}
                  {row.evidence && (
                    <small className="gc-quote">
                      {" "}
                      原文引用：「{row.evidence}」
                    </small>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {droppedNote}
      </div>
    );
  }
  if (step === "relation") {
    const verdict = VERDICTS[text(value.verdict)];
    return verdict ? (
      <p>
        <Tag size="sm" tone={verdict.tone}>
          {verdict.label}
        </Tag>
      </p>
    ) : null;
  }
  if (step === "type") {
    const options = [
      ...new Set([
        ...(value.type ? [text(value.type)] : []),
        ...(item.types as { type: string }[]).map((row) => row.type),
      ]),
    ];
    return (
      <p>
        AI 建议的类型：
        <strong>
          {value.type
            ? text(value.type)
            : "不改（可能是不同东西同名，交给拆分）"}
        </strong>
        {editable && (
          <label className="gc-inline">
            改成
            <select
              value={text(edit?.type ?? value.type ?? "")}
              onChange={(event) =>
                setEdit(
                  event.target.value ? { type: event.target.value } : null,
                )
              }
            >
              <option value="">（用 AI 建议）</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
      </p>
    );
  }
  const groups =
    (edit?.groups as { mentions: string[]; name: string }[] | undefined) ??
    (value.groups as { mentions: string[]; name: string }[] | undefined) ??
    [];
  if (!value.split && !edit?.groups) return <p>AI 建议不拆。</p>;
  return (
    <ol className="gc-groups">
      {groups.map((group, index) => (
        <li key={index}>
          {index === 0 || !editable ? (
            <strong>{group.name || text(item.name)}</strong>
          ) : (
            <input
              value={group.name}
              maxLength={200}
              onChange={(event) =>
                setEdit({
                  groups: groups.map((row, position) =>
                    position === index
                      ? { ...row, name: event.target.value }
                      : row,
                  ),
                })
              }
            />
          )}
          <span className="gr-small">
            {index === 0 ? "（保留原名）" : "（拆出去，改成这个名字）"}{" "}
            {group.mentions
              .map((key) => {
                const [chunk, name] = key.split("|");
                const row = (
                  item.mentions as { key: string; position: number }[]
                ).find((mention) => mention.key === key);
                return `第 ${(row?.position ?? 0) + 1} 片「${name ?? chunk}」`;
              })
              .join("、")}
          </span>
        </li>
      ))}
    </ol>
  );
}
