// 来源带上版本号、页码和标题路径，便于确认命中的是当前版本的哪个位置。
export type Source = { id: string; title: string; text: string; score?: number; version?: number | null; page_start?: number | null; heading?: string | null };
export type TraceStep = {
  id: string;
  stage: string;
  title: string;
  status: "completed" | "running" | "pending" | "failed";
  detail: string;
  duration_ms?: number;
  // 从请求开始到这一步完成的累计时间；duration_ms 只是这一步自己的耗时。
  elapsed_ms?: number;
  result?: Record<string, unknown>;
  // result 的字段顺序。MySQL JSON 列会把对象的键重新排序，后端另存一份数组记录原来的顺序。
  field_order?: string[];
};
// 检索诊断：后端记录的每张排名表、每个候选的 RRF 贡献、重排概率和最终去向。
export type RetrievalContribution = { query: string; method: string; rank: number; raw_score: number; rrf: number };
export type RetrievalListHit = { rank: number; chunk_id: string; title: string; raw_score: number; rrf: number };
export type RetrievalList = { query: string; method: string; hits: RetrievalListHit[] };
export type RetrievalCandidate = {
  chunk_id: string;
  chunk_key?: string | null;
  title: string;
  version?: number | null;
  page_start?: number | null;
  heading?: string | null;
  preview: string;
  status: "returned" | "beyond_limit" | "filtered_low_score" | "in_pool" | "not_in_pool";
  source_id: string | null;
  retrieval_methods: string[];
  contributions: RetrievalContribution[];
  rrf_score: number;
  rrf_rank: number;
  rerank_logit: number | null;
  rerank_probability: number | null;
  rerank_rank: number | null;
};
export type RetrievalDiagnosticsData = {
  config: { rrf_k: number; rerank_candidates: number; return_limit: number; reranked: boolean; min_score: number | null; rerank_query: string; rerank_model: string; rerank_error?: string | null };
  lists: RetrievalList[];
  candidates: RetrievalCandidate[];
  // 这次检索的权限范围：可检索的文档（当前版本）按自己上传 / 共享给我 / 公开计数；旧记录没有。
  scope?: RetrievalScope;
};
export type RetrievalScope = {
  total: number; own: number; shared: number; public: number; groups: string[];
  documents: Array<{ document_id: string; title: string; version: number; source: "own" | "shared" | "public"; owner: string; groups: string[] }>;
};
export type ChatResult = {
  answer: string;
  route: string;
  sources: Source[];
  steps: TraceStep[];
  trace_id: string;
  request_id: string;
  model_mode?: string;
  // 用户对这次回答的反馈，来自 /history；新回答没有反馈。
  feedback?: FeedbackRecord | null;
};
export type HistoryRun = {
  id: string;
  session_id: string;
  question: string;
  response: ChatResult;
  created: string;
  feedback?: FeedbackRecord | null;
};
// 点踩原因，与后端 FEEDBACK_REASONS 保持一致。
export type FeedbackReason = "wrong" | "incomplete" | "missed" | "citation" | "other";
export type FeedbackRecord = {
  request_id: string;
  rating: 1 | -1;
  reason: FeedbackReason | null;
  reason_label?: string | null;
  comment: string | null;
  created: string;
  updated: string;
};
// 一份文档的一个版本。列表接口按逻辑文档返回当前版本，并在 pending 中给出更新但尚未生效的版本；
// 详情接口额外返回同一文档的全部版本历史。
export type DocumentVersionSummary = {
  document_id: string;
  version: number;
  status: string;
  error: string | null;
  filename?: string;
  created?: string;
  version_note?: string | null;
  is_current?: boolean;
};
export type DocumentStatus = {
  document_id: string;
  // 缺少上下文说明的分片数（没有说明或说明里混进了思考过程），以及服务端是否启用了 Contextual Retrieval。
  context_missing?: number;
  contextual_enabled?: boolean;
  doc_key?: string;
  title: string;
  filename: string;
  status: string;
  error: string | null;
  created?: string;
  updated?: string;
  version?: number;
  version_note?: string | null;
  is_current?: boolean;
  version_count?: number;
  pending?: DocumentVersionSummary | null;
  versions?: DocumentVersionSummary[];
  document_metadata?: DocumentMetadata;
  steps: DocumentStep[];
  // 文档权限：上传者、可见范围、共享部门，以及当前用户能否修改（只有上传者可以）。
  owner?: string;
  visibility?: DocumentVisibility;
  groups?: string[];
  can_edit?: boolean;
};
// Excel、CSV 的表格识别结果：每个工作表识别到几张表、表头在哪几行、是否认出了表头。
export type TableReport = {
  sheets: { sheet: string | null; tables: { title: string | null; first_row: number; last_row: number; columns: number; rows: number; header_rows: number[]; header_depth: number; confidence: "high" | "low" | null; single_column: boolean; column_names: string[] }[]; text_only: boolean; empty: boolean }[];
  hidden_sheets: string[];
};
export type DocumentMetadata = {
  mime_type?: string | null;
  file_size_bytes?: number | null;
  sha256?: string | null;
  parser?: string | null;
  parser_version?: string | null;
  parse_strategy?: string | null;
  table_structure_inference?: boolean | null;
  ocr_languages?: string[] | null;
  table_report?: TableReport | null;
  page_count?: number | null;
  author?: string | null;
  author_source?: string | null;
  parse_duration_ms?: number | null;
  processing_duration_ms?: number | null;
  chunking_strategy?: string | null;
  chunk_size?: number | null;
  overlap?: number | null;
  embedding_model?: string | null;
  embedding_dimension?: number | null;
};
export type DocumentStep = {
  step_id: string;
  step_order: number;
  stage: string;
  title: string;
  status: "running" | "completed" | "failed";
  detail: string;
  result?: Record<string, unknown> | null;
  duration_ms?: number | null;
};
export type DocumentChunk = {
  chunk_id: string;
  document_id: string;
  position: number;
  document_title: string;
  title: string;
  section_title: string | null;
  author: string | null;
  author_source: string | null;
  heading_path: string[];
  content: string;
  // Contextual Retrieval 生成的上下文说明；旧数据或生成失败时为空。
  context?: string | null;
  // 向量来源、复用自上一版本的哪个分片、上下文说明来源；早于这项记录的版本为空。
  vector_source?: ChunkSource | null;
  reused_from?: string | null;
  context_source?: "reused" | "cached" | "generated" | "failed" | null;
  source: string;
  char_count: number;
  token_count: number | null;
  // Token 数超过向量模型上限，超出部分被截断。
  truncated?: boolean | null;
  page_start: number | null;
  page_end: number | null;
  row_start?: number | null;
  row_end?: number | null;
  element_types: string[];
  element_indexes: number[];
  chunking_strategy: string | null;
  chunk_size: number | null;
  overlap: number | null;
  effective_chunk_size: number | null;
  effective_overlap: number | null;
  parser: string | null;
  parser_version: string | null;
  parse_strategy: string | null;
};
export type DocumentChunkPage = {
  document_id: string;
  document: {
    document_id: string;
    title: string;
    filename: string;
    uploaded_at: string;
    updated_at: string;
    metadata: DocumentMetadata;
  };
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  average_length: number;
  // 按向量来源筛选时的来源，以及复用 / 新计算各有多少个分片（早于这项记录的版本都是 0）。
  source?: ChunkSource | null;
  source_counts?: { reused: number; computed: number };
  chunks: DocumentChunk[];
};
export type ChunkSource = "reused" | "computed";

