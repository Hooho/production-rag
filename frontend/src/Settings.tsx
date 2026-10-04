import { useEffect, useState } from "react";
import { createGroup, createUser, deleteGroup, getDataPermissions, getLLMSettings, saveDataPermission, listGroups, listUsers, saveLLMSettings, testLLMSettings, updateGroup, updateUser, type AuthUser, type Group, type DataPermissionRow, type LLMSettings, type LLMSettingsInput } from "./api";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { formatDuration } from "./format";
import SystemSettings from "./SystemSettings";
import "./Settings.css";

type ShowToast = (kind: "success" | "error", message: string) => void;
// 设置页按 Tab 分组；用户、部门和数据权限只有管理员能看到。
type SettingsTab = "model" | "rag" | "system" | "users" | "groups" | "data";
const TAB_LABELS: Record<SettingsTab, string> = { model: "模型配置", rag: "RAG 配置", system: "系统配置", users: "用户", groups: "部门", data: "数据权限" };
type Provider = { key: string; name: string; note: string; baseUrl: string; models: string[]; keyUrl?: string; defaultKey?: string };

// 各厂商都提供 OpenAI 兼容接口，选中后自动填好地址和推荐模型，只需粘贴密钥。
// 模型名会随厂商更新变化，这里只是常用候选，输入框里可以改成任意模型名。
const PROVIDERS: Provider[] = [
  { key: "deepseek", name: "DeepSeek", note: "深度求索", baseUrl: "https://api.deepseek.com", models: ["deepseek-flash", "deepseek-v4-pro"], keyUrl: "https://platform.deepseek.com/api_keys" },
  { key: "minimax", name: "MiniMax", note: "国内站；海外用 api.minimax.io", baseUrl: "https://api.minimaxi.com/v1", models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"], keyUrl: "https://platform.minimaxi.com" },
  { key: "qwen", name: "通义千问", note: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-plus", "qwen-max", "qwen-flash"], keyUrl: "https://bailian.console.aliyun.com" },
  { key: "kimi", name: "Kimi", note: "月之暗面", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k2.6", "kimi-k3"], keyUrl: "https://platform.moonshot.cn" },
  { key: "zhipu", name: "智谱 GLM", note: "BigModel 开放平台", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3", "glm-5.2"], keyUrl: "https://bigmodel.cn" },
  { key: "openai", name: "OpenAI", note: "需要可访问海外网络", baseUrl: "https://api.openai.com/v1", models: ["gpt-5-mini", "gpt-5.4"], keyUrl: "https://platform.openai.com/api-keys" },
  { key: "ollama", name: "Ollama", note: "本机模型，无需密钥", baseUrl: "http://host.docker.internal:11434/v1", models: ["qwen3:8b", "llama3.1:8b"], defaultKey: "ollama" },
  { key: "custom", name: "自定义", note: "任意 OpenAI 兼容服务", baseUrl: "", models: [] },
];

// 接口返回 404 说明运行中的 API 还是旧版本，没有设置接口；原来只显示 "Not Found"，看不出该怎么处理。
function explainError(reason: unknown) {
  const message = (reason as Error).message;
  if (message === "Not Found") return "API 服务还没有设置接口，请重新构建并启动：docker compose up -d --build api worker frontend";
  return message;
}

// 按标识找到厂商预设，找不到时当作自定义。
function findProvider(key: string) {
  const found = PROVIDERS.find((item) => item.key === key);
  return found ?? PROVIDERS[PROVIDERS.length - 1];
}

// 设置子页首次读取时使用表单和列表骨架；原来的空字段会让用户误以为配置丢失或列表为空。
function SettingsLoadingSkeleton({ kind }: { kind: "model" | "list" | "permissions" }) {
  if (kind === "model") {
    return <LoadingSkeleton className="settings-loading settings-model-loading" label="正在加载模型设置">
      <div className="settings-current-skeleton"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
      <SkeletonBlock className="skeleton-line-short" />
      <div className="settings-provider-skeleton"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div>
      <SkeletonBlock className="settings-form-skeleton" />
      <SkeletonBlock className="settings-form-skeleton" />
      <SkeletonBlock className="settings-form-skeleton" />
    </LoadingSkeleton>;
  }
  if (kind === "permissions") {
    return <LoadingSkeleton className="settings-loading" label="正在加载数据权限"><SkeletonBlock className="skeleton-line-long" /><SkeletonBlock className="settings-permission-skeleton" /><SkeletonBlock className="settings-permission-skeleton" /></LoadingSkeleton>;
  }
  return <LoadingSkeleton className="settings-loading" label="正在加载列表"><SkeletonBlock className="skeleton-line-short" /><SkeletonBlock className="settings-list-skeleton" /><SkeletonBlock className="settings-list-skeleton" /><SkeletonBlock className="settings-list-skeleton" /></LoadingSkeleton>;
}

// 设置页外壳：标题和 Tab 切换。
export default function Settings({ user, onToast }: { user: AuthUser; onToast: ShowToast }) {
  const [tab, setTab] = useState<SettingsTab>("model");
  const tabs: SettingsTab[] = user.is_admin ? ["model", "rag", "system", "users", "groups", "data"] : ["model"];
  return <div className="settings-page">
    <header className="topbar"><div><h1>设置</h1></div></header>
    <div className="document-detail-tabs settings-tabs" role="tablist">
      {tabs.map((key) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{TAB_LABELS[key]}</button>)}
    </div>
    {tab === "model" && <ModelSettings isAdmin={user.is_admin} onToast={onToast} />}
    {tab === "rag" && user.is_admin && <SystemSettings key="rag" page="rag" onToast={onToast} />}
    {tab === "system" && user.is_admin && <SystemSettings key="system" page="system" onToast={onToast} />}
    {tab === "users" && user.is_admin && <UserSettings currentUser={user.username} onToast={onToast} />}
    {tab === "groups" && user.is_admin && <GroupSettings onToast={onToast} />}
    {tab === "data" && user.is_admin && <DataPermissionSettings onToast={onToast} />}
  </div>;
}

// 模型配置 Tab：选择厂商快速填充配置，测试连接后保存，后端立即切换聊天模型。
// 模型配置对所有用户生效，只有管理员可以测试和保存，其他用户只能查看当前配置。
function ModelSettings({ isAdmin, onToast }: { isAdmin: boolean; onToast: ShowToast }) {
  const [current, setCurrent] = useState<LLMSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("custom");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    getLLMSettings().then((value) => {
      setCurrent(value);
      setProvider(value.provider);
      setBaseUrl(value.base_url);
      setModel(value.model);
    }).catch((reason: Error) => onToast("error", explainError(reason))).finally(() => setLoading(false));
  }, []);

  if (loading) return <SettingsLoadingSkeleton kind="model" />;

  // 切换厂商时换成该厂商的地址和第一个推荐模型；密钥清空，避免把上一个厂商的密钥发给新厂商。
  function chooseProvider(item: Provider) {
    setProvider(item.key);
    setTestResult(null);
    if (item.key === "custom") return;
    setBaseUrl(item.baseUrl);
    setModel(item.models[0]);
    setKey(item.defaultKey ?? "");
  }

  // 地址没变时可以不填密钥，后端沿用当前密钥。
  const keepsCurrentKey = Boolean(current?.has_api_key) && baseUrl.trim() === current?.base_url;
  const canSubmit = isAdmin && baseUrl.trim() !== "" && model.trim() !== "" && (key.trim() !== "" || keepsCurrentKey) && busy === "";
  const selected = findProvider(provider);

  function payload(): LLMSettingsInput {
    return { provider, base_url: baseUrl.trim(), model: model.trim(), api_key: key.trim() || null };
  }

  async function runTest() {
    setBusy("test");
    setTestResult(null);
    try {
      const result = await testLLMSettings(payload());
      setTestResult({ ok: true, text: `连接成功，耗时 ${formatDuration(result.latency_ms)}，模型回复：${result.reply || "（空）"}` });
    } catch (reason) {
      setTestResult({ ok: false, text: explainError(reason) });
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setBusy("save");
    try {
      const value = await saveLLMSettings(payload());
      setCurrent(value);
      setKey("");
      onToast("success", `已切换到 ${findProvider(value.provider).name} · ${value.model}`);
    } catch (reason) {
      onToast("error", explainError(reason));
    } finally {
      setBusy("");
    }
  }

  return <div className="settings-panel">
    {current && <section className="settings-current">
      <div><span>当前模型</span><strong>{findProvider(current.provider).name} · {current.model}</strong></div>
      <div><span>服务地址</span><code>{current.base_url}</code></div>
      <div><span>API Key</span><code>{current.api_key_masked || "未设置"}</code></div>
      <div><span>配置来源</span><strong>{current.source === "settings" ? "设置页" : ".env 文件"}</strong></div>
    </section>}
    {current?.model_mode === "demo" && <div className="settings-warning">当前为演示模式（MODEL_MODE=demo），问答不会调用大模型。配置可以先保存和测试；要真正启用，请把 .env 中的 MODEL_MODE 改为 openai 并重启服务。</div>}

    <section className="settings-section">
      <h2>选择服务商</h2>
      <div className="provider-grid">
        {PROVIDERS.map((item) => <button type="button" key={item.key} className={item.key === provider ? "provider-card active" : "provider-card"} onClick={() => chooseProvider(item)}>
          <strong>{item.name}</strong><small>{item.note}</small>
        </button>)}
      </div>
    </section>

    <section className="settings-section settings-form">
      <label>服务地址（Base URL）<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" /></label>
      <label>模型名称<input value={model} onChange={(event) => setModel(event.target.value)} list="settings-model-options" placeholder="例如 deepseek-flash" /></label>
      <datalist id="settings-model-options">{selected.models.map((item) => <option key={item} value={item} />)}</datalist>
      {selected.models.length > 0 && <div className="model-chips">{selected.models.map((item) => <button type="button" key={item} className={item === model ? "active" : ""} onClick={() => setModel(item)}>{item}</button>)}</div>}
      <label>API Key
        <span className="key-input"><input type={showKey ? "text" : "password"} value={key} onChange={(event) => setKey(event.target.value)} placeholder={keepsCurrentKey ? `留空沿用当前密钥 ${current?.api_key_masked}` : "粘贴该服务的 API Key"} autoComplete="off" /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏" : "显示"}</button></span>
      </label>
      {selected.keyUrl && <a className="key-link" href={selected.keyUrl} target="_blank" rel="noreferrer">去 {selected.name} 控制台获取 API Key ↗</a>}
      {testResult && <div className={testResult.ok ? "test-result ok" : "test-result fail"}>{testResult.text}</div>}
      <div className="settings-actions">
        <button type="button" className="secondary-button" disabled={!canSubmit} onClick={() => void runTest()}>{busy === "test" ? "测试中…" : "测试连接"}</button>
        <button type="button" className="primary-button" disabled={!canSubmit} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存并启用"}</button>
      </div>
      {!isAdmin && <p className="settings-hint">模型配置对所有用户生效，只有管理员可以修改。</p>}
      <p className="settings-hint">保存后立即对所有用户生效，无需重启；文档导入（Contextual Retrieval）会在处理下一个文档时换用新模型。</p>
    </section>
  </div>;
}

// 原来的“用户与部门”把两个管理目标放在同一页；拆成独立 Tab 后，用户页专注账户和归属关系。
function UserSettings({ currentUser, onToast }: { currentUser: string; onToast: ShowToast }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [newGroups, setNewGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userModalOpen, setUserModalOpen] = useState(false);

  async function reload() {
    const [userResult, groupResult] = await Promise.all([listUsers(), listGroups()]);
    setUsers(userResult.users);
    setGroups(groupResult.groups);
  }

  useEffect(() => {
    reload().catch((reason: Error) => onToast("error", reason.message)).finally(() => setLoading(false));
  }, []);

  // 执行一次管理操作，成功后刷新列表并提示，失败提示后端返回的原因。
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      await reload();
      onToast("success", success);
      return true;
    } catch (reason) {
      onToast("error", (reason as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openUserModal() {
    setUsername("");
    setPassword("");
    setIsAdmin(false);
    setNewGroups([]);
    setUserModalOpen(true);
  }

  function closeUserModal() {
    if (!busy) setUserModalOpen(false);
  }

  async function addUser() {
    const ok = await run(() => createUser({ username: username.trim(), password, is_admin: isAdmin, groups: newGroups }), `已创建用户 ${username.trim()}`);
    if (!ok) return;
    setUsername("");
    setPassword("");
    setIsAdmin(false);
    setNewGroups([]);
    setUserModalOpen(false);
  }

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  // 重置密码后该用户的刷新令牌全部作废，已登录的设备最多 30 分钟后需要用新密码重新登录。
  async function resetPassword(target: string) {
    const value = window.prompt(`为 ${target} 设置新密码（至少 8 位）`);
    if (!value) return;
    await run(() => updateUser(target, { password: value }), `已重置 ${target} 的密码`);
  }

  function groupLabel(id: string) {
    return groups.find((group) => group.id === id)?.name ?? id;
  }

  return <div className="settings-panel">
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><h2>用户列表</h2><p className="settings-hint">管理账号、管理员身份和所属部门。</p></div>
        <button type="button" className="primary-button" disabled={busy || loading} onClick={openUserModal}>新建用户</button>
      </div>
      <div className="user-table">
        {loading ? <SettingsLoadingSkeleton kind="list" /> : users.map((item) => <div className={`user-row ${item.disabled ? "is-disabled" : ""}`} key={item.username}>
          <div className="user-name"><strong>{item.username}</strong><span className="user-tags"><span className={`status-tag is-${item.is_admin ? "purple" : "gray"}`}>{item.is_admin ? "管理员" : "普通用户"}</span>{item.disabled && <span className="status-tag is-red">已停用</span>}</span></div>
          <div className="user-checks">{groups.length === 0 ? <small className="settings-hint">无部门</small> : groups.map((group) => <label key={group.id}><input type="checkbox" disabled={busy} checked={item.groups.includes(group.id)} onChange={() => void run(() => updateUser(item.username, { groups: toggle(item.groups, group.id) }), `已更新 ${item.username} 的部门`)} />{groupLabel(group.id)}</label>)}</div>
          <div className="user-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void resetPassword(item.username)}>重置密码</button>
            {item.username !== currentUser && <button type="button" className={item.disabled ? "secondary-button" : "delete-button"} disabled={busy} onClick={() => void run(() => updateUser(item.username, { disabled: !item.disabled }), item.disabled ? `已启用 ${item.username}` : `已停用 ${item.username}`)}>{item.disabled ? "启用" : "停用"}</button>}
          </div>
        </div>)}
      </div>
    </section>
    {userModalOpen && <div className="settings-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUserModal(); }}>
      <div className="settings-modal user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
        <div className="settings-modal-header"><div><h2 id="user-modal-title">新建用户</h2><p className="settings-hint">设置账号密码，并选择管理员身份和所属部门。</p></div><button type="button" className="settings-modal-close" aria-label="关闭" onClick={closeUserModal}>×</button></div>
        <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void addUser(); }}>
          <div className="user-modal-fields">
            <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="3～32 位小写字母、数字" autoComplete="off" autoFocus /></label>
            <label>初始密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" autoComplete="new-password" /></label>
          </div>
          <div className="user-modal-groups">
            <span className="settings-field-label">选择部门</span>
            <div className="user-checks">
              <label><input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />管理员</label>
              {groups.map((group) => <label key={group.id}><input type="checkbox" checked={newGroups.includes(group.id)} onChange={() => setNewGroups(toggle(newGroups, group.id))} />{group.name}</label>)}
            </div>
          </div>
          <div className="settings-modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={closeUserModal}>取消</button><button type="submit" className="primary-button" disabled={busy || !username.trim() || password.length < 8}>{busy ? "创建中…" : "创建用户"}</button></div>
        </form>
      </div>
    </div>}
  </div>;
}

// 部门 Tab（仅管理员）：列表承载日常管理，弹窗承载新增和编辑，避免表单长期占据页面空间。
function GroupSettings({ onToast }: { onToast: ShowToast }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function reload() {
    const result = await listGroups();
    setGroups(result.groups);
  }

  useEffect(() => {
    reload().catch((reason: Error) => onToast("error", reason.message)).finally(() => setLoading(false));
  }, []);

  function openCreate() {
    setEditingId(null);
    setGroupName("");
    setModalMode("create");
  }

  function openEdit(group: Group) {
    setEditingId(group.id);
    setGroupName(group.name);
    setModalMode("edit");
  }

  function closeModal() {
    if (!busy) setModalMode(null);
  }

  // 新增和编辑都在弹窗中提交，成功后刷新列表，保证用户归属和权限页读取到最新名称。
  async function saveGroup() {
    if (!modalMode) return;
    const name = groupName.trim();
    setBusy(true);
    try {
      if (modalMode === "edit") {
        if (!editingId) return;
        await updateGroup(editingId, { name });
      } else {
        await createGroup({ name });
      }
      await reload();
      setGroupName("");
      setEditingId(null);
      setModalMode(null);
      onToast("success", modalMode === "edit" ? `已更新部门 ${name}` : `已创建部门 ${name}`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 删除前明确告知关联数据会被清理，避免管理员误删仍在使用的部门。
  async function removeGroup(group: Group) {
    if (!window.confirm(`确定删除部门“${group.name}”吗？删除后会清理用户归属、文档共享和数据权限中的关联。`)) return;
    setBusy(true);
    try {
      await deleteGroup(group.id);
      await reload();
      onToast("success", `已删除部门 ${group.name}`);
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const editing = modalMode === "edit";

  return <div className="settings-panel">
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><h2>部门列表</h2><p className="settings-hint">部门用于文档共享、用户归属和数据权限分配。</p></div>
        <button type="button" className="primary-button" disabled={busy || loading} onClick={openCreate}>添加部门</button>
      </div>
      <div className="group-table" role="table" aria-label="部门列表">
        <div className="group-row group-header" role="row"><span>部门名称</span><span>部门编号</span><span>操作</span></div>
        {loading ? <SettingsLoadingSkeleton kind="list" /> : groups.length === 0 ? <div className="group-empty">还没有部门，点击“添加部门”创建。</div> : groups.map((group) => <div className="group-row" role="row" key={group.id}>
          <strong>{group.name}</strong><code>{group.id}</code>
          <div className="group-actions"><button type="button" className="settings-text-button" disabled={busy} onClick={() => openEdit(group)}>编辑</button><button type="button" className="settings-text-button danger" disabled={busy} onClick={() => void removeGroup(group)}>删除</button></div>
        </div>)}
      </div>
    </section>
    {modalMode && <div className="settings-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="group-modal-title">
        <div className="settings-modal-header"><div><h2 id="group-modal-title">{editing ? "编辑部门" : "添加部门"}</h2><p className="settings-hint">{editing ? "部门编号用于关联数据，编辑时不可修改。" : "创建后可用于用户归属、文档共享和数据权限。"}</p></div><button type="button" className="settings-modal-close" aria-label="关闭" onClick={closeModal}>×</button></div>
        <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void saveGroup(); }}>
          <label>部门名称<input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如 销售部" autoFocus /></label>
          <div className="settings-modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={closeModal}>取消</button><button type="submit" className="primary-button" disabled={busy || !groupName.trim()}>{busy ? "保存中…" : editing ? "保存修改" : "添加部门"}</button></div>
        </form>
      </div>
    </div>}
  </div>;
}

const DATA_ACTIONS: { key: "read" | "create" | "update" | "delete"; label: string }[] = [
  { key: "read", label: "查看" }, { key: "create", label: "新增" }, { key: "update", label: "修改" }, { key: "delete", label: "删除" },
];

// 数据权限 Tab（仅管理员）：按部门勾选每种业务数据的查看、新增、修改、删除权限。
// 用户的权限是所在各部门的并集；勾选后立即生效，数据管理页和聊天里的数据查询都按它过滤。
function DataPermissionSettings({ onToast }: { onToast: ShowToast }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [types, setTypes] = useState<{ key: string; label: string }[]>([]);
  const [rows, setRows] = useState<DataPermissionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [groupResult, permissionResult] = await Promise.all([listGroups(), getDataPermissions()]);
    setGroups(groupResult.groups);
    setTypes(permissionResult.types);
    setRows(permissionResult.permissions);
  }

  useEffect(() => {
    reload().catch((reason: Error) => onToast("error", reason.message)).finally(() => setLoading(false));
  }, []);

  function find(groupId: string, dataType: string) {
    return rows.find((row) => row.group_id === groupId && row.data_type === dataType);
  }

  // 切换一个权限。取消"查看"时同时取消其他权限（不能看却能改没有意义），后端也按这个规则保存。
  async function toggle(groupId: string, dataType: string, action: "read" | "create" | "update" | "delete") {
    const row = find(groupId, dataType);
    const flags = { read: Boolean(row?.can_read), create: Boolean(row?.can_create), update: Boolean(row?.can_update), delete: Boolean(row?.can_delete) };
    flags[action] = !flags[action];
    if (action === "read" && !flags.read) {
      flags.create = false;
      flags.update = false;
      flags.delete = false;
    }
    setBusy(true);
    try {
      await saveDataPermission({ group_id: groupId, data_type: dataType, ...flags });
      await reload();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="settings-panel">
    <section className="settings-section">
      <h2>数据权限</h2>
      <p className="settings-hint">管理员拥有全部权限；普通用户的权限是所在各部门权限的并集，没有任何部门的用户看不到业务数据。聊天里的数据查询同样受这里控制，手机号等敏感字段只对有修改权限的人显示完整值。</p>
      {loading && <SettingsLoadingSkeleton kind="permissions" />}
      {!loading && groups.length === 0 && <p className="settings-hint">还没有部门，请先在"部门"里创建。</p>}
      {!loading && groups.map((group) => <div className="data-permission-group" key={group.id}>
        <h3>{group.name}<small>{group.id}</small></h3>
        <div className="data-permission-grid">
          {types.map((item) => <div className="data-permission-row" key={item.key}>
            <strong>{item.label}</strong>
            {DATA_ACTIONS.map((action) => {
              const row = find(group.id, item.key);
              const checked = Boolean(row?.[`can_${action.key}`]);
              return <label key={action.key}><input type="checkbox" disabled={busy} checked={checked} onChange={() => void toggle(group.id, item.key, action.key)} />{action.label}</label>;
            })}
          </div>)}
        </div>
      </div>)}
    </section>
  </div>;
}
