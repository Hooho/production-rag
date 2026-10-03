import { useEffect, useMemo, useRef, useState } from "react";
import { listGroups, listUsers, type AuthUser, addEvalSetItems, createEvalSet, deleteEvalSet, deleteEvalSetItem, getEvalSet, getEvalSetRun, listEvalDocuments, listEvalSets, startEvalSetRun, updateEvalSet, updateEvalSetItem, type EvalSetBrief, type EvalSetDocument, type EvalSetExpect, type EvalSetFull, type EvalSetItem, type EvalSetKind, type EvalSetLatest, type EvalSetResult, type EvalSetRun, type EvalSetRunFull } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./Regression.css";

// 线上回归集：题目是真实用户问过的问题（多数从知识巡检加入），按提问人的权限在线上知识库里跑，
// 回答"之前出过问题的这些提问，现在还好吗"。和"评测集"页签的基准集分开，那边跑在固定的评测语料上。
type ShowToast = (kind: "success" | "error", message: string) => void;
type Props = { setId: string | null; onNavigate: (path: string) => void; onToast: ShowToast };

const KIND_LABELS: Record<EvalSetKind, string> = { retrieval: "检索评测", generation: "生成评测" };
const KIND_HINTS: Record<EvalSetKind, string> = {
  retrieval: "按提问人的权限检索一遍，看能不能找到资料。不调用大模型，几秒钟。",
  generation: "以提问人的身份完整问一遍，看实际怎么回答。会调用大模型，每题十几秒。",
};
const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "运行中", tone: "blue" }, completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" }, interrupted: { label: "已中断", tone: "orange" },
};

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  const text = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? text : `${date.getFullYear()}-${text}`;
}

function passText(summary: { passed?: number; total?: number }) {
  return `${summary.passed ?? 0} / ${summary.total ?? 0} 通过`;
}

export default function Regression({ setId, onNavigate, onToast }: Props) {
  return setId
    ? <SetDetail setId={setId} onBack={() => onNavigate("/eval/regression")} onToast={onToast} />
    : <SetList onOpen={(id) => onNavigate(`/eval/regression/${encodeURIComponent(id)}`)} onToast={onToast} />;
}

function SetList({ onOpen, onToast }: { onOpen: (id: string) => void; onToast: ShowToast }) {
  const [sets, setSets] = useState<EvalSetBrief[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listEvalSets().then((data) => setSets(data.items)).catch((reason: Error) => onToast("error", reason.message));
  }, []);

  async function create() {
    setBusy(true);
    try {
      const created = await createEvalSet(name.trim(), description.trim() || undefined);
      onOpen(created.id);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="rg-root">
    <div className="rg-intro">
      <p>回归集里是真实用户问过的问题，按提问人的权限在线上知识库里检查：之前出过问题的提问，现在还好吗。每次补资料、调检索、改提示词之后跑一遍，看有没有改好，有没有改坏别的。</p>
      <p>题目一般在知识巡检的问题详情里点「加入评测集」添加，也可以在评测集里手动添加。</p>
      {!creating && <button type="button" className="primary-button" onClick={() => setCreating(true)}>新建回归集</button>}
    </div>
    {creating && <div className="rg-form">
      <label className="rg-field"><span>名字</span><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="例如：售后问题回归" autoFocus /></label>
      <label className="rg-field"><span>说明</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label>
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => setCreating(false)} disabled={busy}>取消</button>
        <button type="button" className="primary-button" onClick={() => void create()} disabled={busy || !name.trim()}>创建</button>
      </div>
    </div>}
    {sets === null ? <LoadingSkeleton label="正在加载回归集"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton>
      : sets.length === 0 ? <div className="rg-empty">还没有回归集。</div>
      : <ul className="rg-sets">
        {sets.map((item) => <li key={item.id}>
          <button type="button" className="rg-set" onClick={() => onOpen(item.id)}>
            <span className="rg-set-name">{item.name}</span>
            {item.description && <span className="rg-set-description">{item.description}</span>}
            <span className="rg-set-meta">
              <span>{item.item_count} 题</span>
              {(["retrieval", "generation"] as EvalSetKind[]).map((kind) => <LatestTag key={kind} kind={kind} latest={item.latest[kind]} />)}
            </span>
          </button>
        </li>)}
      </ul>}
  </div>;
}