const API_BASE = "/api";

// 登录状态。原来浏览器里只保存一个永不过期的 API Key；现在保存访问令牌（30 分钟）和刷新令牌（7 天），
// 访问令牌过期后用刷新令牌自动换新，用户感觉不到；刷新令牌也失效时才回到登录页。
export type AuthUser = { username: string; is_admin: boolean; disabled: boolean; groups: string[]; created: string };
type AuthTokens = { access_token: string; refresh_token: string; user: AuthUser };
const accessStorage = "atlas-rag-access-token";
const refreshStorage = "atlas-rag-refresh-token";
const userStorage = "atlas-rag-user";
// 登录失效时通知 App 回到登录页。
export const LOGOUT_EVENT = "atlas-rag-logout";

// localStorage 在隐私模式下可能不可用，读写失败时按未登录处理。
function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storedUser(): AuthUser | null {
  const value = readStorage(userStorage);
  if (!value || !readStorage(refreshStorage)) return null;
  try {
    return JSON.parse(value) as AuthUser;
  } catch {
    return null;
  }
}

function saveTokens(tokens: AuthTokens) {
  localStorage.setItem(accessStorage, tokens.access_token);
  localStorage.setItem(refreshStorage, tokens.refresh_token);
  localStorage.setItem(userStorage, JSON.stringify(tokens.user));
}

export function clearTokens() {
  localStorage.removeItem(accessStorage);
  localStorage.removeItem(refreshStorage);
  localStorage.removeItem(userStorage);
}

// 多个请求同时遇到 401 时只刷新一次：刷新令牌用过一次就作废，并发刷新会让后面的请求被当成重复使用，整个账号被登出。
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const refreshToken = readStorage(refreshStorage);
  if (!refreshToken) return false;
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return false;
  saveTokens(await response.json() as AuthTokens);
  return true;
}

