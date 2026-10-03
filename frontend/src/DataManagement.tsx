import { useEffect, useState } from "react";
import { DataRequestError, commitDataBatch, createDataRecord, deleteDataBatch, deleteDataRecord, generateDataPreview, listDataOptions, listDataRecords, listDataTypes, updateDataRecord, type DataAction, type DataField, type DataPage, type DataPreview, type DataRow, type DataType, type DataValue } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./DataManagement.css";

type ShowToast = (kind: "success" | "error", message: string) => void;
type Values = Record<string, DataValue>;

// 业务数据页：每种业务数据一个 Tab，只显示当前用户有查看权限的类型。
// 表格列、表单、按钮都按后端返回的字段配置和权限生成，新增一种数据不用改这个页面。
export default function DataManagement({ onToast }: { onToast: ShowToast }) {
  const [types, setTypes] = useState<DataType[] | null>(null);
  const [active, setActive] = useState("");

  useEffect(() => {
    listDataTypes().then((result) => {
      setTypes(result.types);
      if (result.types.length > 0) setActive(result.types[0].key);
    }).catch((reason: Error) => {
      setTypes([]);
      onToast("error", reason.message);
    });
  }, []);

  const current = types?.find((item) => item.key === active) ?? null;
  return <div className="data-page">
    <header className="topbar"><div><h1>业务数据</h1><p className="data-subtitle">录入和维护业务数据；有权限的数据也可以直接在知识问答里用自然语言查询。</p></div></header>
    {types === null && <DataTypesSkeleton />}
    {types !== null && types.length === 0 && <div className="data-empty">你还没有任何业务数据的查看权限，请联系管理员在「设置 → 数据权限」中为你所在的部门开通。</div>}
    {types !== null && types.length > 0 && <div className="document-detail-tabs data-tabs" role="tablist">
      {types.map((item) => <button key={item.key} role="tab" aria-selected={item.key === active} className={item.key === active ? "active" : ""} onClick={() => setActive(item.key)}>{item.label}</button>)}
    </div>}
    {current && <DataTable key={current.key} type={current} onToast={onToast} />}
  </div>;
}

// 数据类型首次读取时预留标题、页签和表格轮廓；原来的“加载中…”会让页面从一行文字突然跳成完整表格。
function DataTypesSkeleton() {
  return <LoadingSkeleton className="data-types-skeleton" label="正在加载数据类型">
    <SkeletonBlock className="skeleton-line" />
    <div className="data-tabs-skeleton"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
    <DataTableSkeleton columns={5} />
  </LoadingSkeleton>;
}

// 表格里显示一个字段的值：引用字段显示名称，空值显示短横线，长文本截断。
function displayValue(row: DataRow, field: DataField) {
  const value = row[field.name];
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "ref") return String(row[`${field.name}_label`] ?? value);
  const text = String(value);
  if (field.type === "text" && text.length > 24) return text.slice(0, 24) + "…";
  // 状态类枚举以前直接输出文字，和普通字段混在一起不好扫读；有颜色配置时渲染成胶囊标签。
  const tone = field.tones?.[text];
  if (field.type === "enum" && tone) return <span className={`status-tag is-${tone}`}>{text}</span>;
  return text;
}