function LatestTag({ kind, latest }: { kind: EvalSetKind; latest?: EvalSetLatest }) {
  if (!latest) return <span className="rg-muted">{KIND_LABELS[kind]}：还没跑过</span>;
  if (latest.status !== "completed") return <span>{KIND_LABELS[kind]}：{RUN_STATUS[latest.status]?.label ?? latest.status}</span>;
  const all = latest.summary.passed === latest.summary.total;
  return <span>{KIND_LABELS[kind]}：<strong className={all ? "is-pass" : "is-fail"}>{passText(latest.summary)}</strong>（{formatTime(latest.finished)}）</span>;
}

function SetDetail({ setId, onBack, onToast }: { setId: string; onBack: () => void; onToast: ShowToast }) {
  const [data, setData] = useState<EvalSetFull | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<EvalSetRunFull | null>(null);
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  // 正在编辑的题目编号；同一时间只编辑一道。
  const [editing, setEditing] = useState<string | null>(null);

  async function load() {
    const value = await getEvalSet(setId);
    setData(value);
    return value;
  }

  useEffect(() => {
    setRunId(null);
    load().then((value) => {
      const finished = value.runs.find((item) => item.status === "completed");
      setRunId((value.runs.find((item) => item.status === "running") ?? finished ?? value.runs[0])?.id ?? null);
    }).catch((reason: Error) => onToast("error", reason.message));
  }, [setId]);

  const running = data?.runs.find((item) => item.status === "running") ?? null;
  // 有运行中的评测时每两秒刷新进度；跑完后重新读取选中的结果。
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [running?.id]);

  const selectedStatus = data?.runs.find((item) => item.id === runId)?.status;
  useEffect(() => {
    if (!runId || selectedStatus === "running") {
      setRun(null);
      return;
    }
    let cancelled = false;
    getEvalSetRun(setId, runId).then((value) => { if (!cancelled) setRun(value); }).catch((reason: Error) => onToast("error", reason.message));
    return () => { cancelled = true; };
  }, [runId, selectedStatus]);

  async function start(kind: EvalSetKind) {
    setStarting(true);
    try {
      const created = await startEvalSetRun(setId, kind);
      await load();
      setRunId(created.id);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function saveName() {
    try {
      setData(await updateEvalSet(setId, { name: name.trim(), description: description.trim() }));
      setRenaming(false);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  async function remove() {
    try {
      await deleteEvalSet(setId);
      onToast("success", "已删除回归集");
      onBack();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  async function removeItem(itemId: string) {
    try {
      await deleteEvalSetItem(setId, itemId);
      await load();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  if (!data) return <div className="rg-root"><LoadingSkeleton label="正在加载回归集"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line-short" /></LoadingSkeleton></div>;
  return <div className="rg-root">
    <button type="button" className="rg-back" onClick={onBack}>← 全部回归集</button>
    {renaming ? <div className="rg-form">
      <label className="rg-field"><span>名字</span><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
      <label className="rg-field"><span>说明</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label>
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => setRenaming(false)}>取消</button>
        <button type="button" className="primary-button" onClick={() => void saveName()} disabled={!name.trim()}>保存</button>
      </div>
    </div> : <div className="rg-title">
      <div>
        <h3>{data.name}</h3>
        {data.description && <p>{data.description}</p>}
      </div>
      <div className="rg-buttons">
        <button type="button" className="secondary-button" onClick={() => { setName(data.name); setDescription(data.description ?? ""); setRenaming(true); }}>修改名字</button>
        {confirmDelete
          ? <><button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="rg-danger" onClick={() => void remove()}>确认删除（题目和运行记录一起删除）</button></>
          : <button type="button" className="secondary-button" onClick={() => setConfirmDelete(true)}>删除</button>}
      </div>
    </div>}

    <div className="rg-launch">
      {(["retrieval", "generation"] as EvalSetKind[]).map((kind) => <div key={kind} className="rg-launch-option">
        <button type="button" className={kind === "retrieval" ? "primary-button" : "secondary-button"} disabled={starting || Boolean(running) || data.items.length === 0} onClick={() => void start(kind)}>运行{KIND_LABELS[kind]}</button>
        <span>{KIND_HINTS[kind]}</span>
      </div>)}
      {running && <div className="rg-progress">正在运行{KIND_LABELS[running.kind]}：{running.summary.done ?? 0} / {running.summary.total ?? data.items.length}</div>}
    </div>

    {data.runs.length > 0 && <section className="rg-section">
      <h4>运行记录</h4>
      <div className="rg-runs" role="tablist">
        {data.runs.map((item) => <RunChip key={item.id} run={item} selected={item.id === runId} onClick={() => setRunId(item.id)} />)}
      </div>
      {run && run.id === runId && <RunResults run={run} />}
      {runId && selectedStatus === "running" && <p className="rg-muted">跑完后这里显示逐题结果。</p>}
    </section>}

    <section className="rg-section">
      <div className="rg-section-head">
        <h4>题目（{data.items.length}）</h4>
        {!adding && <button type="button" className="secondary-button" onClick={() => { setEditing(null); setAdding(true); }}>添加题目</button>}
      </div>
      {adding && <ItemForm setId={setId} onToast={onToast} onDone={(changed) => { setAdding(false); if (changed) void load(); }} />}
      {data.items.length === 0 && !adding && <p className="rg-muted">还没有题目。在知识巡检的问题详情里点「加入评测集」，或点「添加题目」手动添加。</p>}
      <ul className="rg-items">
        {data.items.map((item) => editing === item.id ? <li key={item.id}><ItemForm setId={setId} initial={item} onToast={onToast} onDone={(changed) => { setEditing(null); if (changed) void load(); }} /></li> : <li key={item.id} className="rg-item">
          <div className="rg-item-main">
            <div className="rg-item-question">{item.question}</div>
            <div className="rg-item-meta">
              <span className={`rg-expect is-${item.expect}`}>{item.expect_label}</span>
              <span>提问人 {item.asker}</span>
              {item.documents.length > 0 && <span>期望命中 {item.documents.map((document) => `《${document.title}》`).join("、")}</span>}
              {item.issue_id && <span>来自知识巡检</span>}
            </div>
            {item.reference_answer && <details className="rg-details"><summary>参考答案</summary><div className="rg-text">{item.reference_answer}</div></details>}
          </div>
          <div className="rg-item-actions">
            <button type="button" className="rg-link is-edit" onClick={() => { setAdding(false); setEditing(item.id); }}>编辑</button>
            <button type="button" className="rg-link" onClick={() => void removeItem(item.id)}>移除</button>
          </div>
        </li>)}
      </ul>
    </section>
  </div>;
}

function RunChip({ run, selected, onClick }: { run: EvalSetRun; selected: boolean; onClick: () => void }) {
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "gray" };
  return <button type="button" role="tab" aria-selected={selected} className={`rg-run ${selected ? "is-selected" : ""}`} onClick={onClick}>
    <span>{run.kind_label}</span>
    <span className="rg-muted">{formatTime(run.started)}</span>
    {run.status === "completed" ? <strong className={run.summary.passed === run.summary.total ? "is-pass" : "is-fail"}>{passText(run.summary)}</strong> : <span className={`status-tag is-${status.tone}`}>{status.label}</span>}
  </button>;
}

const CHANGE_LABELS: Record<string, { label: string; tone: string }> = {
  fixed: { label: "新通过", tone: "green" }, regressed: { label: "新失败", tone: "red" }, new: { label: "新加入", tone: "gray" },
};

// 一次运行的结果：先看总数和与上次相比的变化，没通过的排在前面。
function RunResults({ run }: { run: EvalSetRunFull }) {
  if (run.status === "failed" || run.status === "interrupted") return <p className="rg-error">{run.error ?? "运行失败"}</p>;
  const summary = run.summary;
  const changes = summary.changes ?? {};
  const results = [...run.results].sort((a, b) => Number(a.passed) - Number(b.passed));
  return <div className="rg-results">
    <div className="rg-summary">
      <span><strong>{passText(summary)}</strong>{typeof summary.pass_rate === "number" && `（${Math.round(summary.pass_rate * 100)}%）`}</span>
      {summary.by_expect?.answer && <span>应该回答 {summary.by_expect.answer.passed} / {summary.by_expect.answer.total}</span>}
      {summary.by_expect?.refuse && <span>应该拒答 {summary.by_expect.refuse.passed} / {summary.by_expect.refuse.total}</span>}
      {summary.previous ? <span>和上次（{formatTime(summary.previous.started)}）比：新通过 {changes.fixed ?? 0}，新失败 <strong className={changes.regressed ? "is-fail" : ""}>{changes.regressed ?? 0}</strong></span> : <span className="rg-muted">这是第一次运行{KIND_LABELS[run.kind]}，没有可比较的上次结果</span>}
    </div>
    <ul className="rg-result-list">
      {results.map((result) => <ResultItem key={result.item_id} result={result} />)}
    </ul>
  </div>;
}

function ResultItem({ result }: { result: EvalSetResult }) {
  const change = result.change ? CHANGE_LABELS[result.change] : null;
  const hasDetail = (result.documents?.length ?? 0) > 0 || Boolean(result.answer) || Boolean(result.judge?.correctness_reason);
  return <li className={`rg-result ${result.passed ? "is-ok" : "is-bad"}`}>
    <div className="rg-result-head">
      <span className={`status-tag is-${result.passed ? "green" : "red"}`}>{result.passed ? "通过" : "没通过"}</span>
      {change && <span className={`rg-change is-${change.tone}`}>{change.label}</span>}
      <span className="rg-result-question">{result.question}</span>
    </div>
    <div className="rg-item-meta">
      <span className={`rg-expect is-${result.expect}`}>{result.expect === "answer" ? "应该回答" : "应该拒答"}</span>
      <span>提问人 {result.asker}</span>
      <span>{result.reason}</span>
      {typeof result.top_score === "number" && <span>最相关资料 {result.top_score.toFixed(2)} 分</span>}
    </div>
    {hasDetail && <details className="rg-details">
      <summary>查看详情</summary>
      {result.documents && result.documents.length > 0 && <div className="rg-text">检索到的文档：{result.documents.map((document) => `《${document.title}》${typeof document.score === "number" ? ` ${document.score.toFixed(2)} 分` : ""}`).join("、")}</div>}
      {result.answer && <div className="rg-text"><span className="rg-muted">回答：</span>{result.answer}</div>}
      {result.judge?.correctness_reason && <div className="rg-text"><span className="rg-muted">评审意见：</span>{result.judge.correctness_reason}</div>}
    </details>}
  </li>;
}

// 添加或编辑一道题。期望命中的文档可选：填了之后，只有检索到或回答用到其中一份才算通过。
function ItemForm({ setId, initial, onToast, onDone }: { setId: string; initial?: EvalSetItem; onToast: ShowToast; onDone: (changed: boolean) => void }) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [asker, setAsker] = useState(initial?.asker ?? "");
  const [expect, setExpect] = useState<EvalSetExpect>(initial?.expect ?? "answer");
  const [documents, setDocuments] = useState<EvalSetDocument[]>(initial?.documents ?? []);
  const [reference, setReference] = useState(initial?.reference_answer ?? "");
  const [options, setOptions] = useState<EvalSetDocument[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listEvalDocuments().then((value) => setOptions(value.documents)).catch(() => setOptions([]));
  }, []);

  async function submit() {
    setBusy(true);
    const payload = { question: question.trim(), asker: asker.trim(), expect,
      documents: expect === "answer" ? documents.map((document) => document.doc_key) : [],
      reference_answer: expect === "answer" ? reference.trim() || null : null };
    try {
      if (initial) await updateEvalSetItem(setId, initial.id, { ...payload, note: initial.note, issue_id: initial.issue_id });
      else await addEvalSetItems(setId, [payload]);
      onDone(true);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const available = options.filter((option) => !documents.some((document) => document.doc_key === option.doc_key));
  return <div className="rg-form">
    <div className="rg-form-title">{initial ? "编辑题目" : "添加题目"}</div>
    <label className="rg-field"><span>问题</span><input value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} placeholder="完整的问题，不要用「那它呢」这类依赖上文的说法" autoFocus /></label>
    <div className="rg-field"><span>提问人</span><UserPicker value={asker} onChange={setAsker} /></div>
    <div className="rg-field"><span>期望结果</span>
      <div className="rg-radios" role="radiogroup">
        {(["answer", "refuse"] as EvalSetExpect[]).map((key) => <label key={key}><input type="radio" name={`rg-expect-${initial?.id ?? "new"}`} checked={expect === key} onChange={() => setExpect(key)} />{key === "answer" ? "应该回答" : "应该拒答"}</label>)}
      </div>
    </div>
    {expect === "answer" && <div className="rg-field is-top"><span>期望命中</span>
      <div className="rg-documents">
        {documents.map((document) => <span key={document.doc_key} className="rg-document">《{document.title}》<button type="button" aria-label={`去掉《${document.title}》`} onClick={() => setDocuments(documents.filter((item) => item.doc_key !== document.doc_key))}>×</button></span>)}
        <select value="" onChange={(event) => { const picked = options.find((option) => option.doc_key === event.target.value); if (picked) setDocuments([...documents, { doc_key: picked.doc_key, title: picked.title }]); }}>
          <option value="">{documents.length ? "再加一份文档…" : "不限文档（可选）"}</option>
          {available.map((option) => <option key={option.doc_key} value={option.doc_key}>{option.title}</option>)}
        </select>
      </div>
    </div>}
    {expect === "answer" && <label className="rg-field is-top"><span>参考答案</span><textarea value={reference} maxLength={4000} rows={2} onChange={(event) => setReference(event.target.value)} placeholder="可选：正确的说法。生成评测时由评审模型核对回答和它是否一致。" /></label>}
    <div className="rg-buttons">
      <button type="button" className="secondary-button" onClick={() => onDone(false)} disabled={busy}>取消</button>
      <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || !question.trim() || !asker}>{initial ? "保存" : "添加"}</button>
    </div>
  </div>;
}

// 选择提问人：输入用户名或部门搜索，从列表里选；只能选现有用户，题目会按他的权限检索。
function UserPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listUsers().then((data) => setUsers(data.users)).catch(() => setUsers([]));
    listGroups().then((data) => setGroupNames(Object.fromEntries(data.groups.map((group) => [group.id, group.name])))).catch(() => undefined);
  }, []);

  // 点到选择框外面时收起列表；没选中有效用户就恢复成原来的值。
  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery(value);
      }
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, value]);

  const describe = (user: AuthUser) => [user.groups.map((id) => groupNames[id] ?? id).join("、"), user.is_admin ? "管理员" : "", user.disabled ? "已停用" : ""].filter(Boolean).join(" · ");
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || text === value.toLowerCase()) return users;
    return users.filter((user) => user.username.toLowerCase().includes(text) || describe(user).toLowerCase().includes(text));
  }, [query, users, groupNames, value]);

  function pick(user: AuthUser) {
    onChange(user.username);
    setQuery(user.username);
    setOpen(false);
  }

  return <div className="rg-picker" ref={box}>
    <input value={query} placeholder="搜索用户名或部门" role="combobox" aria-expanded={open} aria-autocomplete="list"
      onFocus={() => { setOpen(true); setActive(0); }}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(Math.min(active + 1, matches.length - 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(active - 1, 0)); }
        else if (event.key === "Enter" && open && matches[active]) { event.preventDefault(); pick(matches[active]); }
        else if (event.key === "Escape") { setOpen(false); setQuery(value); }
      }} />
    {open && <ul className="rg-picker-list" role="listbox">
      {matches.length === 0 && <li className="rg-picker-empty">没有找到匹配的用户</li>}
      {matches.map((user, index) => <li key={user.username} role="option" aria-selected={user.username === value}
        className={`${index === active ? "is-active" : ""} ${user.username === value ? "is-selected" : ""}`}
        onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); pick(user); }}>
        <strong>{user.username}</strong>{describe(user) && <span>{describe(user)}</span>}
      </li>)}
    </ul>}
  </div>;
}