// 带上访问令牌发请求；返回 401 时刷新令牌后重试一次，仍失败则清除登录状态并通知 App。
async function authorizedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  function send() {
    const headers = new Headers(options.headers);
    const token = readStorage(accessStorage);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  }
  let response = await send();
  if (response.status !== 401) return response;
  if (!refreshing) refreshing = refreshTokens().finally(() => { refreshing = null; });
  if (await refreshing) {
    response = await send();
    if (response.status !== 401) return response;
  }
  clearTokens();
  window.dispatchEvent(new Event(LOGOUT_EVENT));
  return response;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authorizedFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail || `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

// 登录接口不带令牌，也不走自动刷新：密码错误的 401 不能被当成"令牌过期"。
export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({ detail: response.statusText }));
  if (!response.ok) throw new Error(body.detail || `登录失败：${response.status}`);
  saveTokens(body as AuthTokens);
  return (body as AuthTokens).user;
}

// 退出登录：通知服务端作废刷新令牌；服务端不可用也要清掉本地登录状态。
export async function logout() {
  const refreshToken = readStorage(refreshStorage);
  clearTokens();
  if (!refreshToken) return;
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }).catch(() => undefined);
}

export type Group = { id: string; name: string };
export type DocumentVisibility = "private" | "shared" | "public";

export function listGroups() {
  return request<{ groups: Group[] }>("/groups");
}

export function listUsers() {
  return request<{ users: AuthUser[] }>("/admin/users");
}

export function createUser(payload: { username: string; password: string; is_admin: boolean; groups: string[] }) {
  return request<AuthUser>("/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateUser(username: string, payload: { password?: string; is_admin?: boolean; disabled?: boolean; groups?: string[] }) {
  return request<AuthUser>(`/admin/users/${encodeURIComponent(username)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function createGroup(payload: Pick<Group, "name">) {
  return request<Group>("/admin/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateGroup(id: string, payload: Pick<Group, "name">) {
  return request<Group>(`/admin/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteGroup(id: string) {
  return request<{ id: string }>(`/admin/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// 修改文档可见范围，只有上传者可以调用。
export function updateDocumentPermission(documentId: string, visibility: DocumentVisibility, groups: string[]) {
  return request<{ document_id: string; visibility: DocumentVisibility; groups: string[] }>(`/documents/${documentId}/permission`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, groups }),
  });
}

export function createSession(): Promise<{ session_id: string }> {
  return request("/sessions", { method: "POST" });
}

// 读取指定会话，确认浏览器保存的会话仍属于当前用户。
export function getSessionHistory(sessionId: string) {
  return request<{ messages: HistoryRun[] }>(`/sessions/${sessionId}`, {
  });
}

// 读取当前用户最近保存的问答记录，刷新页面后恢复对话列表。
export function listHistory() {
  return request<{ messages: HistoryRun[] }>("/history");
}

export function sendChat(payload: { session_id: string; request_id: string; question: string }) {
  return request<ChatResult>("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 读取后端 SSE 阶段事件和回答文字片段，返回最终的完整问答结果。
export async function sendChatStream(
  payload: { session_id: string; request_id: string; question: string },
  onStep: (step: TraceStep) => void,
  onToken: (text: string) => void,
): Promise<ChatResult> {
  const response = await authorizedFetch("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail || `请求失败：${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete: ChatResult | null = null;

  function handle(block: string) {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) return;
    const value = JSON.parse(data) as TraceStep | ChatResult | { detail?: string } | { text: string };
    if (event === "step") onStep(value as TraceStep);
    // 后端逐段推送回答文字，原来要等 complete 才能看到整段回答。
    if (event === "token") onToken((value as { text: string }).text);
    if (event === "error") throw new Error((value as { detail?: string }).detail || "请求失败");
    if (event === "complete") complete = value as ChatResult;
  }

  while (true) {
    // 连接中途断开时浏览器只给出 "network error"，看不出发生了什么，换成可以理解的提示。
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw new Error("与服务器的连接中断（服务重启或网络波动），请稍后重试");
    }
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) handle(block);
    if (result.done) break;
  }
  if (!complete) throw new Error("服务未返回完整结果");
  return complete;
}

// 提交或修改对一次回答的反馈，重复提交覆盖上一次。
export function submitFeedback(payload: { request_id: string; rating: 1 | -1; reason?: FeedbackReason | null; comment?: string | null }) {
  return request<FeedbackRecord>("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// replaceDocumentId 指定后作为该文档的新版本上传；内容与已有版本相同时返回 status=duplicate。
// visibility 和 groups 只对新文档生效；替换为新版本时沿用原来的可见范围。
export function uploadDocument(file: File, title: string, replaceDocumentId?: string | null, versionNote?: string, visibility: DocumentVisibility = "private", groups: string[] = []) {
  const form = new FormData();
  form.append("file", file);
  form.append("visibility", visibility);
  if (groups.length > 0) form.append("groups", groups.join(","));
  if (title.trim()) form.append("title", title.trim());
  if (replaceDocumentId) form.append("replace_document_id", replaceDocumentId);
  if (versionNote?.trim()) form.append("version_note", versionNote.trim());
  return request<{ document_id: string; status: string; filename: string; version?: number }>("/documents/upload", {
    method: "POST",
    body: form,
  });
}

export function getDocument(documentId: string) {
  return request<DocumentStatus>(`/documents/${documentId}`);
}

// 删除一个已完成或失败的文档及其检索索引。
export function deleteDocument(documentId: string) {
  return request<{ document_id: string; deleted: boolean; chunk_count: number }>(`/documents/${documentId}`, {
    method: "DELETE",
  });
}

// 让处理失败的文档版本重新进入解析队列。
export function retryDocument(documentId: string) {
  return request<{ document_id: string; status: string }>(`/documents/${documentId}/retry`, {
    method: "POST",
  });
}

// 为已完成版本里上下文说明生成失败的分片补生成说明，由 worker 在后台执行。
export function retryDocumentContexts(documentId: string) {
  return request<{ document_id: string; status: string }>(`/documents/${documentId}/contexts/retry`, {
    method: "POST",
  });
}

export function listDocuments() {
  return request<{ documents: DocumentStatus[] }>("/documents");
}

export function listDocumentChunks(documentId: string, page: number, pageSize = 10, source?: ChunkSource | null) {
  return request<DocumentChunkPage>(`/documents/${documentId}/chunks?page=${page}&page_size=${pageSize}${source ? `&source=${source}` : ""}`, {
  });
}

// 评测：题目、单次评测结果、历次评测列表与两次对比，字段与后端 app/evaluation 保持一致。
export type EvalItem = {
  id: string;
  question: string;
  type: string;
  answerable: boolean;
  evidence: string[];
  reference_answer: string;
  split: string;
  history?: string[];
  origin?: string;
  reviewed?: boolean;
  pair_id?: string;
  pair_role?: "original" | "paraphrase";
};
export type EvalSummary = Record<string, number | null>;
export type EvalStage = { recall: number | null; rr: number; rank: number | null };
export type EvalEvidence = { text: string; chunk_id: string | null; rrf_rank: number | null; rerank_rank: number | null; rerank_probability: number | null; source_id: string | null; status: string };
export type EvalJudgement = { refused: boolean; faithfulness: number; correctness: number; citation: number; faithfulness_reason: string; correctness_reason: string; citation_reason: string; judge: string };
export type EvalSufficiency = { checked: boolean; verdict: "sufficient" | "partial" | "insufficient" | null; missing?: string | string[] | null; retried?: boolean; retry_query?: string | null; refused?: boolean; source_count?: number | null };
export type EvalQuestion = {
  id: string;
  question: string;
  type: string;
  answerable: boolean;
  evidence_count: number;
  stages: { pool: EvalStage; top: EvalStage; final: EvalStage };
  lost_stage: "recall" | "rerank" | "threshold" | null;
  evidence: EvalEvidence[];
  // 历史记录的真实说明需要统计每道题实际进入候选池的 chunk 数，完整评测结果才会返回这组数据。
  pool?: { p: number | null; ev: number[] }[];
  returned: number;
  max_probability: number | null;
  latency_ms: number;
  queries: string[];
  rerank_query: string;
  query_source: string;
  diagnostics?: RetrievalDiagnosticsData;
  sources?: Source[];
  answer?: string;
  cited?: string[];
  sufficiency?: EvalSufficiency;
  judgement?: EvalJudgement;
  pair_id?: string | null;
  pair_role?: "original" | "paraphrase" | null;
};
export type EvalParaphraseMetric = { original: number | null; paraphrase: number | null; delta: number | null };
export type EvalParaphrasePair = {
  pair_id: string;
  original: { id: string; question: string };
  paraphrase: { id: string; question: string };
  statuses: Record<"pool" | "top" | "final", "stable" | "lost" | "gained" | "both_missed">;
};
export type EvalParaphraseAnalysis = {
  pair_count: number;
  question_count: number;
  original: EvalSummary;
  paraphrase: EvalSummary;
  metrics: Record<string, EvalParaphraseMetric>;
  retention: Record<"pool" | "top" | "final", number | null>;
  pairs: EvalParaphrasePair[];
};
export type EvalSweepPoint = { threshold: number; false_reject_rate: number | null; false_accept_rate: number | null; recall_final: number | null };
// 「交给模型的段数」扫描：段数取 1 到候选池大小时的证据召回、全部证据都命中的题数、平均实际交给模型几段、被段数截断的题数。
export type EvalMemoryVariant = { name: string; label: string; trigger: number; keep: number;
  summary: { correctness: number | null; faithfulness: number | null; summarized_rate: number | null; input_tokens_avg: number | null };
  dialogues: { id: string; question: string; turns: number; answer: string; route: string; summarized: boolean; input_tokens: number | null; judgement: { correctness?: number; correctness_reason?: string } }[] };
export type EvalLimitPoint = { return_limit: number; recall_final: number | null; complete: number; answerable: number; multi_evidence_recall: number | null; multi_evidence: number; avg_returned: number | null; capped: number; total: number };
export type EvalVariant = { name: string; label: string; suite: string; options: Record<string, unknown>; summary: EvalSummary; funnel: EvalFunnel };
export type EvalFunnel = { total: number; pool: number; top: number; final: number };
export type EvalHistoryMetrics = {
  answerable_questions: number;
  unanswerable_questions: number;
  evidence_total: number;
  pool_chunks: number;
  pool_hits: number;
  top_total: number;
  top_chunks: number;
  top_hits: number;
  final_remaining: number;
  final_answerable_chunks: number;
  final_hits: number;
  false_reject_questions: number;
  false_accept_questions: number;
};
export type EvalConfig = { split: string | null; suites: string[]; special?: { suites: { id: string; name: string }[]; compare_memory?: boolean }; dataset_size?: number; rrf_k?: number; pool_size?: number; return_limit?: number; min_score?: number | null; reranked?: boolean; fusion?: string; methods?: string[]; model_mode?: string; embedding_mode?: string; embedding_model?: string; rerank_model?: string; rerank_mode?: string; query_source?: string[] };
export type EvalRunBrief = {
  id: string;
  // memory 是以前单独的多轮对话评测（现在并入专项评测集），旧记录仍然能打开。
  kind: "retrieval" | "generation" | "memory" | "special";
  status: "running" | "completed" | "failed" | "interrupted";
  created: string;
  finished: string | null;
  commit: string;
  config: EvalConfig;
  summary: EvalSummary | null;
  // 历史列表直接带回指标说明所需统计，展开指标时不再请求完整逐题结果。
  history_metrics?: EvalHistoryMetrics | null;
  progress: { done: number; total: number } | null;
  error: string | null;
};
export type EvalRun = EvalRunBrief & {
  by_type?: Record<string, EvalSummary>;
  funnel?: EvalFunnel;
  sweep?: EvalSweepPoint[];
  limit_sweep?: EvalLimitPoint[];
  // 多轮对话评测：每组对话记忆参数的结果。
  memory?: EvalMemoryVariant[];
  variants?: EvalVariant[];
  questions?: EvalQuestion[];
  paraphrase?: EvalParaphraseAnalysis | null;
  // 专项评测：每个专项一块结果。
  special?: EvalSpecialSection[];
  previous_id: string | null;
};
export type EvalComparisonRow = { key: string; label: string; direction: "higher" | "lower"; base: number | null; target: number | null; delta: number | null; change: "better" | "worse" | "same" | "unknown" };
// settings_diff：两次评测用的系统参数不同的项（设置页改过），分数变化可能来自参数而不是代码。
export type EvalComparison = { base: EvalRunBrief; target: EvalRunBrief; metrics: EvalComparisonRow[]; settings_diff?: { key: string; base: unknown; target: unknown }[] };
export type EvalSuite = { key: string; label: string; variants: string[] };
export type EvalDataset = { items: EvalItem[]; types: string[]; corpus: string[]; reviewed_count?: number; pending_count?: number };

export function getEvalDataset() {
  return request<EvalDataset>("/eval/dataset");
}

// 手动写入一道题；服务端负责生成编号、校验证据并标记为已人工录入。
export function addEvalDatasetItem(payload: Omit<EvalItem, "id" | "origin" | "reviewed">) {
  return request<EvalItem>("/eval/dataset/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 同义改写一次提交两个问法；服务端落盘为两条独立题目，并返回共享的题对编号。
export function addEvalDatasetPair(payload: {
  original_question: string;
  paraphrase_question: string;
  answerable: boolean;
  evidence: string[];
  reference_answer: string;
  split: string;
}) {
  return request<{ pair_id: string; items: EvalItem[] }>("/eval/dataset/pairs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 审核通过一道题；服务端持久化状态，之后它才会进入实际评测范围。
export function reviewEvalDatasetItem(itemId: string) {
  return request<EvalItem>(`/eval/dataset/items/${encodeURIComponent(itemId)}/review`, {
    method: "POST",
  });
}

// 请求大模型起草评测题；返回的题目会被服务端标记为待人工审核。
export function generateEvalDatasetItems(payload: { count: number; split: string; type?: string | null }) {
  return request<{ items: EvalItem[] }>("/eval/dataset/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function listEvalRuns() {
  return request<{ runs: EvalRunBrief[]; running: string | null; suites: EvalSuite[] }>("/eval/runs");
}

export function getEvalRun(runId: string) {
  return request<EvalRun>(`/eval/runs/${encodeURIComponent(runId)}`);
}

// 删除单条已经完成或失败的评测记录，服务端会拒绝删除正在运行的记录。
export function deleteEvalRun(runId: string) {
  return request<{ id: string; deleted: boolean }>(`/eval/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export function compareEvalRuns(base: string, target: string) {
  return request<EvalComparison>(`/eval/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`);
}

// 在界面上发起一次评测：调参评测按 split 选开发集或留出集；专项评测按 suite_ids 选专项。
export function startEvalRun(kind: "retrieval" | "generation", split: string, suites: string[]) {
  return request<{ id: string; status: string }>("/eval/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, split, suites }),
  });
}

export function startSpecialRun(suiteIds: string[], compareMemory = false) {
  return request<{ id: string; status: string }>("/eval/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "special", suite_ids: suiteIds, compare_memory: compareMemory }),
  });
}

// ---- 专项评测集 ----
// 评测方式：retrieval 只检索，answer 完整回答再评审，dialogue 按顺序问完一段对话。
export type EvalSuiteMethod = "retrieval" | "answer" | "dialogue";
// 检索、回答方式用哪几路检索：混合（默认）、只用向量、只用关键词。
export type EvalSuiteSearchMode = "hybrid" | "dense" | "keyword";
export type EvalSuiteRunEntry = { id: string; status: "running" | "completed" | "failed" | "interrupted"; created: string; finished: string | null; summary: { name: string; method: EvalSuiteMethod; count: number; passed: number } | null };
export type EvalSuiteBrief = { id: string; name: string; description: string; method: EvalSuiteMethod; method_label: string; search_mode: EvalSuiteSearchMode; search_mode_label: string; created_by: string; created: string; updated: string; item_count: number; latest: EvalSuiteRunEntry | null };
export type EvalSuiteItem = { id: string; question: string; evidence?: string[]; reference_answer?: string; turns?: string[]; created_by: string; created: string; updated: string };
export type EvalSuiteFull = EvalSuiteBrief & { items: EvalSuiteItem[]; runs: EvalSuiteRunEntry[] };
export type EvalSuiteItemInput = { question: string; evidence?: string[]; reference_answer?: string | null; turns?: string[] };
// 一道专项题的结果。检索 / 回答：每条证据在向量、关键词检索里排第几、最后有没有返回；多轮对话：最后一问的回答和评审。
export type EvalSpecialQuestion = {
  id: string;
  question: string;
  passed: boolean;
  previous_passed?: boolean | null;
  reference_answer?: string | null;
  evidence?: { text: string; dense_rank: number | null; keyword_rank: number | null; rerank_rank: number | null; status: string | null }[];
  found?: boolean;
  lost_stage?: "recall" | "rerank" | "threshold" | null;
  returned?: number;
  answer?: string;
  judgement?: Partial<EvalJudgement>;
  turns?: string[];
  summarized?: boolean;
  input_tokens?: number | null;
};
export type EvalSpecialSection = {
  suite_id: string;
  name: string;
  description: string;
  method: EvalSuiteMethod;
  method_label: string;
  search_mode?: EvalSuiteSearchMode;
  search_mode_label?: string;
  count: number;
  passed: number;
  evidence_total?: number;
  dense_found?: number;
  keyword_found?: number;
  questions: EvalSpecialQuestion[];
  variants?: { name: string; label: string; passed: number; correctness: number | null; summarized_rate: number | null; input_tokens_avg: number | null }[];
  previous?: { id: string; created: string; passed: number; count: number };
};

export function listEvalSuites() {
  return request<{ items: EvalSuiteBrief[]; methods: Record<EvalSuiteMethod, string> }>("/eval/suites");
}

export function getEvalSuite(suiteId: string) {
  return request<EvalSuiteFull>(`/eval/suites/${encodeURIComponent(suiteId)}`);
}

export function createEvalSuite(payload: { name: string; description?: string; method: EvalSuiteMethod; search_mode?: EvalSuiteSearchMode }) {
  return request<EvalSuiteFull>("/eval/suites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export function updateEvalSuite(suiteId: string, payload: { name: string; description?: string; method: EvalSuiteMethod; search_mode?: EvalSuiteSearchMode }) {
  return request<EvalSuiteFull>(`/eval/suites/${encodeURIComponent(suiteId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export function deleteEvalSuite(suiteId: string) {
  return request<{ id: string; deleted: boolean }>(`/eval/suites/${encodeURIComponent(suiteId)}`, { method: "DELETE" });
}

export function addEvalSuiteItem(suiteId: string, payload: EvalSuiteItemInput) {
  return request<EvalSuiteFull>(`/eval/suites/${encodeURIComponent(suiteId)}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export function updateEvalSuiteItem(suiteId: string, itemId: string, payload: EvalSuiteItemInput) {
  return request<EvalSuiteFull>(`/eval/suites/${encodeURIComponent(suiteId)}/items/${encodeURIComponent(itemId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export function deleteEvalSuiteItem(suiteId: string, itemId: string) {
  return request<EvalSuiteFull>(`/eval/suites/${encodeURIComponent(suiteId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

// 知识巡检（只有管理员可见）：从问答日志合并出来的问题。
export type InspectionKind = "knowledge_gap" | "suspect_content" | "system_error" | "parse_quality";
export type InspectionStatus = "open" | "handled" | "resolved" | "ignored";
export type InspectionIssueDetail = {
  signals?: Record<string, number>;
  questions?: string[];
  missing?: { text: string; count: number }[];
  comments?: string[];
  chunk_key?: string;
  document_title?: string;
  preview?: string;
  doc_key?: string;
  cited?: number;
  negative_rate?: number;
  last_step?: string;
  last_step_label?: string;
  error?: string;
  status_code?: number;
  resolution?: string;
  // 拒答分类：离线重跑检索得出的结论，只有知识缺口有。
  diagnosis?: InspectionDiagnosis;
  // 标记已处理后验证没通过时的说明。
  verification?: { passed: boolean; at: string; message: string };
  reopened?: { at: string; previous_status: InspectionStatus; new_occurrences: number };
  // 系统问题最近一次重新提问验证的结果。
  recheck?: InspectionRecheck;
  // 关联记录上"重新提问"的最近一次结果，键是 "run:编号" 或 "error:编号"。
  replays?: Record<string, InspectionReplay>;
  // 解析质量：检查的是哪份文档的哪个版本、分片数和字数、发现的问题。
  filename?: string;
  version?: number;
  chunks?: number;
  chars?: number;
  checked?: string;
  checked_by?: string;
  problems?: InspectionParseProblem[];
};
export type InspectionParseProblem = { code: "empty" | "garbled" | "spaced" | "repeated" | "fragments"; label: string; value: number; message: string; examples: string[] };
export type InspectionRecheck = { at: string; trigger: "inspection" | "manual"; by: string | null; question: string; owner: string; passed: boolean; message: string; answer?: string; route?: string; error?: string };
// 以提问人的身份把问题完整再问一遍的结果；出错时只有 error。
export type InspectionReplay = {
  at: string;
  by: string;
  question: string;
  owner: string;
  answer?: string;
  route?: string;
  refused?: boolean;
  top_score?: number | null;
  citation?: { passed: boolean; reason: string | null } | null;
  duration_ms?: number | null;
  sources?: { id: string; title: string; score?: number | null }[];
  error?: string;
};
export type InspectionDiagnosisCategory = "answerable" | "permission" | "routing" | "retrieval" | "content" | "out_of_scope" | "unknown";
export type InspectionDiagnosisDocument = { title: string; doc_key: string; owner: string; visibility: string; visibility_label?: string | null; groups: string[]; score?: number | null };
// 重新检索时得分最高的几段资料：scope=mine 是按提问人权限检索到的，all 是全库检索到、提问人看不到的。
export type InspectionDiagnosisChunk = { chunk_id: string; scope: "mine" | "all"; title: string; version?: number | null; page_start?: number | null; heading?: string | null; score: number; passed: boolean; visible: boolean; text: string; truncated: boolean };
export type InspectionDiagnosis = {
  category: InspectionDiagnosisCategory;
  label: string;
  checked_at: string;
  counts: Partial<Record<InspectionDiagnosisCategory, number>>;
  thresholds?: { min_score: number; near_miss: number; out_of_scope: number };
  // inspection：巡检时自动验证；manual：管理员点了"重新检索"。
  trigger?: "inspection" | "manual";
  checked_by?: string | null;
  questions: { question: string; owner: string; category: InspectionDiagnosisCategory; label: string; reason?: string; user_top: number | null; full_top: number | null; documents: InspectionDiagnosisDocument[]; chunks?: InspectionDiagnosisChunk[];
    // 问题提到了业务数据时，用当前的意图识别和分流规则判断会分到哪里；rerouted 表示现在会分到数据查询。
    routing?: { route: string; route_label: string; classifier?: string | null; reason?: string | null; data_types: string[] }; rerouted?: boolean }[];
};
export type InspectionFixType = "add_content" | "update_content" | "fix_parsing" | "grant_permission" | "tune_retrieval" | "tune_routing" | "update_prompt" | "fix_system" | "other";
export type InspectionCloseReason = "out_of_scope" | "by_design_permission" | "not_covered" | "invalid_feedback" | "transient" | "other";
// 页面顶部统计：最近 N 天没答上来的问答，按所属问题的处理结果分组。
export type InspectionGapSummary = { days: number; total: number; reasonable: number; reasonable_by_reason: Partial<Record<InspectionCloseReason, number>>; other_ignored: number; resolved: number; pending: number };
export type InspectionIssue = {
  id: string;
  kind: InspectionKind;
  kind_label: string;
  status: InspectionStatus;
  status_label: string;
  title: string;
  occurrences: number;
  users: number;
  detail: InspectionIssueDetail;
  note: string | null;
  status_by: string | null;
  status_updated: string | null;
  first_seen: string;
  last_seen: string;
  created: string;
  updated: string;
  // 无需处理的原因（status=ignored 时有值）；suggested 是标记无需处理时默认选中的原因。
  close_reason: InspectionCloseReason | null;
  close_reason_label: string | null;
  suggested_close_reason: InspectionCloseReason;
  // 已处理时选的修复方式（验证后变成已解决或重新打开时保留）；suggested 是标记已处理时默认选中的修复方式。
  fix_type: InspectionFixType | null;
  fix_type_label: string | null;
  suggested_fix_type: InspectionFixType;
};
export type InspectionEvent = {
  source: "run" | "error";
  source_id: string;
  owner: string;
  signals: string[];
  created: string;
  question?: string;
  answer?: string;
  top_score?: number | null;
  // 最终交给模型的资料段数。
  returned?: number | null;
  // 被相关度阈值挡掉、没交给模型的资料里得分最高的一段。
  filtered?: { chunk_id: string; title: string | null; heading?: string | null; version?: number | null; page_start?: number | null; score: number; min_score?: number | null; text: string; truncated: boolean }[];
  // 引用检查明细；回答被拦截时带模型原话。记录这项信息之前的问答为空。
  citation?: { passed: boolean; reason: "no_citation" | "unknown_source" | null; source_ids: string[]; cited: string[]; unknown: string[]; raw_answer?: string } | null;
  // 调用摘要：调用的模型及用途、重排模型、提示词版本、Token 用量、总耗时。
  call?: { models: { name: string; steps: string[] }[]; rerank_model?: string | null; prompt_version?: string | null; token_usage?: { input?: number | null; output?: number | null; total?: number | null } | null; duration_ms?: number | null };
  // 交给模型的资料原文，按 S1、S2… 排列。
  sources?: { id: string; title: string; heading?: string | null; page_start?: number | null; version?: number | null; score?: number | null; text: string; truncated: boolean }[];
  missing?: string[];
  feedback?: { rating: number; reason: FeedbackReason | null; comment: string | null } | null;
  error?: string;
  last_step?: string | null;
  status_code?: number;
};
export type InspectionIssueFull = InspectionIssue & { events: InspectionEvent[]; verify_result?: Record<string, number> };
export type InspectionRun = {
  id: string;
  status: "running" | "completed" | "failed";
  trigger: "cli" | "api" | "schedule";
  triggered_by: string | null;
  since: string;
  summary: Record<string, number>;
  error: string | null;
  started: string;
  finished: string | null;
};
export type InspectionIssuePage = {
  items: InspectionIssue[];
  total: number;
  page: number;
  page_size: number;
  status_counts: Partial<Record<InspectionStatus, number>>;
  kind_counts: Partial<Record<InspectionKind, number>>;
  reason_counts: Partial<Record<InspectionCloseReason | "none", number>>;
  // 知识缺口按拒答分类结论计数（none 是还没诊断过的），diagnoses 是结论的中文名。
  diagnosis_counts: Partial<Record<InspectionDiagnosisCategory | "none", number>>;
  diagnoses: Record<InspectionDiagnosisCategory, string>;
  gap_summary: InspectionGapSummary;
  close_reasons: Record<InspectionCloseReason, string>;
  fix_types: Record<InspectionFixType, string>;
  last_run: InspectionRun | null;
  running: boolean;
  kinds: Record<InspectionKind, string>;
  statuses: Record<InspectionStatus, string>;
  signals: Record<string, string>;
};

export function listInspectionIssues(params: { status?: InspectionStatus | null; kind?: InspectionKind | null; reason?: InspectionCloseReason | "none" | null; diagnosis?: InspectionDiagnosisCategory | "none" | null; page?: number }) {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.kind) query.set("kind", params.kind);
  if (params.reason) query.set("reason", params.reason);
  if (params.diagnosis) query.set("diagnosis", params.diagnosis);
  query.set("page", String(params.page ?? 1));
  return request<InspectionIssuePage>(`/inspection/issues?${query.toString()}`);
}

export function getInspectionIssue(issueId: string) {
  return request<InspectionIssueFull>(`/inspection/issues/${encodeURIComponent(issueId)}`);
}

// 手动标记状态（待处理 / 已处理 / 已忽略）或修改备注；已解决只由巡检自动设置。
export function updateInspectionIssue(issueId: string, payload: { status?: "open" | "handled" | "ignored"; note?: string; close_reason?: InspectionCloseReason; fix_type?: InspectionFixType }) {
  return request<InspectionIssueFull>(`/inspection/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 定时巡检设置：daily 每天 time 执行，interval 每隔 interval_hours 小时；days 是扫描最近多少天的问答。
export type InspectionSchedule = { enabled: boolean; mode: "daily" | "interval"; time: string; interval_hours: number; days: number; updated?: string | null; updated_by?: string | null };
export type InspectionScheduleView = { schedule: InspectionSchedule; next_run: string | null; last_scheduled_run: string | null; timezone: string };

export function getInspectionSchedule() {
  return request<InspectionScheduleView>("/inspection/schedule");
}

export function saveInspectionSchedule(payload: Pick<InspectionSchedule, "enabled" | "mode" | "time" | "interval_hours" | "days">) {
  return request<InspectionScheduleView>("/inspection/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 立即重新检索一个知识缺口，同步返回更新后的问题。
export function verifyInspectionIssue(issueId: string) {
  return request<InspectionIssueFull>(`/inspection/issues/${encodeURIComponent(issueId)}/verify`, { method: "POST" });
}

// 关联记录上的"重新提问"：以提问人的身份完整再问一遍，要调用大模型，可能需要十几秒。
export function replayInspectionEvent(issueId: string, source: "run" | "error", sourceId: string) {
  return request<InspectionReplay>(`/inspection/issues/${encodeURIComponent(issueId)}/events/${source}/${encodeURIComponent(sourceId)}/replay`, { method: "POST" });
}

// ---- 线上回归集 ----
// 管理员自建的评测集，题目多数从知识巡检加入，按提问人的权限在线上知识库里跑。
export type EvalSetExpect = "answer" | "refuse";
export type EvalSetKind = "retrieval" | "generation";
export type EvalSetRunSummary = { total?: number; done?: number; passed?: number; failed?: number; pass_rate?: number | null; by_expect?: Partial<Record<EvalSetExpect, { total: number; passed: number }>>; previous?: { id: string; started: string } | null; changes?: Partial<Record<"fixed" | "regressed" | "new", number>> };
export type EvalSetLatest = { id: string; status: string; summary: EvalSetRunSummary; started: string; finished: string | null };
export type EvalSetBrief = { id: string; name: string; description: string | null; created_by: string; created: string; updated: string; item_count: number; latest: Partial<Record<EvalSetKind, EvalSetLatest>> };
export type EvalSetDocument = { doc_key: string; title: string; score?: number | null };
export type EvalSetItem = { id: string; set_id: string; question: string; asker: string; expect: EvalSetExpect; expect_label: string; documents: EvalSetDocument[]; reference_answer: string | null; note: string | null; issue_id: string | null; created_by: string; created: string };
export type EvalSetRun = { id: string; set_id: string; kind: EvalSetKind; kind_label: string; status: "running" | "completed" | "failed" | "interrupted"; triggered_by: string | null; summary: EvalSetRunSummary; error: string | null; started: string; finished: string | null };
export type EvalSetResult = { item_id: string; question: string; asker: string; expect: EvalSetExpect; passed: boolean; reason: string; top_score?: number | null; documents?: EvalSetDocument[]; route?: string; refused?: boolean; answer?: string; judge?: { correctness?: number; correctness_reason?: string } | null; change?: "fixed" | "regressed" | "new"; error?: boolean };
export type EvalSetRunFull = EvalSetRun & { results: EvalSetResult[] };
export type EvalSetFull = EvalSetBrief & { items: EvalSetItem[]; runs: EvalSetRun[] };
export type EvalSetItemInput = { question: string; asker: string; expect: EvalSetExpect; documents?: string[]; reference_answer?: string | null; note?: string | null; issue_id?: string | null };
export type EvalCandidates = { issue_id: string; kind: InspectionKind; candidates: { question: string; original: string; asker: string; in_sets: string[] }[]; expect: EvalSetExpect; documents: EvalSetDocument[]; hint: string };

// 删除接口返回 204 没有内容，不能按 JSON 解析。
async function requestEmpty(path: string, options: RequestInit = {}) {
  const response = await authorizedFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail || `请求失败：${response.status}`);
  }
}

export function listEvalSets() {
  return request<{ items: EvalSetBrief[] }>("/eval/sets");
}

export function createEvalSet(name: string, description?: string) {
  return request<EvalSetFull>("/eval/sets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description }) });
}

export function getEvalSet(setId: string) {
  return request<EvalSetFull>(`/eval/sets/${encodeURIComponent(setId)}`);
}

export function updateEvalSet(setId: string, payload: { name?: string; description?: string }) {
  return request<EvalSetFull>(`/eval/sets/${encodeURIComponent(setId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export function deleteEvalSet(setId: string) {
  return requestEmpty(`/eval/sets/${encodeURIComponent(setId)}`, { method: "DELETE" });
}

export function addEvalSetItems(setId: string, items: EvalSetItemInput[]) {
  return request<{ items: EvalSetItem[] }>(`/eval/sets/${encodeURIComponent(setId)}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
}

export function updateEvalSetItem(setId: string, itemId: string, item: EvalSetItemInput) {
  return request<EvalSetItem>(`/eval/sets/${encodeURIComponent(setId)}/items/${encodeURIComponent(itemId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
}

// 编辑题目时可选的期望文档（所有文档的当前版本）。
export function listEvalDocuments() {
  return request<{ documents: { doc_key: string; title: string; owner: string }[] }>("/eval/documents");
}

export function deleteEvalSetItem(setId: string, itemId: string) {
  return requestEmpty(`/eval/sets/${encodeURIComponent(setId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export function startEvalSetRun(setId: string, kind: EvalSetKind) {
  return request<{ id: string; status: string }>(`/eval/sets/${encodeURIComponent(setId)}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
}

export function getEvalSetRun(setId: string, runId: string) {
  return request<EvalSetRunFull>(`/eval/sets/${encodeURIComponent(setId)}/runs/${encodeURIComponent(runId)}`);
}

// 把巡检问题加入回归集前的预填内容。
export function getInspectionEvalCandidates(issueId: string) {
  return request<EvalCandidates>(`/inspection/issues/${encodeURIComponent(issueId)}/eval-candidates`);
}

// 立即巡检，在服务端后台执行；完成后问题列表的 running 变为 false。
export function startInspection(days?: number) {
  return request<{ id: string; status: string }>("/inspection/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(days ? { days } : {}),
  });
}

// 设置页：当前生效的聊天模型配置，密钥只返回脱敏值。
export type LLMSettings = {
  model_mode: string;
  provider: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  has_api_key: boolean;
  source: "env" | "settings";
  updated: string | null;
};
export type LLMSettingsInput = { provider: string; base_url: string; model: string; api_key?: string | null };

export function getLLMSettings() {
  return request<LLMSettings>("/settings/llm");
}

// 保存后后端立即切换模型，不需要重启。
export function saveLLMSettings(payload: LLMSettingsInput) {
  return request<LLMSettings>("/settings/llm", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 只发一次很短的请求检查配置是否可用，不保存。
export function testLLMSettings(payload: LLMSettingsInput) {
  return request<{ ok: boolean; latency_ms: number; reply: string }>("/settings/llm/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---- 系统参数 ----
// 设置页「系统参数」：每一项的当前值、来源（settings 设置页 / env .env / default 代码默认值）、默认值和允许范围。
export type RuntimeSettingValue = boolean | number | string;
export type RuntimeSettingItem = { key: string; group: string; type: "float" | "int" | "bool" | "choice"; default: RuntimeSettingValue; value: RuntimeSettingValue; source: "settings" | "default"; advanced: boolean; min?: number; max?: number; choices?: string[] };
export type RuntimeSettingChange = { key: string; before: RuntimeSettingValue; after: RuntimeSettingValue };
export type RuntimeSettingsView = { items: RuntimeSettingItem[]; groups: Record<string, string>; pages?: Record<string, "rag" | "system">; history: { at: string; by: string; changes: RuntimeSettingChange[] }[]; cache_seconds: number; changed?: RuntimeSettingChange[] };

export function getRuntimeSettings() {
  return request<RuntimeSettingsView>("/settings/runtime");
}

// changes 里值为 null 表示恢复默认（回到 .env 或代码默认值）。
export function saveRuntimeSettings(changes: Record<string, RuntimeSettingValue | null>) {
  return request<RuntimeSettingsView>("/settings/runtime", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
}

// ---- 业务数据 ----
// 字段和数据类型配置来自后端 app/business/definitions.py，页面上的表格列、表单和校验提示都按它生成。
export type DataAction = "read" | "create" | "update" | "delete";
export type DataField = {
  name: string;
  label: string;
  type: "string" | "text" | "int" | "float" | "enum" | "date" | "ref";
  required?: boolean;
  options?: string[];
  tones?: Record<string, string>;
  ref?: string;
  derived?: boolean;
  sensitive?: boolean;
  default?: string | number;
  min?: number;
  max?: number;
  max_length?: number;
};
export type DataType = { key: string; label: string; description: string; id_prefix: string; display: string; examples: string[]; fields: DataField[]; permissions: DataAction[] };
export type DataValue = string | number | null;
export type DataRow = Record<string, DataValue> & { id: string; source: "manual" | "ai"; batch_id: string | null; created_by: string; created: string };
export type DataPage = { items: DataRow[]; total: number; page: number; page_size: number };
export type DataPreviewRow = { values: Record<string, DataValue>; labels: Record<string, string>; errors: Record<string, string> };
export type DataPreview = { rows: DataPreviewRow[]; generator: "llm" | "template"; note: string; label: string };
export type DataPermissionRow = { group_id: string; data_type: string; can_read: boolean; can_create: boolean; can_update: boolean; can_delete: boolean };

// 业务数据接口校验失败时除了总的原因，还按字段返回原因（errors），表单要把它们标在对应输入框上；
// 通用的 request 只保留 detail，所以这里单独处理。
export class DataRequestError extends Error {
  errors: Record<string, string>;
  constructor(message: string, errors: Record<string, string>) {
    super(message);
    this.errors = errors;
  }
}

async function dataRequest<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
  const options: RequestInit = { method };
  if (payload !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  const response = await authorizedFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    const detail = typeof body.detail === "string" ? body.detail : `请求失败：${response.status}`;
    throw new DataRequestError(detail, body.errors ?? {});
  }
  return response.json() as Promise<T>;
}

export function listDataTypes() {
  return dataRequest<{ types: DataType[] }>("/data/types");
}

export function listDataRecords(dataType: string, params: { q?: string; source?: string; sort?: string; direction?: "asc" | "desc"; page?: number; pageSize?: number }) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.source) query.set("source", params.source);
  if (params.sort) query.set("sort", params.sort);
  if (params.direction) query.set("direction", params.direction);
  query.set("page", String(params.page ?? 1));
  query.set("page_size", String(params.pageSize ?? 20));
  return dataRequest<DataPage>(`/data/${dataType}/records?${query.toString()}`);
}

export function listDataOptions(dataType: string, q = "") {
  return dataRequest<{ options: { id: string; label: string }[] }>(`/data/${dataType}/options?q=${encodeURIComponent(q)}`);
}

export function createDataRecord(dataType: string, values: Record<string, DataValue>) {
  return dataRequest<{ id: string }>(`/data/${dataType}/records`, "POST", { values });
}

export function updateDataRecord(dataType: string, id: string, values: Record<string, DataValue>) {
  return dataRequest<{ id: string }>(`/data/${dataType}/records/${encodeURIComponent(id)}`, "PATCH", { values });
}

export function deleteDataRecord(dataType: string, id: string) {
  return dataRequest<{ id: string }>(`/data/${dataType}/records/${encodeURIComponent(id)}`, "DELETE");
}

// AI 生成只返回预览，不写库；确认后调用 commitDataBatch 写入。
export function generateDataPreview(dataType: string, count: number, prompt: string) {
  return dataRequest<DataPreview>(`/data/${dataType}/generate`, "POST", { count, prompt });
}

export function commitDataBatch(dataType: string, rows: Record<string, DataValue>[]) {
  return dataRequest<{ batch_id: string; created: string[]; failed: { index: number; message: string; errors: Record<string, string> }[] }>(`/data/${dataType}/batches`, "POST", { rows });
}

export function deleteDataBatch(dataType: string, batchId: string) {
  return dataRequest<{ deleted: number }>(`/data/${dataType}/batches/${encodeURIComponent(batchId)}`, "DELETE");
}

export function getDataPermissions() {
  return dataRequest<{ types: { key: string; label: string }[]; permissions: DataPermissionRow[] }>("/admin/data-permissions");
}

export function saveDataPermission(payload: { group_id: string; data_type: string; read: boolean; create: boolean; update: boolean; delete: boolean }) {
  return dataRequest<DataPermissionRow>("/admin/data-permissions", "PUT", payload);
}

// 证据原文所在的分片（评测语料当前的分片里现查）。match 是证据在正文里的起止位置；
// cut 是正文里开始没参与向量计算的位置（本地向量模型才有），null 表示没被截断或拿不到。
export type EvalEvidenceChunk = { chunk_id: string | null; title: string; position: number; heading: string | null; content: string; prefix: string | null; match: [number, number]; chars: number; token_count: number | null; max_tokens?: number; truncated: boolean | null; cut: number | null };
export type EvalEvidenceLookup = { imported: boolean; cuts_available: boolean; items: { text: string; chunks: EvalEvidenceChunk[] }[] };

export function locateEvalEvidence(texts: string[]) {
  return request<EvalEvidenceLookup>("/eval/evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts }) });
}

// 运行概览：近 N 天按天汇总的问答量、失败、拒答、耗时、Token 和反馈（GET /overview）。
export type OverviewDay = { date: string; requests: number; errors: number; error_rate: number | null; knowledge: number; refused: number; refusal_rate: number | null; p50_ms: number | null; p95_ms: number | null; tokens: number; up: number; down: number };
export type Overview = {
  days: number; timezone: string; from: string; to: string;
  totals: { requests: number; runs: number; errors: number; error_rate: number | null; knowledge: number; refused: number; refusal_rate: number | null; p50_ms: number | null; p95_ms: number | null; tokens: { input: number; output: number; total: number; runs_with_usage: number }; avg_tokens: number | null; feedback: number; up: number; down: number; down_rate: number | null };
  daily: OverviewDay[];
  stages: { stage: string; label: string; count: number; p50_ms: number | null; p95_ms: number | null }[];
  routes: { route: string; label: string; count: number }[];
  retrieval: { runs: number; returned_zero: number; returned_zero_rate: number | null; top_score_p50: number | null; below_threshold: number; min_score: number };
  errors: { stages: { stage: string; label: string; count: number }[]; codes: { code: string; count: number }[] };
  feedback_reasons: { reason: string; label: string; count: number }[];
};

export function getOverview(days: number) {
  return request<Overview>(`/overview?days=${days}`);
}

// 会话记忆（GET /memory/sessions、/memory/sessions/{id}）：只能看自己的会话。
export type MemoryTurnText = { question: string; answer: string };
export type MemorySessionBrief = { session_id: string; title: string; turns: number; compressions: number; memory_tokens: number; message_count: number; snapshots: number | null; bytes: number | null; last_active: string | null };
export type MemorySessionList = { items: MemorySessionBrief[]; trigger_tokens: number; keep_tokens: number; backend?: string };
export type MemoryTimelineTurn = { index: number; run_id: string; created: string; question: string; rewritten: string | null; route: string | null; entered: boolean | null; skip_reason?: string | null; memory_tokens: number | null; messages_before: number | null; compressed: boolean; summary: string | null; kept_turns: MemoryTurnText[] | null; compressed_turns?: (MemoryTurnText & { round?: number })[] | null; kept_rounds?: number[]; previous_summary?: string | null };
export type MemorySessionDetail = {
  session_id: string; title: string; last_order: string | null; trigger_tokens: number; keep_tokens: number;
  current: { summary: string; summary_tokens: number | null; turns: MemoryTurnText[]; message_count: number; estimated_tokens: number };
  timeline: MemoryTimelineTurn[];
  storage: { snapshots?: number | null; bytes?: number | null; backend: string };
};

export function listMemorySessions() {
  return request<MemorySessionList>("/memory/sessions");
}

export function getMemorySession(sessionId: string) {
  return request<MemorySessionDetail>(`/memory/sessions/${encodeURIComponent(sessionId)}`);
}

// 提示词管理（GET /prompts、/prompts/{id}，POST 保存新版本、改用某个版本）：只有管理员。
export type PromptGroup = { key: string; label: string; description: string };
export type PromptBrief = { id: string; group: string; label: string; where: string; active_version: number; active_label: string; versions: number; updated: string | null };
export type PromptVersion = { version: number; label: string; text: string; note: string; created_by: string | null; created: string | null };
export type PromptPart = "instructions" | "locked" | { input: string };
export type PromptBox = { title: string; parts: PromptPart[] };
export type PromptDetail = {
  id: string; group: string; label: string; where: string; input: string; locked: string; locked_reason: string; note: string;
  locked_label: string; locked_display: string; boxes: PromptBox[];
  active_version: number; active_label: string; activated_by: string | null; activated_at: string | null; versions: PromptVersion[];
};

export function listPrompts() {
  return request<{ groups: PromptGroup[]; items: PromptBrief[] }>("/prompts");
}

export function getPrompt(id: string) {
  return request<PromptDetail>(`/prompts/${encodeURIComponent(id)}`);
}

export function savePromptVersion(id: string, text: string, note: string) {
  return request<PromptDetail>(`/prompts/${encodeURIComponent(id)}/versions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, note }),
  });
}

export function activatePromptVersion(id: string, version: number) {
  return request<PromptDetail>(`/prompts/${encodeURIComponent(id)}/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }),
  });
}

// 长期记忆（GET /memory/long 等）：跨会话记住的用户偏好、身份和长期关注的主题，只能看、改自己的。
export type LongMemoryItem = { id: string; content: string; category: string; created?: string; updated?: string; source_session?: string; source_run?: string };
export type LongMemoryView = { enabled: boolean; global_enabled: boolean; max_items: number; categories: Record<string, string>; items: LongMemoryItem[] };

export function getLongMemory() {
  return request<LongMemoryView>("/memory/long");
}

export function setLongMemoryEnabled(enabled: boolean) {
  return request<LongMemoryView>("/memory/long/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
}

export function deleteLongMemory(id: string) {
  return request<LongMemoryView>(`/memory/long/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function clearLongMemory() {
  return request<LongMemoryView>("/memory/long/items", { method: "DELETE" });
}
