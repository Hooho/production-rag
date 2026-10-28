import { useEffect, useState } from "react";
import { listEvalTargetChunks, type EvalScoringGroup, type EvalScoringTarget } from "./api";
import { DetailDialog } from "./DetailDialog";
import { EvidenceTargetTags } from "./EvidenceTargetTags";

const targetKey = (target: EvalScoringTarget) => `${target.title}:${target.position}:${target.fingerprint}`;

export function ScoringItemEditor({ groups, onChange }: { groups: EvalScoringGroup[]; onChange: (value: EvalScoringGroup[]) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<EvalScoringTarget[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (active === null || catalog) return;
    let cancelled = false;
    setError("");
    listEvalTargetChunks().then((data) => { if (!cancelled) setCatalog(data.items); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读取分片失败"); });
    return () => { cancelled = true; };
  }, [active, catalog]);
  function update(index: number, changes: Partial<EvalScoringGroup>) {
    onChange(groups.map((group, i) => i === index ? { ...group, ...changes } : group));
  }
  const group = active === null ? undefined : groups[active];
  const chosen = new Set(group?.targets.map(targetKey));
  const needle = search.trim().toLowerCase();
  const filtered = (catalog ?? []).filter((target) => (!title || target.title === title)
    && (!needle || `${target.position + 1} ${target.quote}`.toLowerCase().includes(needle)));
  return <div className="sp-scoring-editor">
    {groups.map((item, index) => <div className="sp-scoring-item" key={index}>
      <div className="sp-scoring-heading"><label>计分项 {index + 1}<input aria-label={`计分项 ${index + 1}名称`} value={item.label} maxLength={100}
        placeholder="例如：诺基亚" onChange={(event) => update(index, { label: event.target.value })} /></label>
        <button type="button" className="rg-link" onClick={() => onChange(groups.filter((_, i) => i !== index))}>移除计分项</button></div>
      {item.targets.length > 0 && <div className="sp-scoring-targets">{item.targets.map((target) => <div className="sp-scoring-target" key={targetKey(target)}>
        <EvidenceTargetTags targets={[target]} number={index + 1} />
        <button type="button" className="rg-link" aria-label={`移除第 ${target.position + 1} 片`} onClick={() => update(index, {
          targets: item.targets.filter((chosen) => targetKey(chosen) !== targetKey(target))
        })}>×</button>
      </div>)}</div>}
      <button type="button" className="rg-link" onClick={() => { setActive(index); setSearch(""); setTitle(""); }}>选择分片（已选 {item.targets.length} 片）</button>
    </div>)}
    <button type="button" className="secondary-button" disabled={groups.length >= 10} onClick={() => onChange([...groups, { label: "", targets: [] }])}>＋ 添加计分项</button>
    <small className="rg-muted">每项至少选择一个分片；命中其中任意一个即得该项分数。</small>
    <DetailDialog open={group !== undefined} title={`选择目标分片 · ${group?.label || "未命名计分项"}`} onClose={() => setActive(null)}>
      <div className="sp-chunk-filters">
        <select aria-label="筛选书籍" value={title} onChange={(event) => setTitle(event.target.value)}><option value="">全部书籍</option>
          {[...new Set((catalog ?? []).map((target) => target.title))].map((name) => <option key={name}>{name}</option>)}</select>
        <input aria-label="搜索分片" placeholder="搜索分片编号或正文" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {error ? <p role="alert">{error}</p> : !catalog ? <p role="status">正在读取分片…</p> : <div className="sp-chunk-options">
        {!filtered.length && <p className="rg-muted">没有符合条件的分片</p>}
        {filtered.map((target) => <div className="sp-chunk-option" key={targetKey(target)}>
          <label><input type="checkbox" checked={chosen.has(targetKey(target))} onChange={(event) => {
            if (active === null || !group) return;
            update(active, { targets: event.target.checked ? [...group.targets, target]
              : group.targets.filter((item) => targetKey(item) !== targetKey(target)) });
          }} /><span><strong>第 {target.position + 1} 片 · {target.title}</strong><small>{target.quote.slice(0, 140)}{target.quote.length > 140 ? "…" : ""}</small></span></label>
          <EvidenceTargetTags targets={[target]} number={(active ?? 0) + 1} />
        </div>)}
      </div>}
      <div className="rg-buttons"><span className="rg-muted">已选 {group?.targets.length ?? 0} 片</span><button type="button" className="primary-button" onClick={() => setActive(null)}>完成选择</button></div>
    </DetailDialog>
  </div>;
}
