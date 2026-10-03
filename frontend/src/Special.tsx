import { useEffect, useState } from "react";
import { addEvalSuiteItem, createEvalSuite, deleteEvalSuite, deleteEvalSuiteItem, getEvalRun, getEvalSuite, listEvalSuites, startSpecialRun, updateEvalSuite, updateEvalSuiteItem, type EvalSpecialQuestion, type EvalSpecialSection, type EvalSuiteBrief, type EvalSuiteFull, type EvalSuiteItem, type EvalSuiteMethod, type EvalSuiteSearchMode, type EvalSuiteRunEntry } from "./api";
import { EvidenceDetails } from "./EvidenceChunks";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./Regression.css";
import "./Special.css";

// 专项评测集：每个专项针对一个方向（例如分片超长被截断、多轮对话记忆）检查有没有问题，题目只属于这个专项，
// 不计入调参分数。页面布局和「巡检复测集」一致：列表 → 详情（运行、运行记录、题目）。
type ShowToast = (kind: "success" | "error", message: string) => void;
type Props = { suiteId: string | null; onNavigate: (path: string) => void; onToast: ShowToast };

const METHOD_LABELS: Record<EvalSuiteMethod, string> = { retrieval: "检索", answer: "回答", dialogue: "多轮对话" };
const METHOD_HINTS: Record<EvalSuiteMethod, string> = {
  retrieval: "只检索，不调用大模型。证据全部被返回算通过；逐题显示向量检索、关键词检索各排第几，看是谁找到的。题目要有问题和证据原文。",
  answer: "检索后完整回答，再由评审模型和参考答案比对，要点一致算通过。需要真实大模型。题目要有问题和参考答案，证据可选。",
  dialogue: "按顺序问完一段对话，最后一问要用到前面的内容，评审模型判定要点一致算通过。需要真实大模型。题目是前面几轮提问、最后一问和参考答案。",
};
const SEARCH_LABELS: Record<EvalSuiteSearchMode, string> = { hybrid: "混合检索", dense: "只用向量", keyword: "只用关键词" };
const SEARCH_HINTS: Record<EvalSuiteSearchMode, string> = {
  hybrid: "向量 + 关键词两路一起找，和线上一样。看整条链路能不能把证据交给回答模型。",
  dense: "只用向量检索。看向量本身找不找得到，比如分片被截断的影响不会被关键词检索兜回来。",
  keyword: "只用关键词检索（BM25）。看字面匹配找不找得到，和「只用向量」对照着看。",
};
const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "运行中", tone: "blue" }, completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" }, interrupted: { label: "已中断", tone: "orange" },
};
// 证据最后的去向（检索诊断里的状态）。
const EVIDENCE_STATUS: Record<string, string> = {
  returned: "交给了回答模型", beyond_limit: "重排后排名靠后，超出交给模型的段数", filtered_low_score: "重排打分低于相关度阈值，被过滤",
  in_pool: "进了重排但没交给模型", not_in_pool: "合并后没进重排候选池", not_recalled: "检索没找到",
};

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  const text = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? text : `${date.getFullYear()}-${text}`;
}

// 检索方式选择：多轮对话方式不用（它走完整问答流程）。随时可以改，不影响已有题目。
function SearchModeField({ value, onChange }: { value: EvalSuiteSearchMode; onChange: (value: EvalSuiteSearchMode) => void }) {
  return <label className="rg-field is-top"><span>检索方式</span>
    <div className="sp-method-field">
      <select value={value} onChange={(event) => onChange(event.target.value as EvalSuiteSearchMode)}>
        {(Object.keys(SEARCH_LABELS) as EvalSuiteSearchMode[]).map((key) => <option key={key} value={key}>{SEARCH_LABELS[key]}</option>)}
      </select>
      <small>{SEARCH_HINTS[value]} 随时可以改。</small>
    </div>
  </label>;
}

function lines(text: string) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export default function Special({ suiteId, onNavigate, onToast }: Props) {
  return suiteId
    ? <SuiteDetail suiteId={suiteId} onBack={() => onNavigate("/eval/special")} onToast={onToast} />
    : <SuiteList onOpen={(id) => onNavigate(`/eval/special/${encodeURIComponent(id)}`)} onToast={onToast} />;
}

