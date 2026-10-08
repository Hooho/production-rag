import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { activatePromptVersion, getPrompt, listPrompts, savePromptVersion, type PromptBrief, type PromptDetail, type PromptGroup, type PromptVersion } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { MaintenanceHeader } from "./Maintenance";
import "./Prompts.css";

// 提示词管理（只有管理员）：线上问答和文档导入用到的 6 段大模型提示词。
// 每段分成可以修改的「指令」和不能修改的「固定部分」（输出格式、安全规则），发给模型的是两者拼起来。
// 保存生成新版本并立即生效；版本历史里可以对比、载入编辑、改用旧版本（回滚），内置版本永远可以恢复。

type ShowToast = (kind: "success" | "error", message: string) => void;

function formatTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function Prompts({ promptId, onNavigate, onToast }: { promptId: string | null; onNavigate: (path: string) => void; onToast: ShowToast }) {
  const [list, setList] = useState<{ groups: PromptGroup[]; items: PromptBrief[] } | null>(null);
  const [error, setError] = useState("");
  const reload = () => listPrompts().then(setList).catch((reason: Error) => setError(reason.message));
  useEffect(() => { void reload(); }, []);
  const selected = promptId ?? list?.items[0]?.id ?? null;
  return <div className="pr-page">
    <MaintenanceHeader active="prompts" onNavigate={onNavigate}>
        <p className="pr-subtitle">线上问答和文档导入用到的大模型提示词。每段分成可以修改的「指令」和不能修改的「固定部分」（代码要解析的输出格式、安全规则）。保存后生成新版本并立即生效，随时可以改回旧版本或内置版本。</p>
    </MaintenanceHeader>
    {error && <div className="field-error">{error}</div>}
    {!list && !error && <LoadingSkeleton label="正在加载提示词"><SkeletonBlock className="pr-skeleton" /></LoadingSkeleton>}
    {list && <div className="pr-layout">
      <nav className="pr-list" aria-label="提示词列表">
        {list.groups.map((group) => <section key={group.key}>
          <h2>{group.label}</h2>
          <p>{group.description}</p>
          {list.items.filter((item) => item.group === group.key).map((item) =>
            <button type="button" key={item.id} className={item.id === selected ? "pr-item is-active" : "pr-item"} onClick={() => onNavigate(`/maintenance/prompts/${item.id}`)}>
              <strong>{item.label}</strong>
              <span><b className={item.active_version ? "pr-badge is-custom" : "pr-badge"}>{item.active_label}</b>{item.versions > 0 && ` · 共 ${item.versions} 个版本`}</span>
            </button>)}
        </section>)}
      </nav>
      {selected && <PromptEditor key={selected} promptId={selected} onChanged={reload} onToast={onToast} />}
    </div>}
  </div>;
}