// 一种数据的列表：搜索、来源筛选、排序、分页，以及新增、编辑、删除、AI 生成入口。
function DataTable({ type, onToast }: { type: DataType; onToast: ShowToast }) {
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState("");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DataPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DataRow | "new" | null>(null);
  const [generating, setGenerating] = useState(false);
  const can = (action: DataAction) => type.permissions.includes(action);
  const columns = type.fields.filter((field) => field.name !== "owner");

  async function reload() {
    setLoading(true);
    try {
      setData(await listDataRecords(type.key, { q: query, source, sort, direction, page }));
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [query, source, sort, direction, page]);

  // 点击表头排序：同一列再次点击切换升降序。
  function toggleSort(name: string) {
    if (sort === name) {
      setDirection(direction === "asc" ? "desc" : "asc");
    } else {
      setSort(name);
      setDirection("asc");
    }
    setPage(1);
  }

  function search() {
    setPage(1);
    setQuery(keyword.trim());
  }

  async function remove(row: DataRow) {
    if (!window.confirm(`确定删除${type.label} ${row.id}？删除后列表和问答里都不再出现（数据库保留记录，可由管理员恢复）。`)) return;
    try {
      await deleteDataRecord(type.key, row.id);
      onToast("success", `已删除 ${row.id}`);
      await reload();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  async function removeBatch(batchId: string) {
    if (!window.confirm("确定删除这一批 AI 生成的全部数据？")) return;
    try {
      const result = await deleteDataBatch(type.key, batchId);
      onToast("success", `已删除这一批的 ${result.deleted} 条数据`);
      await reload();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return <section className="data-section">
    <p className="data-hint">{type.description}</p>
    <div className="data-toolbar">
      <input className="data-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder={`搜索编号或${type.label}内容`} />
      <button type="button" className="secondary-button data-small" onClick={search}>搜索</button>

      <div className="data-toolbar-actions">
        {can("create") && <button type="button" className="secondary-button data-small" onClick={() => setGenerating(true)}>✦ AI 生成</button>}
        {can("create") && <button type="button" className="primary-button data-small" onClick={() => setEditing("new")}>＋ 手动录入</button>}
      </div>
    </div>
    <div className="data-table-wrap">
      {loading ? <DataTableSkeleton columns={columns.length + 3} /> : <table className="data-table">
        <thead><tr>
          <th><button type="button" onClick={() => toggleSort("id")}>编号{sort === "id" ? (direction === "asc" ? " ↑" : " ↓") : ""}</button></th>
          {columns.map((field) => <th key={field.name}>{field.type === "text" ? field.label : <button type="button" onClick={() => toggleSort(field.name)}>{field.label}{sort === field.name ? (direction === "asc" ? " ↑" : " ↓") : ""}</button>}</th>)}
          <th>来源</th>
          <th>操作</th>
        </tr></thead>
        <tbody>
          {data && data.items.length === 0 && <tr><td className="data-empty-row" colSpan={columns.length + 3}>暂无数据</td></tr>}
          {data?.items.map((row) => <tr key={row.id}>
            <td className="data-id">{row.id}</td>
            {columns.map((field) => <td key={field.name} title={row[field.name] === null ? "" : String(row[field.name])}>{displayValue(row, field)}</td>)}
            <td>{row.source === "ai" ? <span className="data-badge ai" title={`批次 ${row.batch_id}`}>AI</span> : <span className="data-badge">手动</span>}</td>
            <td className="data-actions">
              {can("update") && <button type="button" className="secondary-button data-mini" onClick={() => setEditing(row)}>编辑</button>}
              {can("delete") && <button type="button" className="delete-button" onClick={() => void remove(row)}>删除</button>}
              {can("delete") && row.source === "ai" && row.batch_id && <button type="button" className="delete-button" onClick={() => void removeBatch(row.batch_id as string)} title="删除同一次 AI 生成写入的全部数据">删除本批</button>}
            </td>
          </tr>)}
        </tbody>
      </table>}
    </div>
    <div className="data-pager">
      <span>共 {data?.total ?? 0} 条 · 第 {page} / {totalPages} 页</span>
      <button type="button" className="secondary-button data-mini" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <button type="button" className="secondary-button data-mini" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>
    {editing && <RecordForm type={type} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); onToast("success", message); void reload(); }} />}
    {generating && <GeneratePanel type={type} onClose={() => setGenerating(false)} onToast={onToast} onCommitted={() => { setGenerating(false); setSource("ai"); setPage(1); void reload(); }} />}
  </section>;
}

// 表格查询和筛选期间保持列宽与行高的占位结构，避免用一行“加载中…”替换整张表。
function DataTableSkeleton({ columns }: { columns: number }) {
  const rows = [];
  for (let row = 0; row < 5; row += 1) {
    const cells = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(<td key={column}><SkeletonBlock className={column === 0 ? "skeleton-line-short" : "skeleton-line"} /></td>);
    }
    rows.push(<tr key={row}>{cells}</tr>);
  }
  return <table className="data-table data-skeleton-table" aria-hidden="true"><tbody>{rows}</tbody></table>;
}

// 可以填写的字段：派生字段（如订单金额）由系统计算，不出现在表单里。
function editableFields(type: DataType) {
  return type.fields.filter((field) => !field.derived);
}

// 新增时的初始值：有默认值的字段先填好。编辑时用原记录的值。
function initialValues(type: DataType, row: DataRow | null) {
  const values: Values = {};
  for (const field of editableFields(type)) {
    if (row) {
      values[field.name] = row[field.name] ?? null;
    } else {
      values[field.name] = field.default ?? null;
    }
  }
  return values;
}

// 手动录入 / 编辑表单。编辑时只提交改过的字段；后端返回的字段错误显示在对应输入框下面。
function RecordForm({ type, row, onClose, onSaved }: { type: DataType; row: DataRow | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(type, row));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const original = initialValues(type, row);

  function change(name: string, value: DataValue) {
    setValues({ ...values, [name]: value });
    const rest = { ...errors };
    delete rest[name];
    setErrors(rest);
  }

  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      if (row) {
        const changed: Values = {};
        for (const field of editableFields(type)) {
          if (values[field.name] !== original[field.name]) changed[field.name] = values[field.name];
        }
        await updateDataRecord(type.key, row.id, changed);
        onSaved(`已保存 ${row.id}`);
      } else {
        const result = await createDataRecord(type.key, values);
        onSaved(`已新增${type.label} ${result.id}`);
      }
    } catch (reason) {
      if (reason instanceof DataRequestError) setErrors(reason.errors);
      setMessage((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="data-modal-backdrop" onClick={onClose}>
    <div className="data-modal" role="dialog" aria-label={row ? `编辑${type.label}` : `新增${type.label}`} onClick={(event) => event.stopPropagation()}>
      <header><h2>{row ? `编辑${type.label} ${row.id}` : `手动录入${type.label}`}</h2><button type="button" className="data-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="data-form">
        {editableFields(type).map((field) => <label key={field.name} className={field.type === "text" ? "data-form-wide" : ""}>
          <span>{field.label}{field.required && <em>*</em>}</span>
          <FieldInput field={field} value={values[field.name]} label={row ? String(row[`${field.name}_label`] ?? "") : ""} onChange={(value) => change(field.name, value)} />
          {errors[field.name] && <small className="data-field-error">{errors[field.name]}</small>}
        </label>)}
        {type.fields.filter((field) => field.derived).map((field) => <p key={field.name} className="data-hint">{field.label}由系统根据其他字段自动计算，无需填写。</p>)}
      </div>
      {message && <div className="data-form-error">{message}</div>}
      <footer><button type="button" className="secondary-button data-small" onClick={onClose}>取消</button><button type="button" className="primary-button data-small" disabled={busy} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</button></footer>
    </div>
  </div>;
}

// 按字段类型渲染输入控件：枚举用下拉框，日期用日期选择，引用字段用可搜索的下拉框（不能手填编号）。
function FieldInput({ field, value, label, onChange }: { field: DataField; value: DataValue; label: string; onChange: (value: DataValue) => void }) {
  const text = value === null || value === undefined ? "" : String(value);
  if (field.type === "enum") {
    return <select value={text} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{field.required ? "请选择" : "（空）"}</option>
      {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>;
  }
  if (field.type === "ref" && field.ref) return <RefSelect refType={field.ref} value={text} label={label} required={Boolean(field.required)} onChange={onChange} />;
  if (field.type === "text") return <textarea rows={3} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (field.type === "date") return <input type="date" value={text} onChange={(event) => onChange(event.target.value || null)} />;
  if (field.type === "int" || field.type === "float") {
    return <input type="number" step={field.type === "int" ? 1 : 0.01} min={field.min} max={field.max} value={text} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} />;
  }
  return <input value={text} maxLength={field.max_length} onChange={(event) => onChange(event.target.value)} />;
}

// 引用字段的下拉框：输入关键字从后端搜索（按编号或名称），只能从已有数据里选。
function RefSelect({ refType, value, label, required, onChange }: { refType: string; value: string; label: string; required: boolean; onChange: (value: DataValue) => void }) {
  const [keyword, setKeyword] = useState("");
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      listDataOptions(refType, keyword).then((result) => setOptions(result.options)).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, refType]);

  // 当前值不在搜索结果里时也要显示，否则编辑时下拉框会变成"请选择"。
  const shown = [...options];
  if (value && !shown.some((option) => option.id === value)) shown.unshift({ id: value, label: label || value });
  return <div className="data-ref">
    <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索编号或名称" />
    <select value={value} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{required ? "请选择" : "（空）"}</option>
      {shown.map((option) => <option key={option.id} value={option.id}>{option.id} · {option.label}</option>)}
    </select>
  </div>;
}

// AI 生成：填条数和描述 → 生成预览 → 在预览里修改或删除行 → 确认写入。
// 预览数据不会自动入库；写入时后端会重新校验每一行，不合格的行留在预览里并标出原因。
function GeneratePanel({ type, onClose, onToast, onCommitted }: { type: DataType; onClose: () => void; onToast: ShowToast; onCommitted: () => void }) {
  const [count, setCount] = useState(10);
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = editableFields(type).filter((field) => field.name !== "owner");
  const validCount = preview ? preview.rows.filter((row) => Object.keys(row.errors).length === 0).length : 0;

  async function generate() {
    setBusy(true);
    setError("");
    // 重新生成时先清空旧预览，让等待状态显示真实的预览骨架，避免用户误以为旧数据就是本次结果。
    setPreview(null);
    try {
      setPreview(await generateDataPreview(type.key, count, prompt));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function editCell(index: number, name: string, value: DataValue) {
    if (!preview) return;
    const rows = [...preview.rows];
    const errors = { ...rows[index].errors };
    delete errors[name];
    rows[index] = { ...rows[index], values: { ...rows[index].values, [name]: value }, errors };
    setPreview({ ...preview, rows });
  }

  function removeRow(index: number) {
    if (!preview) return;
    const rows = preview.rows.filter((_, position) => position !== index);
    setPreview({ ...preview, rows });
  }

  async function commit() {
    if (!preview) return;
    const valid = preview.rows.filter((row) => Object.keys(row.errors).length === 0);
    setBusy(true);
    setError("");
    try {
      const result = await commitDataBatch(type.key, valid.map((row) => row.values));
      if (result.failed.length === 0) {
        onToast("success", `已写入 ${result.created.length} 条${type.label}`);
        onCommitted();
        return;
      }
      // 部分失败：成功的行移出预览，失败的行带着后端返回的原因留下，修改后可以再次写入。
      const remaining: DataPreview["rows"] = [];
      for (const failure of result.failed) {
        remaining.push({ ...valid[failure.index], errors: Object.keys(failure.errors).length ? failure.errors : { _row: failure.message } });
      }
      const invalid = preview.rows.filter((row) => Object.keys(row.errors).length > 0);
      setPreview({ ...preview, rows: [...remaining, ...invalid] });
      onToast("success", `已写入 ${result.created.length} 条，${result.failed.length} 条未通过校验`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="data-modal-backdrop" onClick={onClose}>
    <div className="data-modal data-modal-wide" role="dialog" aria-label={`AI 生成${type.label}`} onClick={(event) => event.stopPropagation()}>
      <header><h2>AI 生成{type.label}</h2><button type="button" className="data-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="data-generate-form">
        <label><span>条数</span><input type="number" min={1} max={50} value={count} onChange={(event) => setCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /></label>
        <label><span>描述（可选）</span><input value={prompt} maxLength={500} onChange={(event) => setPrompt(event.target.value)} placeholder={type.key === "products" ? "例如：数码类商品，价格 100～3000" : `例如：生成一些${type.label}，内容尽量多样`} /></label>
        <button type="button" className="primary-button data-small" disabled={busy} onClick={() => void generate()}>{busy && !preview ? "生成中…" : preview ? "重新生成" : "生成预览"}</button>
      </div>
      <p className="data-hint">引用字段（如订单的客户、商品）由系统从已有数据中挑选，金额、日期、编号等由代码计算，模型只负责生成内容字段。生成的数据需要你确认后才会写入。</p>
      {error && <div className="data-form-error">{error}</div>}
      {busy && !preview && <LoadingSkeleton className="data-preview-skeleton" label="正在生成数据预览"><SkeletonBlock className="skeleton-line-short" /><SkeletonBlock className="data-preview-skeleton-table" /><SkeletonBlock className="data-preview-skeleton-table" /><SkeletonBlock className="data-preview-skeleton-table" /></LoadingSkeleton>}
      {preview && <>
        <div className="data-preview-meta">
          <span className={`data-badge ${preview.generator === "llm" ? "ai" : ""}`}>{preview.generator === "llm" ? "大模型生成" : "本地模板"}</span>
          {preview.note && <span className="data-hint">{preview.note}</span>}
          <span className="data-hint">共 {preview.rows.length} 行，{validCount} 行可写入</span>
        </div>
        <div className="data-table-wrap data-preview">
          <table className="data-table">
            <thead><tr><th>#</th>{fields.map((field) => <th key={field.name}>{field.label}</th>)}<th /></tr></thead>
            <tbody>
              {preview.rows.map((row, index) => {
                const invalid = Object.keys(row.errors).length > 0;
                return <tr key={index} className={invalid ? "data-invalid" : ""}>
                  <td>{index + 1}</td>
                  {fields.map((field) => <td key={field.name}>
                    {field.type === "ref"
                      ? <span className="data-ref-label" title={String(row.values[field.name] ?? "")}>{row.values[field.name] ? `${row.labels[field.name] ?? ""}（${row.values[field.name]}）` : "—"}</span>
                      : <FieldInput field={field} value={row.values[field.name] ?? null} label="" onChange={(value) => editCell(index, field.name, value)} />}
                    {row.errors[field.name] && <small className="data-field-error">{row.errors[field.name]}</small>}
                  </td>)}
                  <td><button type="button" className="delete-button" onClick={() => removeRow(index)}>移除</button>{row.errors._row && <small className="data-field-error">{row.errors._row}</small>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </>}
      <footer>
        <button type="button" className="secondary-button data-small" onClick={onClose}>取消</button>
        <button type="button" className="primary-button data-small" disabled={busy || !preview || validCount === 0} onClick={() => void commit()}>确认写入 {validCount} 条</button>
      </footer>
    </div>
  </div>;
}