function SuiteList({ onOpen, onToast }: { onOpen: (id: string) => void; onToast: ShowToast }) {
  const [suites, setSuites] = useState<EvalSuiteBrief[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<EvalSuiteMethod>("retrieval");
  const [searchMode, setSearchMode] = useState<EvalSuiteSearchMode>("hybrid");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listEvalSuites().then((data) => setSuites(data.items)).catch((reason: Error) => onToast("error", reason.message));
  }, []);

  async function create() {
    setBusy(true);
    try {
      const created = await createEvalSuite({ name: name.trim(), description: description.trim() || undefined, method, search_mode: searchMode });
      onOpen(created.id);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="rg-root">
    <div className="rg-intro">
      <p>每个专项针对一个方向检查有没有问题，比如分片太长被截断、多轮对话记不记得前面的内容。专项题专门挑难题，分数低是正常的，不计入调参分数。</p>
      <p>在这里运行单个专项，也可以在「历史评测记录」里选「专项」，一次勾选几个一起跑。</p>
      {!creating && <button type="button" className="primary-button" onClick={() => setCreating(true)}>新建专项</button>}
    </div>
    {creating && <div className="rg-form">
      <label className="rg-field"><span>名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} placeholder="例如：截断、多轮对话、表格内容" autoFocus /></label>
      <label className="rg-field"><span>说明</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="这个专项检查什么方向（可选）" /></label>
      <label className="rg-field is-top"><span>评测方式</span>
        <div className="sp-method-field">
          <select value={method} onChange={(event) => setMethod(event.target.value as EvalSuiteMethod)}>
            {(Object.keys(METHOD_LABELS) as EvalSuiteMethod[]).map((key) => <option key={key} value={key}>{METHOD_LABELS[key]}</option>)}
          </select>
          <small>{METHOD_HINTS[method]} 加了题目以后不能再改。</small>
        </div>
      </label>
      {method !== "dialogue" && <SearchModeField value={searchMode} onChange={setSearchMode} />}
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => setCreating(false)} disabled={busy}>取消</button>
        <button type="button" className="primary-button" onClick={() => void create()} disabled={busy || !name.trim()}>创建</button>
      </div>
    </div>}
    {suites === null ? <LoadingSkeleton label="正在加载专项评测集"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton>
      : suites.length === 0 ? <div className="rg-empty">还没有专项。</div>
      : <ul className="rg-sets">
        {suites.map((item) => <li key={item.id}>
          <button type="button" className="rg-set" onClick={() => onOpen(item.id)}>
            <span className="rg-set-name">{item.name}<span className={`sp-method is-${item.method}`}>{item.method_label}</span>{item.method !== "dialogue" && <span className="sp-search">{item.search_mode_label}</span>}</span>
            {item.description && <span className="rg-set-description">{item.description}</span>}
            <span className="rg-set-meta">
              <span>{item.item_count} 题</span>
              {item.latest?.summary ? <span>最近一次：<strong className={item.latest.summary.passed === item.latest.summary.count ? "is-pass" : "is-fail"}>{item.latest.summary.passed} / {item.latest.summary.count} 通过</strong>（{formatTime(item.latest.finished)}）</span> : <span className="rg-muted">还没跑过</span>}
            </span>
          </button>
        </li>)}
      </ul>}
  </div>;
}