function PromptEditor({ promptId, onChanged, onToast }: { promptId: string; onChanged: () => void; onToast: ShowToast }) {
  const [data, setData] = useState<PromptDetail | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  // 输入部分默认显示模板（代码每次填进去的是什么），切换后显示一次调用的示例。
  const [showExample, setShowExample] = useState(false);
  const active = data?.versions.find((item) => item.version === data.active_version) ?? null;
  const apply = (detail: PromptDetail) => {
    setData(detail);
    setDraft(detail.versions.find((item) => item.version === detail.active_version)?.text ?? "");
    setNote("");
    setEditing(false);
  };
  useEffect(() => {
    getPrompt(promptId).then(apply).catch((reason: Error) => setError(reason.message));
  }, [promptId]);
  const dirty = active !== null && draft.trim() !== active.text.trim();

  const save = async () => {
    if (!data || !dirty || !draft.trim()) return;
    setSaving(true);
    try {
      const detail = await savePromptVersion(data.id, draft, note);
      apply(detail);
      onChanged();
      onToast("success", `已保存为 ${detail.active_label}，下一次调用开始生效`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const activate = async (version: PromptVersion) => {
    if (!data) return;
    try {
      const detail = await activatePromptVersion(data.id, version.version);
      apply(detail);
      onChanged();
      onToast("success", `已改用 ${version.label}`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  };

  if (error) return <div className="field-error">{error}</div>;
  if (!data || !active) return <LoadingSkeleton label="正在加载提示词"><SkeletonBlock className="pr-skeleton" /></LoadingSkeleton>;
  return <div className="pr-detail">
    <section className="pr-card">
      <div className="pr-head">
        <h2>{data.label}</h2>
        <span className="pr-current">当前使用 <b className={data.active_version ? "pr-badge is-custom" : "pr-badge"}>{data.active_label}</b>
          {data.activated_at && <small>{data.activated_by} · {formatTime(data.activated_at)}</small>}</span>
      </div>
      <p className="pr-where">{data.where}</p>
      {data.note && <p className="pr-note">{data.note}</p>}

      <div className="pr-legend-bar">
        <span><i className="is-edit" />指令（点击修改）</span>
        {data.locked && <span><i className="is-locked" />{data.locked_label}（固定）</span>}
        <span><i className="is-input" />输入（每次调用时由代码填入）</span>
        <button type="button" className="pr-example-toggle" onClick={() => setShowExample(!showExample)}>{showExample ? "看模板" : "看示例"}</button>
      </div>
      {data.boxes.map((box, boxIndex) => <div className="pr-box" key={boxIndex}>
        <div className="pr-box-title">{box.title}{showExample && box.parts.some((part) => typeof part === "object") ? "（示例）" : ""}</div>
        {box.parts.map((part, partIndex) => {
          if (part === "instructions") return editing
            ? <div className="pr-seg is-edit is-editing" key={partIndex}>
              <textarea className="pr-textarea" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(14, Math.max(4, Math.ceil(draft.length / 60)))} spellCheck={false} />
              <div className="pr-editbar">
                <span className={draft.length > 4000 ? "pr-count is-over" : "pr-count"}>{draft.length} / 4000 字</span>
                <input className="pr-note-input" value={note} maxLength={200} placeholder="修改说明（可选），例如：回答改成先给结论" onChange={(event) => setNote(event.target.value)} />
                <button type="button" className="secondary-button" disabled={saving} onClick={() => { setDraft(active.text); setNote(""); setEditing(false); }}>{dirty ? "撤销修改" : "收起"}</button>
                <button type="button" className="primary-button" disabled={!dirty || saving || !draft.trim() || draft.length > 4000} onClick={() => void save()}>{saving ? "保存中…" : "保存为新版本"}</button>
              </div>
              {dirty && <div className="pr-diff-box"><h4>和当前版本（{active.label}）相比</h4><Diff before={active.text} after={draft} /></div>}
            </div>
            : <Segment key={partIndex} kind="edit" tip="指令：告诉模型怎么判断、怎么做。点击修改，保存后生成新版本。" onClick={() => setEditing(true)}>{draft}</Segment>;
          if (part === "locked") return data.locked ? <Segment key={partIndex} kind="locked" tip={`${data.locked_label}，不能修改。${data.locked_reason}`}>{data.locked_display}</Segment> : null;
          return <Segment key={partIndex} kind="input" tip={showExample
            ? `输入，不能修改：每次调用时由代码填进去的数据，这里是一次调用的示例。${data.input}`
            : `输入，不能修改：每次调用时由代码填进去的数据，尖括号里是要填的内容。${data.input}`}>{showExample ? part.input : part.template}</Segment>;
        })}
      </div>)}
    </section>

    <section className="pr-card">
      <h2>版本历史</h2>
      <ol className="pr-versions">{data.versions.map((version) =>
        <VersionRow key={version.version} version={version} isActive={version.version === data.active_version} activeText={active.text}
          onLoad={() => { setDraft(version.text); setNote(`基于 ${version.label} 修改`); setEditing(true); }} onActivate={() => void activate(version)} />)}
      </ol>
    </section>
  </div>;
}

function VersionRow({ version, isActive, activeText, onLoad, onActivate }: { version: PromptVersion; isActive: boolean; activeText: string; onLoad: () => void; onActivate: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return <li className={isActive ? "is-active" : ""}>
    <div className="pr-version-head">
      <b className={version.version ? "pr-badge is-custom" : "pr-badge"}>{version.label}</b>
      {isActive && <span className="pr-using">当前使用</span>}
      <span className="pr-version-note">{version.note || "（没有填写说明）"}</span>
      <span className="pr-version-meta">{version.created_by ? `${version.created_by} · ${formatTime(version.created)}` : "代码内置"}</span>
      <span className="pr-version-actions">
        <button type="button" className="secondary-button" onClick={() => setOpen(!open)}>{open ? "收起" : "查看"}</button>
        <button type="button" className="secondary-button" onClick={onLoad}>载入编辑</button>
        {!isActive && (confirming
          ? <><button type="button" className="primary-button" onClick={() => { setConfirming(false); onActivate(); }}>确认改用</button>
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>取消</button></>
          : <button type="button" className="secondary-button" onClick={() => setConfirming(true)}>改用这个版本</button>)}
      </span>
    </div>
    {open && <div className="pr-version-body">
      {isActive ? <pre className="pr-text">{version.text}</pre> : <><h4>和当前使用的版本相比</h4><Diff before={activeText} after={version.text} /></>}
    </div>}
  </li>;
}

// 按分句对比：提示词大多是一整段中文，没有换行，按行对比只能看出「整段变了」。
function split(text: string) {
  return text.match(/[^。；！？\n]+[。；！？\n]?/g) ?? [];
}

type Piece = { kind: "same" | "added" | "removed"; text: string };

function diffPieces(before: string, after: string): Piece[] {
  const a = split(before);
  const b = split(after);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pieces: Piece[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { pieces.push({ kind: "same", text: a[i] }); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { pieces.push({ kind: "added", text: b[j] }); j += 1; }
    else { pieces.push({ kind: "removed", text: a[i] }); i += 1; }
  }
  return pieces;
}

function Diff({ before, after }: { before: string; after: string }) {
  const pieces = useMemo(() => diffPieces(before, after), [before, after]);
  if (before === after) return <p className="pr-help">内容相同。</p>;
  return <>
    <p className="pr-diff">{pieces.map((piece, index) => piece.kind === "same" ? <span key={index}>{piece.text}</span>
      : piece.kind === "added" ? <ins key={index}>{piece.text}</ins> : <del key={index}>{piece.text}</del>)}</p>
    <p className="pr-legend"><ins>新增</ins><del>删除</del></p>
  </>;
}

// 完整提示词里的一段。hover 或聚焦（手机上点一下）时显示说明；指令段点击进入编辑。
// 说明气泡挂到 body 上按视口定位，不会被卡片或导航栏挡住。
function Segment({ kind, tip, onClick, children }: { kind: "edit" | "locked" | "input"; tip: string; onClick?: () => void; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left + 24), window.innerWidth - width - 8);
    setStyle(rect.top > 120 ? { left, width, bottom: window.innerHeight - rect.top + 6 } : { left, width, top: rect.bottom + 6 });
  };
  const hide = () => setStyle(null);
  return <div ref={anchor} className={`pr-seg is-${kind}`} tabIndex={0} role={onClick ? "button" : undefined} aria-label={tip}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
    onClick={onClick} onKeyDown={(event) => { if (onClick && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onClick(); } }}>
    {children}
    {style && createPortal(<span className="pr-tip" role="tooltip" style={style}>{tip}</span>, document.body)}
  </div>;
}