function SuiteDetail({ suiteId, onBack, onToast }: { suiteId: string; onBack: () => void; onToast: ShowToast }) {
  const [data, setData] = useState<EvalSuiteFull | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [section, setSection] = useState<EvalSpecialSection | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [compareMemory, setCompareMemory] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<EvalSuiteMethod>("retrieval");
  const [searchMode, setSearchMode] = useState<EvalSuiteSearchMode>("hybrid");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 题目和运行记录分两个页签；发起运行后自动切到运行记录。
  const [tab, setTab] = useState<"items" | "runs">("items");

  async function load() {
    const value = await getEvalSuite(suiteId);
    setData(value);
    return value;
  }

  useEffect(() => {
    setRunId(null);
    load().then((value) => {
      const pick = value.runs.find((item) => item.status === "running") ?? value.runs.find((item) => item.status === "completed") ?? value.runs[0];
      setRunId(pick?.id ?? null);
    }).catch((reason: Error) => onToast("error", reason.message));
  }, [suiteId]);

  const running = data?.runs.find((item) => item.status === "running") ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [running?.id]);

  const selectedStatus = data?.runs.find((item) => item.id === runId)?.status;
  useEffect(() => {
    setSection(null);
    setRunError(null);
    if (!runId || selectedStatus === "running") return;
    let cancelled = false;
    getEvalRun(runId).then((run) => {
      if (cancelled) return;
      if (run.status !== "completed") setRunError(run.error ?? "这次评测没有正常结束");
      setSection(run.special?.find((item) => item.suite_id === suiteId) ?? null);
    }).catch((reason: Error) => onToast("error", reason.message));
    return () => { cancelled = true; };
  }, [runId, selectedStatus]);

  async function start() {
    setStarting(true);
    try {
      const created = await startSpecialRun([suiteId], compareMemory);
      await load();
      setRunId(created.id);
      setTab("runs");
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function saveInfo() {
    try {
      setData({ ...(await updateEvalSuite(suiteId, { name: name.trim(), description: description.trim(), method, search_mode: searchMode })) });
      setRenaming(false);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  async function remove() {
    try {
      await deleteEvalSuite(suiteId);
      onToast("success", "已删除专项");
      onBack();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  async function removeItem(itemId: string) {
    try {
      setData(await deleteEvalSuiteItem(suiteId, itemId));
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  if (!data) return <div className="rg-root"><LoadingSkeleton label="正在加载专项"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton></div>;
  return <div className="rg-root">
    <button type="button" className="rg-back" onClick={onBack}>← 全部专项</button>
    {renaming ? <div className="rg-form">
      <label className="rg-field"><span>名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
      <label className="rg-field"><span>说明</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label>
      <label className="rg-field is-top"><span>评测方式</span>
        <div className="sp-method-field">
          <select value={method} disabled={data.items.length > 0} onChange={(event) => setMethod(event.target.value as EvalSuiteMethod)}>
            {(Object.keys(METHOD_LABELS) as EvalSuiteMethod[]).map((key) => <option key={key} value={key}>{METHOD_LABELS[key]}</option>)}
          </select>
          <small>{data.items.length > 0 ? "已经有题目，不能再改评测方式。" : METHOD_HINTS[method]}</small>
        </div>
      </label>
      {method !== "dialogue" && <SearchModeField value={searchMode} onChange={setSearchMode} />}
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => setRenaming(false)}>取消</button>
        <button type="button" className="primary-button" onClick={() => void saveInfo()} disabled={!name.trim()}>保存</button>
      </div>
    </div> : <div className="rg-title">
      <div>
        <h3>{data.name}<span className={`sp-method is-${data.method}`}>{data.method_label}</span>{data.method !== "dialogue" && <span className="sp-search">{data.search_mode_label}</span>}</h3>
        {data.description && <p>{data.description}</p>}
      </div>
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => { setName(data.name); setDescription(data.description); setMethod(data.method); setSearchMode(data.search_mode); setRenaming(true); }}>修改</button>
        {confirmDelete
          ? <><button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="rg-danger" onClick={() => void remove()}>确认删除（题目一起删除）</button></>
          : <button type="button" className="secondary-button" onClick={() => setConfirmDelete(true)}>删除</button>}
      </div>
    </div>}

    <div className="rg-launch">
      <div className="rg-launch-option">
        <button type="button" className="primary-button" disabled={starting || Boolean(running) || data.items.length === 0} onClick={() => void start()}>运行这个专项</button>
        <span>{METHOD_HINTS[data.method]}</span>
      </div>
      {data.method === "dialogue" && <div className="sp-switch-line">
        <button type="button" role="switch" aria-checked={compareMemory} className={`sp-switch ${compareMemory ? "is-on" : ""}`} onClick={() => setCompareMemory(!compareMemory)}><span /></button>
        <span>对比记忆参数：除了当前设置，再把压缩阈值、保留条数各调大调小跑一遍（共 5 组），给设置页「对话记忆」提供依据。调用大模型次数是 5 倍。</span>
      </div>}
      {running && <div className="rg-progress">正在运行…</div>}
    </div>

    <div className="document-detail-tabs ev-tabs rg-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "items"} className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>题目<span>{data.items.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>运行记录<span>{data.runs.length}</span></button>
    </div>

    {tab === "runs" && data.runs.length === 0 && <p className="rg-muted">还没有运行过，点上面的「运行」按钮。</p>}
    {tab === "runs" && data.runs.length > 0 && <section className="rg-section">
      <div className="rg-runs" role="tablist">
        {data.runs.map((item) => <RunChip key={item.id} run={item} selected={item.id === runId} onClick={() => setRunId(item.id)} />)}
      </div>
      {runError && <p className="rg-error">{runError}</p>}
      {section && <SpecialSection section={section} />}
      {runId && selectedStatus === "running" && <p className="rg-muted">跑完后这里显示逐题结果。</p>}
    </section>}

    {tab === "items" && <section className="rg-section">
      <div className="rg-section-head">
        <span className="rg-muted">{data.items.length} 题</span>
        {!adding && <button type="button" className="secondary-button" onClick={() => { setEditing(null); setAdding(true); }}>添加题目</button>}
      </div>
      {adding && <ItemForm suiteId={suiteId} method={data.method} onToast={onToast} onDone={(value) => { setAdding(false); if (value) setData(value); }} />}
      {data.items.length === 0 && !adding && <p className="rg-muted">还没有题目，点「添加题目」。</p>}
      <ul className="rg-items">
        {data.items.map((item) => editing === item.id ? <li key={item.id}><ItemForm suiteId={suiteId} method={data.method} initial={item} onToast={onToast} onDone={(value) => { setEditing(null); if (value) setData(value); }} /></li> : <li key={item.id} className="rg-item">
          <div className="rg-item-main">
            <div className="rg-item-question">{item.question}</div>
            <div className="rg-item-meta">
              {item.turns && item.turns.length > 0 && <span>前面 {item.turns.length} 轮提问</span>}
              {item.evidence && item.evidence.length > 0 && <span>{item.evidence.length} 条证据</span>}
              {item.reference_answer && <span>有参考答案</span>}
            </div>
            <details className="rg-details"><summary>查看内容</summary>
              {item.turns && item.turns.length > 0 && <div className="rg-text"><span className="rg-muted">前面的提问：</span><ol className="sp-turns">{item.turns.map((turn, index) => <li key={index}>{turn}</li>)}</ol></div>}
              {item.evidence && item.evidence.map((text, index) => <div key={index} className="rg-text"><span className="rg-muted">证据：</span>{text}</div>)}
              {item.evidence && <div className="rg-text"><EvidenceDetails texts={item.evidence} /></div>}
              {item.reference_answer && <div className="rg-text"><span className="rg-muted">参考答案：</span>{item.reference_answer}</div>}
            </details>
          </div>
          <div className="rg-item-actions">
            <button type="button" className="rg-link is-edit" onClick={() => { setAdding(false); setEditing(item.id); }}>编辑</button>
            <button type="button" className="rg-link" onClick={() => void removeItem(item.id)}>移除</button>
          </div>
        </li>)}
      </ul>
    </section>}
  </div>;
}

function RunChip({ run, selected, onClick }: { run: EvalSuiteRunEntry; selected: boolean; onClick: () => void }) {
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "gray" };
  return <button type="button" role="tab" aria-selected={selected} className={`rg-run ${selected ? "is-selected" : ""}`} onClick={onClick}>
    <span className="rg-muted">{formatTime(run.created)}</span>
    {run.status === "completed" && run.summary ? <strong className={run.summary.passed === run.summary.count ? "is-pass" : "is-fail"}>{run.summary.passed} / {run.summary.count} 通过</strong> : <span className={`status-tag is-${status.tone}`}>{status.label}</span>}
  </button>;
}

// 添加或编辑一道题，字段随评测方式不同；证据每行一条，必须是评测语料里的原文。
function ItemForm({ suiteId, method, initial, onToast, onDone }: { suiteId: string; method: EvalSuiteMethod; initial?: EvalSuiteItem; onToast: ShowToast; onDone: (value: EvalSuiteFull | null) => void }) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [evidence, setEvidence] = useState((initial?.evidence ?? []).join("\n"));
  const [reference, setReference] = useState(initial?.reference_answer ?? "");
  const [turns, setTurns] = useState((initial?.turns ?? []).join("\n"));
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const payload = { question: question.trim(), evidence: method === "dialogue" ? [] : lines(evidence),
      reference_answer: reference.trim() || null, turns: method === "dialogue" ? lines(turns) : [] };
    try {
      onDone(initial ? await updateEvalSuiteItem(suiteId, initial.id, payload) : await addEvalSuiteItem(suiteId, payload));
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = question.trim() && (method !== "retrieval" || lines(evidence).length > 0)
    && (method === "retrieval" || reference.trim()) && (method !== "dialogue" || lines(turns).length > 0);
  return <div className="rg-form">
    <div className="rg-form-title">{initial ? "编辑题目" : "添加题目"}</div>
    {method === "dialogue" && <label className="rg-field is-top"><span>前面的提问</span><textarea value={turns} rows={4} onChange={(event) => setTurns(event.target.value)} placeholder="每行一轮，按顺序问" autoFocus /></label>}
    <label className="rg-field"><span>{method === "dialogue" ? "最后一问" : "问题"}</span><input value={question} maxLength={500} onChange={(event) => setQuestion(event.target.value)} placeholder={method === "dialogue" ? "要用到前面内容的问题，例如「回到我最开始问的那个」" : "完整的问题"} autoFocus={method !== "dialogue"} /></label>
    {method !== "dialogue" && <label className="rg-field is-top"><span>证据原文</span><textarea value={evidence} rows={3} onChange={(event) => setEvidence(event.target.value)} placeholder={method === "retrieval" ? "每行一条，必须是评测语料里的原文" : "可选：每行一条，必须是评测语料里的原文"} /></label>}
    <label className="rg-field is-top"><span>参考答案</span><textarea value={reference} maxLength={2000} rows={2} onChange={(event) => setReference(event.target.value)} placeholder={method === "retrieval" ? "可选" : "评审模型拿回答和它比对"} /></label>
    <div className="rg-buttons">
      <button type="button" className="secondary-button" onClick={() => onDone(null)} disabled={busy}>取消</button>
      <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || !ready}>{initial ? "保存" : "添加"}</button>
    </div>
  </div>;
}

// 含证据的分片在某一路检索结果里排第几：向量检索按意思相近取前 12 个分片，关键词检索（BM25）按字面取前 30 个。
function rankText(label: string, rank: number | null, limit: number) {
  return rank === null ? `${label}检索：前 ${limit} 名里没有` : `${label}检索：第 ${rank} 名`;
}

// 一个专项在一次评测里的结果：先看通过数和与上次相比的变化，没通过的排在前面；检索方式额外统计向量和关键词各找到几条证据。
export function SpecialSection({ section }: { section: EvalSpecialSection }) {
  const questions = [...section.questions].sort((a, b) => Number(a.passed) - Number(b.passed));
  const fixed = section.questions.filter((item) => item.passed && item.previous_passed === false).length;
  const regressed = section.questions.filter((item) => !item.passed && item.previous_passed === true).length;
  return <div className="rg-results">
    <div className="rg-summary">
      <span><strong>{section.passed} / {section.count} 通过</strong>（{section.count ? Math.round((section.passed / section.count) * 100) : 0}%）</span>
      {section.search_mode_label && <span className="sp-search">{section.search_mode_label}</span>}
      {section.evidence_total ? <span>{section.evidence_total} 条证据：{[section.search_mode !== "keyword" ? `含证据的分片进了向量检索前 12 名的 ${section.dense_found ?? 0} 条` : "", section.search_mode !== "dense" ? `进了关键词检索前 30 名的 ${section.keyword_found ?? 0} 条` : ""].filter(Boolean).join("，")}</span> : null}
      {section.previous ? <span>和上次（{formatTime(section.previous.created)}，{section.previous.passed} / {section.previous.count}）比：新通过 {fixed}，新失败 <strong className={regressed ? "is-fail" : ""}>{regressed}</strong></span> : <span className="rg-muted">这是第一次运行这个专项</span>}
    </div>
    {section.evidence_total ? <p className="rg-muted sp-legend">每条证据下面：含这条证据的分片在向量检索（按意思相近，取前 12 个分片）和关键词检索（按字面匹配，取前 30 个分片）里各排第几；两路结果合并后交给重排模型打分，「最后」是它有没有交给回答模型。</p> : null}
    {section.variants && <ul className="sp-variants">
      {section.variants.map((variant, index) => <li key={variant.name} className={index === 0 ? "is-current" : ""}>
        <strong>{variant.label}</strong>
        <span>{variant.passed} / {section.count} 通过</span>
        <span>触发压缩 {variant.summarized_rate === null ? "—" : `${Math.round(variant.summarized_rate * 100)}%`}</span>
        <span>最后一问平均输入 {variant.input_tokens_avg === null ? "—" : `${Math.round(variant.input_tokens_avg)} Token`}</span>
      </li>)}
    </ul>}
    <ul className="rg-result-list">
      {questions.map((question) => <SpecialQuestion key={question.id} question={question} method={section.method} searchMode={section.search_mode ?? "hybrid"} />)}
    </ul>
  </div>;
}

function SpecialQuestion({ question, method, searchMode }: { question: EvalSpecialQuestion; method: EvalSuiteMethod; searchMode: EvalSuiteSearchMode }) {
  const change = question.previous_passed === undefined || question.previous_passed === null || question.previous_passed === question.passed ? null
    : question.passed ? { label: "新通过", tone: "green" } : { label: "新失败", tone: "red" };
  const judgement = question.judgement;
  return <li className={`rg-result ${question.passed ? "is-ok" : "is-bad"}`}>
    <div className="rg-result-head">
      <span className={`status-tag is-${question.passed ? "green" : "red"}`}>{question.passed ? "通过" : "没通过"}</span>
      {change && <span className={`rg-change is-${change.tone}`}>{change.label}</span>}
      <span className="rg-result-question">{question.question}</span>
    </div>
    {question.evidence && question.evidence.length > 0 && <ul className="sp-evidence">
      {question.evidence.map((item, index) => <li key={index}>
        <span className="sp-evidence-text">{item.text}</span>
        <span className="sp-evidence-ranks" title="含这条证据的分片，在向量检索（按意思相近，取前 12 个分片）和关键词检索（按字面匹配，取前 30 个分片）的结果里各排第几；最后一项是它最终有没有交给回答模型">
          <span className="sp-evidence-label">含证据的分片</span>
          {searchMode === "keyword" ? <span>向量检索：这次没用</span> : <span className={item.dense_rank === null ? "is-miss" : ""}>{rankText("向量", item.dense_rank, 12)}</span>}
          {searchMode === "dense" ? <span>关键词检索：这次没用</span> : <span className={item.keyword_rank === null ? "is-miss" : ""}>{rankText("关键词", item.keyword_rank, 30)}</span>}
          <span className={item.status === "returned" ? "" : "is-miss"}>最后：{EVIDENCE_STATUS[item.status ?? "not_recalled"] ?? item.status}</span>
        </span>
      </li>)}
    </ul>}
    {question.evidence && question.evidence.length > 0 && <EvidenceDetails texts={question.evidence.map((item) => item.text)} />}
    {method !== "retrieval" && <div className="rg-item-meta">
      {judgement?.correctness !== undefined && judgement?.correctness !== null && <span>正确性 {judgement.correctness}</span>}
      {method === "dialogue" && <span>{question.summarized ? "触发了压缩" : "没有压缩"}</span>}
      {method === "answer" && question.found === false && <span>证据没全部返回</span>}
    </div>}
    {(question.answer || judgement?.correctness_reason || question.turns?.length || question.reference_answer) && <details className="rg-details">
      <summary>查看详情</summary>
      {question.turns && question.turns.length > 0 && <div className="rg-text"><span className="rg-muted">前面的提问：</span><ol className="sp-turns">{question.turns.map((turn, index) => <li key={index}>{turn}</li>)}</ol></div>}
      {question.answer && <div className="rg-text"><span className="rg-muted">回答：</span>{question.answer}</div>}
      {question.reference_answer && <div className="rg-text"><span className="rg-muted">参考答案：</span>{question.reference_answer}</div>}
      {judgement?.correctness_reason && <div className="rg-text"><span className="rg-muted">评审意见：</span>{judgement.correctness_reason}</div>}
    </details>}
  </li>;
}
