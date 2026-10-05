from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import json
import logging
import mimetypes
import os
import time
from queue import Empty, Queue
from pathlib import Path
from threading import Lock, Thread
from typing import Any, Literal
from uuid import UUID, uuid4

import openai
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..agent.service import Agent
from ..business.sample_data import MAX_COUNT, generate_preview
from ..business.definitions import ACTIONS, DATA_TYPES, public_schema
from ..business.service import (DataError, can_pick, create_batch, create_record, delete_batch, delete_record, list_records,
    permission_matrix, ref_options, require, save_permission, update_record, user_permissions)
from ..auth import (authenticate, check_groups, create_user, decode_access_token, hash_password, issue_tokens,
    load_user, revoke_refresh_token, revoke_user_tokens, rotate_refresh_token, seed_users, set_user_groups)
from ..evaluation.dataset import QUESTION_TYPES, append_items, corpus_files, corpus_text, generate_items, load_dataset, mark_reviewed, next_item_id, next_pair_id, seed_eval_data, select_split, validate_dataset
from ..evaluation.results import compare_runs, delete_run, execute_run, import_result_files, list_runs, load_run, previous_run, start_run
from ..evaluation.retrieval import SUITES, VARIANTS
from ..evaluation import regression, suites as special_suites
from ..evaluation.evidence import locate_evidence
from .. import prompts, runtime_config
from ..ingestion.parser import ALLOWED_EXTENSIONS, UNSUPPORTED_MESSAGE
from ..inspection.diagnosis import CATEGORIES as DIAGNOSIS_CATEGORIES
from ..inspection.schedule import load_schedule, save_schedule, schedule_view
from ..inspection.service import (CLOSE_REASONS, KINDS as INSPECTION_KINDS, LOCK_KEY as INSPECTION_LOCK, MANUAL_STATUSES,
    STATUSES as INSPECTION_STATUSES, InspectionBusy, get_issue, list_issues, list_runs as list_inspection_runs,
    replay_event, run_inspection, update_issue, verify_issue)
from ..agent.response import ResponseAgent
from ..models import Models
from ..memory.service import Memory
from ..memory.view import list_sessions as list_memory, session_detail as memory_detail
from ..mysql.store import (data_permissions, document_heads, document_shares, document_steps, documents, feedback,
    run_errors, runs, sessions, user_group_members, user_groups, users)
from ..observability import FEEDBACK_REASONS, run_columns, summarize_run
from ..overview import RANGES as OVERVIEW_RANGES, overview as build_overview
from ..storage import Storage


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("production-rag")
# 从 Authorization: Bearer <令牌> 读取访问令牌；auto_error 关闭后由 current_user 统一返回中文 401。
bearer = HTTPBearer(auto_error=False)


class ChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    session_id: UUID
    request_id: UUID
    question: str = Field(min_length=1, max_length=2000)


# 界面发起评测的参数：评测类型、题目范围和检索实验组（消融、参数对比）。
class EvalRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # retrieval / generation 是调参评测（按 split 选开发集或留出集）；special 是专项评测（按 suite_ids 选专项）。
    kind: str = Field("retrieval", pattern="^(retrieval|generation|special)$")
    split: str = Field("dev", pattern="^(dev|holdout|all)$")
    suites: list[str] = Field(default_factory=list, max_length=len(SUITES))
    suite_ids: list[str] = Field(default_factory=list, max_length=50)
    # 多轮对话专项是否把记忆参数换成几组各跑一遍（默认只用当前设置）。
    compare_memory: bool = False


# 手动录入一道评测题；编号、来源和审核状态由服务端统一生成，避免客户端伪造元数据。
class EvalDatasetItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    question: str = Field(min_length=1, max_length=1000)
    type: str = Field(min_length=1, max_length=20)
    answerable: bool
    evidence: list[str] = Field(default_factory=list, max_length=10)
    reference_answer: str = Field(min_length=1, max_length=2000)
    split: str = Field("dev", pattern="^(dev|holdout)$")
    history: list[str] = Field(default_factory=list, max_length=5)


# 同义改写一次提交两个问题；服务端会拆成两条独立题目，共享答案和证据并写入同一个 pair_id。
class EvalDatasetPairInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    original_question: str = Field(min_length=1, max_length=1000)
    paraphrase_question: str = Field(min_length=1, max_length=1000)
    answerable: bool
    evidence: list[str] = Field(default_factory=list, max_length=10)
    reference_answer: str = Field(min_length=1, max_length=2000)
    split: str = Field("dev", pattern="^(dev|holdout)$")


# AI 生成题目的参数；数量设上限，避免一次请求意外产生大量模型费用和未经审核的题目。
class EvalDatasetGenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int = Field(1, ge=1, le=10)
    split: str = Field("dev", pattern="^(dev|holdout)$")
    type: str | None = Field(None, max_length=20)


# 设置页「RAG 配置」「系统配置」的修改：{参数: 新值}，null 表示恢复默认。
class RuntimeSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: dict[str, bool | int | float | str | None] = Field(max_length=50)


# 提示词页：保存新版本（指令文字和一句修改说明），或改用某个已有版本（0 = 内置版本）。
class PromptVersionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=prompts.MAX_LENGTH)
    note: str = Field("", max_length=prompts.NOTE_LENGTH)


class LongMemorySettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class PromptActivateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)


# 巡检复测集：新建或修改评测集。
# 查证据原文所在的分片：页面展开题目时传入这道题的证据。
class EvalEvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str] = Field(..., min_length=1, max_length=20)


# 专项评测集：名称、说明、评测方式（retrieval / answer / dialogue）。
class EvalSuiteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., max_length=64)
    description: str | None = Field(None, max_length=500)
    method: str = Field(..., pattern="^(retrieval|answer|dialogue)$")
    search_mode: str = Field("hybrid", pattern="^(hybrid|dense|keyword)$")


# 专项的一道题，字段随评测方式不同：检索要问题和证据，回答再加参考答案，多轮对话是前面几轮提问 + 最后一问 + 参考答案。
class EvalSuiteItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(..., max_length=500)
    evidence: list[str] = Field(default_factory=list, max_length=10)
    reference_answer: str | None = Field(None, max_length=2000)
    turns: list[str] = Field(default_factory=list, max_length=20)


class EvalSetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, max_length=100)
    description: str | None = Field(None, max_length=500)


# 巡检复测集的一道题：提问人、期望结果（answer / refuse）、期望命中的文档 doc_key；issue_id 表示来自哪个巡检问题。
class EvalSetItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=2000)
    asker: str = Field(min_length=1, max_length=32)
    expect: Literal["answer", "refuse"]
    documents: list[str] = Field(default_factory=list, max_length=10)
    reference_answer: str | None = Field(None, max_length=4000)
    note: str | None = Field(None, max_length=500)
    issue_id: str | None = Field(None, max_length=36)


class EvalSetItemsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[EvalSetItemInput] = Field(min_length=1, max_length=20)


class EvalSetRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["retrieval", "generation"]


# 用户对一次回答的反馈；request_id 即 runs.id。点赞不需要原因，点踩的原因从固定选项中选。
# 管理员修改巡检问题：status 只能是 open / handled / ignored，note 为空字符串表示清空备注。
class InspectionIssueInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str | None = None
    note: str | None = Field(None, max_length=2000)
    # status 为 ignored（无需处理）时必填，取值见 CLOSE_REASONS。
    close_reason: str | None = Field(None, max_length=32)
    # status 为 handled（已处理）时必填，取值见 FIX_TYPES。
    fix_type: str | None = Field(None, max_length=32)


# 定时巡检设置：mode 为 daily（每天 time 执行）或 interval（每隔 interval_hours 小时），days 是扫描最近多少天的问答。
class InspectionScheduleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    mode: Literal["daily", "interval"]
    time: str = Field("08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    interval_hours: int = Field(24, ge=1, le=168)
    days: int = Field(30, ge=1, le=365)


class InspectionRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: int | None = Field(None, ge=1, le=365)


class FeedbackInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    rating: Literal[1, -1]
    reason: str | None = Field(None, max_length=20)
    comment: str | None = Field(None, max_length=2000)


class DocumentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=12000)
    # 指定后作为该文档的新版本导入；不指定则创建新文档。
    replace_document_id: UUID | None = None
    version_note: str | None = Field(None, max_length=500)
    # 新文档的可见范围；替换已有文档时沿用原来的设置，这两个字段不生效。
    visibility: Literal["private", "shared", "public"] = "private"
    groups: list[str] = Field(default_factory=list, max_length=20)


# 修改文档可见范围；shared 时 groups 是共享给的部门。
class PermissionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visibility: Literal["private", "shared", "public"]
    groups: list[str] = Field(default_factory=list, max_length=20)


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=200)


class RefreshInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str = Field(min_length=1, max_length=200)


# 管理员创建用户。
class UserCreateInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=200)
    is_admin: bool = False
    groups: list[str] = Field(default_factory=list, max_length=20)


# 管理员修改用户；不传的字段保持不变。
class UserUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str | None = Field(None, min_length=8, max_length=200)
    is_admin: bool | None = None
    disabled: bool | None = None
    groups: list[str] | None = Field(None, max_length=20)


class GroupInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    # id 只为兼容旧客户端保留；管理界面不再提交，缺省时由服务端自动生成。
    id: str | None = Field(None, min_length=1, max_length=32, pattern="^[a-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)


class GroupUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)


# 在已有部门编号之后继续生成连续编号，避免管理员手填导致重复或格式不一致。
def next_group_id(connection):
    existing_ids = connection.execute(select(user_groups.c.id).where(user_groups.c.id.like("dept_%"))).scalars().all()
    used_numbers = []
    for group_id in existing_ids:
        suffix = group_id.removeprefix("dept_")
        if suffix.isdigit():
            used_numbers.append(int(suffix))
    next_number = max(used_numbers, default=0) + 1
    candidate = f"dept_{next_number:03d}"
    while connection.execute(select(user_groups.c.id).where(user_groups.c.id == candidate)).first() is not None:
        next_number += 1
        candidate = f"dept_{next_number:03d}"
    return candidate


# 业务数据：新增或修改一条记录。values 的字段由 app/business/definitions.py 的配置校验，这里只限制整体结构。
class DataRecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    values: dict[str, Any] = Field(max_length=30)


# AI 生成测试数据：条数和可选的描述，例如"数码类商品，价格 100～3000"。
class DataGenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    count: int = Field(10, ge=1, le=MAX_COUNT)
    prompt: str = Field("", max_length=500)


# 用户在预览里确认（可能改过、删过几行）后提交写入的 AI 生成数据。
class DataBatchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_COUNT)


# 管理员设置一个部门对一种数据的权限。
class DataPermissionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_id: str = Field(min_length=1, max_length=32)
    data_type: str = Field(min_length=1, max_length=32)
    read: bool = False
    create: bool = False
    update: bool = False
    delete: bool = False


# 设置页提交的聊天模型配置；所有厂商都走 OpenAI 兼容接口，只需地址、模型名和密钥。
# api_key 留空表示沿用当前密钥，这样只改模型名时不必重新粘贴密钥。
class LLMSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    provider: str = Field("custom", max_length=32)
    base_url: str = Field(min_length=1, max_length=300, pattern="^https?://")
    model: str = Field(min_length=1, max_length=100)
    api_key: str | None = Field(None, max_length=300)


# 密钥只回显首尾几位，避免在浏览器和日志里暴露完整密钥。
def mask_key(key):
    if not key:
        return ""
    if len(key) <= 10:
        return "*" * len(key)
    return key[:3] + "*" * 6 + key[-4:]


# 从访问令牌识别当前用户，返回用户名、是否管理员和所属部门；不接受请求体中的 user_id 或管理员标记。
# 原来按 .env 里配置的 API Key 识别，密钥永不过期，泄露后只能改配置重启。
# 令牌里只放用户名，是否管理员、是否停用、属于哪些部门每次从数据库读取，改了立即生效。
def current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if credentials is None:
        raise HTTPException(401, "请先登录")
    try:
        username = decode_access_token(credentials.credentials, request.app.state.jwt_secret)
    except ValueError:
        raise HTTPException(401, "登录已过期或无效，请重新登录")
    user = load_user(request.app.state.store.engine, username)
    if user is None or user["disabled"]:
        raise HTTPException(401, "用户不存在或已停用")
    return user


# 大多数接口只需要用户名（即各业务表里的 owner）。
def identity(user=Depends(current_user)):
    return user["username"]


# 管理用户、部门和全局模型配置的接口只允许管理员调用。
def require_admin(user=Depends(current_user)):
    if not user["is_admin"]:
        raise HTTPException(403, "需要管理员权限")
    return user


# 在所有会话读写之前核对归属，统一返回 404 以避免暴露他人会话。
def check_session(store, session_id, owner):
    with store.engine.connect() as connection:
        row = connection.execute(select(sessions).where(
            sessions.c.id == session_id, sessions.c.owner == owner)).first()
    if not row:
        raise HTTPException(404, "会话不存在")


# 查询一个文档的处理阶段，所有结果都来自后端持久化状态。
def read_document_steps(store, document_id):
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_steps).where(
            document_steps.c.document_id == document_id
        ).order_by(document_steps.c.step_order)).mappings().all()
    return [dict(row) for row in rows]


# 版本号来自旧数据时可能为空，统一视为第 1 版。
def version_of(row):
    return row["version"] or 1


# 把一个版本记录转换为接口返回结构，is_current 表示它是否是检索使用的当前版本。
def version_view(store, row, current_id):
    return {"document_id": row["id"], "doc_key": row["doc_key"] or row["id"], "owner": row["owner"], "title": row["title"],
        "filename": row["filename"], "status": row["status"], "error": row["error"],
        "created": row["created"], "updated": row["updated"], "version": version_of(row),
        "version_note": row["version_note"], "is_current": row["id"] == current_id,
        "document_metadata": row["document_metadata"] or {},
        "steps": read_document_steps(store, row["id"])}


# 构造 API；测试时注入存储依赖，部署时始终使用真实 MySQL、Redis 和 Milvus。
def create_app(store=None, models=None, jwt_secret=None):
    @asynccontextmanager
    async def lifespan(app):
        # JWT 签名密钥：任何拿到它的人都能伪造任意用户的令牌，必须足够长且只放在服务端。
        app.state.jwt_secret = jwt_secret or os.getenv("JWT_SECRET", "")
        if len(app.state.jwt_secret) < 32:
            raise ValueError("JWT_SECRET 至少 32 字符")
        app.state.models = models or Models()
        app.state.store = store or Storage(app.state.models)
        # 测试传入的存储不经过 Storage.__init__，这里再绑定一次系统参数的数据库。
        runtime_config.bind(app.state.store.engine)
        seed_users(app.state.store.engine)
        # 评测题目存数据库：第一次启动时从 eval/seed 导入初始的调参题和专项。
        seed_eval_data(app.state.store.engine)
        # 评测结果也存数据库：第一次启动时把 eval/results 下的旧结果文件导入。
        import_result_files(app.state.store.engine)
        # 设置页保存过模型配置时优先使用它，必须在创建 Agent 之前应用，回答 Agent 才会绑定到这个模型。
        saved_llm = app.state.store.load_llm_settings()
        if saved_llm:
            app.state.models.apply_llm(saved_llm)
        app.state.agent = Agent(app.state.models)
        app.state.memory = Memory()
        # 同一时间只允许一次界面发起的评测：评测会连续调用重排模型，并发跑多次既慢又会互相拖慢耗时统计。
        app.state.eval_lock = Lock()
        # 题目写入和 AI 起草必须串行，避免两个请求同时读取旧编号后生成重复 ID。
        app.state.eval_dataset_lock = Lock()
        app.state.eval_running = None
        # 页面发起的巡检在后台线程执行；保存线程便于测试等待它完成。
        app.state.inspection_thread = None
        # 巡检复测集的运行同样在后台线程执行；重启前没跑完的记录标记为中断。
        app.state.regression_threads = {}
        try:
            regression.interrupt_running(app.state.store)
        except Exception:
            logger.exception("regression_interrupt_failed")
        try:
            yield
        finally:
            app.state.agent.close()
            if store is None:
                app.state.store.close()

    app = FastAPI(title="Production RAG Demo", lifespan=lifespan)

    # 把依赖服务的异常换成用户看得懂的原因。以前一律提示"依赖服务暂不可用"，
    # 看不出是连不上大模型、超时还是密钥失效；详细错误仍写入 run_errors 和日志。
    # 用 isinstance 判断：langchain 会把 openai 的异常包装成 OpenAIConnectionError 等子类，按类名匹配会漏掉。
    # 超时是连接错误的子类，要先判断。
    def dependency_error_message(error):
        if isinstance(error, openai.APITimeoutError):
            return "大模型调用超时，请稍后重试"
        if isinstance(error, openai.APIConnectionError):
            return "连不上大模型服务，请检查网络或代理后重试"
        if isinstance(error, openai.AuthenticationError):
            return "大模型密钥无效，请在设置页检查模型配置"
        if isinstance(error, openai.RateLimitError):
            return "大模型请求过于频繁或账户余额不足，请稍后重试"
        return "依赖服务暂不可用，请稍后重试"

    # 为所有请求生成追踪 ID，只记录路径、状态与耗时，不记录密钥和正文。
    @app.middleware("http")
    async def trace(request, call_next):
        request.state.trace_id = str(uuid4())
        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception as error:
            logger.exception("dependency_failure trace_id=%s", request.state.trace_id)
            response = JSONResponse(status_code=503, content={"detail": dependency_error_message(error)})
        response.headers["X-Trace-ID"] = request.state.trace_id
        logger.info(json.dumps({"trace_id": request.state.trace_id, "path": request.url.path,
            "status": response.status_code, "duration_ms": round((time.monotonic() - start) * 1000)}))
        return response

    # 存活检查只检查 API 进程。
    @app.get("/health/live")
    def live():
        return {"status": "alive"}

    # 就绪检查实际查询三个依赖，不调用付费模型。
    @app.get("/health/ready")
    def ready():
        app.state.store.ready()
        app.state.agent.response_agent.memory.ready()
        return {"status": "ready", "model_mode": app.state.models.mode}

    # 设置页回显当前生效的聊天模型配置，密钥只返回脱敏值。
    def llm_settings_view():
        models = app.state.models
        saved = app.state.store.load_llm_settings()
        return {"model_mode": models.mode, "provider": models.llm_provider, "base_url": models.llm_base_url,
            "model": models.llm_model, "api_key_masked": mask_key(models.llm_api_key),
            "has_api_key": bool(models.llm_api_key), "source": models.llm_source,
            "updated": saved["updated"] if saved else None}

    # 本次提交没有填写密钥时，只有地址不变才沿用当前密钥；换了厂商还沿用旧密钥必然鉴权失败。
    def resolve_llm_key(body):
        if body.api_key:
            return body.api_key
        if body.base_url == app.state.models.llm_base_url and app.state.models.llm_api_key:
            return app.state.models.llm_api_key
        raise HTTPException(422, "请填写该服务的 API Key")

    @app.get("/settings/llm")
    def get_llm_settings(owner=Depends(identity)):
        return llm_settings_view()

    # 保存并立即切换聊天模型；配置对所有用户生效，因此只有管理员可以修改。
    @app.put("/settings/llm")
    def save_llm_settings(body: LLMSettingsInput, admin=Depends(require_admin)):
        owner = admin["username"]
        value = {"provider": body.provider, "base_url": body.base_url, "model": body.model,
            "api_key": resolve_llm_key(body)}
        app.state.store.save_llm_settings(value)
        app.state.models.apply_llm(value)
        # 回答 Agent 和摘要中间件都绑定了聊天模型，切换模型时一起重建，会话记忆保留。
        app.state.agent.response_agent.rebuild()
        logger.info("llm_settings_saved owner=%s provider=%s model=%s", owner, body.provider, body.model)
        return llm_settings_view()

    # 用一次很短的请求检查地址、密钥和模型名是否可用，不保存配置；demo 模式下也能先测试再切换。
    @app.post("/settings/llm/test")
    def test_llm_settings(body: LLMSettingsInput, admin=Depends(require_admin)):
        chat_model = Models.build_chat_model(body.base_url, resolve_llm_key(body), body.model, timeout=15)
        start = time.monotonic()
        try:
            response = chat_model.bind(max_tokens=16).invoke([("user", "只回复 OK")])
        except Exception as error:
            # 模型服务返回的错误（401 密钥错误、404 模型不存在等）原样提示给用户，便于排查。
            raise HTTPException(400, f"连接失败：{str(error)[:300]}")
        reply = response.content if isinstance(response.content, str) else str(response.content)
        return {"ok": True, "latency_ms": round((time.monotonic() - start) * 1000), "reply": reply[:100]}

    # 登录：用户名密码正确时发放访问令牌和刷新令牌。
    # 同一用户名 15 分钟内失败 5 次后暂时拒绝，防止在线暴力猜密码；失败提示不区分"用户不存在"和"密码错误"。
    @app.post("/auth/login")
    def login(body: LoginInput):
        store = app.state.store
        attempts_key = f"login:fail:{body.username}"
        failures = int(store.cache.get(attempts_key) or 0)
        if failures >= 5:
            raise HTTPException(429, "登录失败次数过多，请 15 分钟后再试")
        user = authenticate(store.engine, body.username, body.password)
        if user is None:
            store.cache.eval(
                "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
                1, attempts_key)
            raise HTTPException(401, "用户名或密码错误")
        store.cache.delete(attempts_key)
        tokens = issue_tokens(store.engine, user["username"], app.state.jwt_secret)
        return {**tokens, "user": load_user(store.engine, user["username"])}

    # 用刷新令牌换新令牌。访问令牌过期后前端自动调用，用户不用重新输入密码。
    @app.post("/auth/refresh")
    def refresh(body: RefreshInput):
        try:
            username, tokens = rotate_refresh_token(app.state.store.engine, body.refresh_token, app.state.jwt_secret)
        except ValueError as error:
            raise HTTPException(401, str(error))
        return {**tokens, "user": load_user(app.state.store.engine, username)}

    # 退出登录：作废刷新令牌。访问令牌由前端删除，最多 30 分钟后也会自然过期。
    @app.post("/auth/logout")
    def logout(body: RefreshInput):
        revoke_refresh_token(app.state.store.engine, body.refresh_token)
        return {"ok": True}

    @app.get("/auth/me")
    def me(user=Depends(current_user)):
        return user

    # 部门列表：上传文档选择共享部门时需要，所有登录用户都可以查看。
    @app.get("/groups")
    def list_groups(user=Depends(current_user)):
        with app.state.store.engine.connect() as connection:
            rows = connection.execute(select(user_groups).order_by(user_groups.c.id)).mappings().all()
        result = []
        for row in rows:
            result.append({"id": row["id"], "name": row["name"]})
        return {"groups": result}

    @app.post("/admin/groups", status_code=201)
    def create_group(body: GroupInput, admin=Depends(require_admin)):
        try:
            with app.state.store.engine.begin() as connection:
                group_id = body.id or next_group_id(connection)
                connection.execute(user_groups.insert().values(id=group_id, name=body.name))
        except IntegrityError:
            raise HTTPException(409, "部门编号已存在")
        return {"id": group_id, "name": body.name}

    # 部门编号是用户、文档和权限表里的关联键，编辑时只允许修改名称，避免破坏已有归属关系。
    @app.patch("/admin/groups/{group_id}")
    def update_group(group_id: str, body: GroupUpdateInput, admin=Depends(require_admin)):
        with app.state.store.engine.begin() as connection:
            row = connection.execute(select(user_groups).where(user_groups.c.id == group_id)).mappings().first()
            if row is None:
                raise HTTPException(404, "部门不存在")
            connection.execute(user_groups.update().where(user_groups.c.id == group_id).values(name=body.name))
        return {"id": group_id, "name": body.name}

    # 删除部门时同时清理关联数据，避免用户、文档和权限矩阵继续引用已不存在的部门。
    @app.delete("/admin/groups/{group_id}")
    def delete_group(group_id: str, admin=Depends(require_admin)):
        with app.state.store.engine.begin() as connection:
            row = connection.execute(select(user_groups).where(user_groups.c.id == group_id)).first()
            if row is None:
                raise HTTPException(404, "部门不存在")
            connection.execute(user_groups.delete().where(user_groups.c.id == group_id))
            connection.execute(user_group_members.delete().where(user_group_members.c.group_id == group_id))
            connection.execute(document_shares.delete().where(document_shares.c.group_id == group_id))
            connection.execute(data_permissions.delete().where(data_permissions.c.group_id == group_id))
        return {"id": group_id}

    @app.get("/admin/users")
    def list_users(admin=Depends(require_admin)):
        with app.state.store.engine.connect() as connection:
            names = connection.execute(select(users.c.username).order_by(users.c.username)).scalars().all()
        result = []
        for username in names:
            result.append(load_user(app.state.store.engine, username))
        return {"users": result}

    @app.post("/admin/users", status_code=201)
    def add_user(body: UserCreateInput, admin=Depends(require_admin)):
        try:
            create_user(app.state.store.engine, body.username, body.password, body.is_admin, body.groups)
        except ValueError as error:
            raise HTTPException(422, str(error))
        return load_user(app.state.store.engine, body.username)

    # 修改用户。改密码或停用时作废他的全部刷新令牌，已登录的设备最多 30 分钟后必须重新登录。
    # 管理员不能停用自己或取消自己的管理员身份，避免系统里一个管理员都没有。
    @app.patch("/admin/users/{username}")
    def update_user(username: str, body: UserUpdateInput, admin=Depends(require_admin)):
        if username == admin["username"] and (body.disabled or body.is_admin is False):
            raise HTTPException(422, "不能停用自己或取消自己的管理员身份")
        try:
            with app.state.store.engine.begin() as connection:
                exists = connection.execute(select(users.c.username).where(users.c.username == username)).first()
                if exists is None:
                    raise HTTPException(404, "用户不存在")
                values = {}
                if body.password is not None:
                    values["password_hash"] = hash_password(body.password)
                if body.is_admin is not None:
                    values["is_admin"] = body.is_admin
                if body.disabled is not None:
                    values["disabled"] = body.disabled
                if values:
                    connection.execute(users.update().where(users.c.username == username).values(**values))
                if body.password is not None or body.disabled:
                    revoke_user_tokens(connection, username)
                if body.groups is not None:
                    set_user_groups(connection, username, body.groups)
        except ValueError as error:
            raise HTTPException(422, str(error))
        return load_user(app.state.store.engine, username)

    # 创建服务器生成的会话 ID。
    @app.post("/sessions", status_code=201)
    def create_session(owner=Depends(identity)):
        session_id = str(uuid4())
        with app.state.store.engine.begin() as connection:
            connection.execute(sessions.insert().values(id=session_id, owner=owner))
        return {"session_id": session_id}

    # 返回当前用户会话的最近六轮问答。
    @app.get("/sessions/{session_id}")
    def get_history(session_id: UUID, owner=Depends(identity)):
        value = str(session_id)
        check_session(app.state.store, value, owner)
        return {"messages": app.state.memory.history(app.state.store, value, owner)}

    # 会话记忆：只能看自己的会话（对话内容是个人数据，管理员也看不到别人的）。
    @app.get("/memory/sessions")
    def list_memory_sessions(owner=Depends(identity)):
        return list_memory(app.state.store.engine, app.state.agent.response_agent.memory, owner)

    @app.get("/memory/sessions/{session_id}")
    def get_memory_session(session_id: UUID, owner=Depends(identity)):
        detail = memory_detail(app.state.store.engine, app.state.agent.response_agent.memory, owner, str(session_id))
        if detail is None:
            raise HTTPException(404, "会话不存在")
        return detail

    # 长期记忆：跨会话记住的用户偏好、身份和长期关注的主题。同样只能看、改自己的。
    def long_term():
        return app.state.agent.response_agent.memory.long_term

    @app.get("/memory/long")
    def get_long_memory(owner=Depends(identity)):
        return long_term().view(owner)

    @app.put("/memory/long/settings")
    def set_long_memory(body: LongMemorySettingsInput, owner=Depends(identity)):
        long_term().set_enabled(owner, body.enabled)
        return long_term().view(owner)

    @app.delete("/memory/long/items/{key}")
    def delete_long_memory(key: str, owner=Depends(identity)):
        if not long_term().delete(owner, key):
            raise HTTPException(404, "这条记忆不存在")
        return long_term().view(owner)

    @app.delete("/memory/long/items")
    def clear_long_memory(owner=Depends(identity)):
        long_term().clear(owner)
        return long_term().view(owner)

    # 返回当前用户最近保存的问答记录，供控制台刷新后恢复显示。
    @app.get("/history")
    def get_saved_history(owner=Depends(identity)):
        with app.state.store.engine.connect() as connection:
            rows = connection.execute(select(runs).where(
                runs.c.owner == owner
            ).order_by(runs.c.created.desc()).limit(50)).mappings().all()
        ratings = read_feedback(owner, [row["id"] for row in rows])
        messages = []
        for row in reversed(rows):
            item = dict(row)
            item["feedback"] = ratings.get(row["id"])
            messages.append(item)
        return {"messages": messages}

    # 批量读取当前用户对若干次回答的反馈，返回 {run_id: 反馈}。
    def read_feedback(owner, run_ids):
        if not run_ids:
            return {}
        with app.state.store.engine.connect() as connection:
            rows = connection.execute(select(feedback).where(feedback.c.owner == owner,
                feedback.c.run_id.in_(run_ids))).mappings().all()
        result = {}
        for row in rows:
            result[row["run_id"]] = feedback_view(row)
        return result

    # 反馈的接口返回结构。
    def feedback_view(row):
        return {"request_id": row["run_id"], "rating": row["rating"], "reason": row["reason"],
            "reason_label": FEEDBACK_REASONS.get(row["reason"]), "comment": row["comment"],
            "created": row["created"], "updated": row["updated"]}

    # 提交或修改对一次回答的反馈；只能评价自己的回答，每次回答只保留最新一条。
    @app.post("/feedback")
    def submit_feedback(body: FeedbackInput, owner=Depends(identity)):
        run_id = str(body.request_id)
        if body.reason is not None and body.reason not in FEEDBACK_REASONS:
            raise HTTPException(422, f"未知的反馈原因：{body.reason}")
        # 点赞时丢弃原因，避免改判后仍残留点踩原因。
        reason = body.reason if body.rating == -1 else None
        comment = body.comment or None
        now = datetime.now(timezone.utc).isoformat()
        with app.state.store.engine.begin() as connection:
            run = connection.execute(select(runs.c.id, runs.c.session_id).where(
                runs.c.id == run_id, runs.c.owner == owner)).mappings().first()
            if not run:
                raise HTTPException(404, "回答记录不存在")
            existing = connection.execute(select(feedback.c.created).where(
                feedback.c.run_id == run_id)).first()
            values = {"rating": body.rating, "reason": reason, "comment": comment, "updated": now}
            if existing:
                connection.execute(feedback.update().where(feedback.c.run_id == run_id).values(**values))
            else:
                connection.execute(feedback.insert().values(run_id=run_id, owner=owner,
                    session_id=run["session_id"], created=now, **values))
        return read_feedback(owner, [run_id])[run_id]

    # 列出当前用户的反馈及对应问答的追踪摘要，供排查坏例：默认只看点踩（rating=0 看全部），按时间倒序。
    @app.get("/feedback")
    def list_feedback(rating: int = Query(-1), limit: int = Query(50, ge=1, le=200),
                      owner=Depends(identity)):
        query = select(feedback, runs.c.question, runs.c.response, runs.c.trace, runs.c.created.label("run_created")).join(
            runs, runs.c.id == feedback.c.run_id).where(feedback.c.owner == owner)
        if rating in (1, -1):
            query = query.where(feedback.c.rating == rating)
        with app.state.store.engine.connect() as connection:
            rows = connection.execute(query.order_by(feedback.c.updated.desc()).limit(limit)).mappings().all()
        items = []
        for row in rows:
            item = feedback_view(row)
            item.update({"question": row["question"], "answer": (row["response"] or {}).get("answer"),
                "run_created": row["run_created"], "trace": row["trace"]})
            items.append(item)
        return {"items": items, "reasons": FEEDBACK_REASONS}

    # 同步导入有大小上限的文本，同样走"去重 → 新版本 → 切换当前版本"流程。
    # 以前这里不建文档记录、分片 ID 由全文决定；改为版本管理后，没有文档记录的分片无法成为当前版本，也就检索不到。
    @app.post("/documents")
    def ingest(body: DocumentInput, owner=Depends(identity)):
        store = app.state.store
        content_sha256 = hashlib.sha256(body.content.encode()).hexdigest()
        replace_id = str(body.replace_document_id) if body.replace_document_id else None
        groups = check_permission(body.visibility, body.groups)
        doc_key, version = allocate_version(owner, replace_id)
        # 带上 Contextual Retrieval 开关：开关、分片大小或重叠变了以后，用同一内容替换文档时要重新导入。
        duplicate = store.find_duplicate(owner, content_sha256, doc_key, app.state.models.contextual)
        if duplicate:
            return {"document_id": duplicate, "chunks": 0, "duplicate": True}
        document_id = str(uuid4())
        create_version(document_id, owner, body.title, f"{body.title}.txt", "",
            # 直接提交的文本不经过解析器，以前只记 sha256，和上传文件的元数据对不上；补上解析方式和字符数。
            {"sha256": content_sha256, "parser": "raw_text", "char_count": len(body.content)},
            doc_key, version, body.version_note, content_sha256)
        if doc_key is None:
            store.set_document_permission(document_id, body.visibility, groups)
        try:
            count = store.ingest(owner, body.title, body.content, app.state.models,
                document_id, doc_key or document_id)
            activated, _ = store.activate_version(document_id, count)
        except Exception:
            store.mysql.update_document(document_id, "failed", "导入失败")
            store.remove_version_data(document_id)
            raise
        return {"document_id": document_id, "chunks": count, "version": version,
            "activated": activated, "duplicate": False}

    # 校验可见范围：shared 必须选至少一个部门，部门必须存在；返回去重后的部门列表。
    def check_permission(visibility, groups):
        if visibility == "shared" and not groups:
            raise HTTPException(422, "共享给部门时至少选择一个部门")
        try:
            with app.state.store.engine.connect() as connection:
                return check_groups(connection, groups) if visibility == "shared" else []
        except ValueError as error:
            raise HTTPException(422, str(error))

    # 替换已有文档时校验归属并分配版本号；目标不存在返回 404。
    def allocate_version(owner, replace_id):
        try:
            return app.state.store.next_version(owner, replace_id)
        except LookupError:
            raise HTTPException(404, "要替换的文档不存在")

    # 写入版本记录；同一文档并发上传算出相同版本号时，唯一约束拒绝后到的请求。
    def create_version(document_id, owner, title, filename, path, document_metadata, doc_key, version,
                       version_note, content_sha256):
        try:
            app.state.store.mysql.create_document(document_id, owner, title, filename, path,
                document_metadata, doc_key=doc_key, version=version, version_note=version_note,
                content_sha256=content_sha256)
        except IntegrityError:
            raise HTTPException(409, "该文档正在上传新版本，请稍后重试")

    # 按逻辑文档返回列表：每份文档展示当前版本（还没有可用版本时展示最新版本），
    # 并在 pending 中给出比当前版本更新、仍在处理或失败的版本，以前每次上传各占一行，看不出版本关系。
    @app.get("/documents")
    # 加了文档权限后，列表同时包含别人共享或公开给自己的文档；别人的文档只展示当前版本，
    # 不展示处理中的新版本，也不能修改（can_edit 为 false）。
    def list_documents(owner=Depends(identity)):
        store = app.state.store
        with store.engine.connect() as connection:
            readable = store.readable_condition(connection, owner, documents.c.doc_key, documents.c.owner)
            rows = connection.execute(select(documents).where(readable).order_by(
                documents.c.updated.desc())).mappings().all()
            heads = connection.execute(select(document_heads).where(store.readable_condition(
                connection, owner, document_heads.c.doc_key, document_heads.c.owner))).mappings().all()
        current_ids = {}
        for head in heads:
            current_ids[head["doc_key"]] = head["current_document_id"]
        groups = {}
        order = []
        for row in rows:
            doc_key = row["doc_key"] or row["id"]
            # 别人的文档还没有可用版本时不展示；只展示别人的当前版本。
            if row["owner"] != owner and current_ids.get(doc_key) != row["id"]:
                continue
            if doc_key not in groups:
                groups[doc_key] = []
                order.append(doc_key)
            groups[doc_key].append(row)
        result = []
        for doc_key in order[:50]:
            versions = sorted(groups[doc_key], key=version_of)
            current_id = current_ids.get(doc_key)
            display = versions[-1]
            for row in versions:
                if row["id"] == current_id:
                    display = row
            item = version_view(app.state.store, display, current_id)
            item["version_count"] = len(versions)
            item.update(store.document_permission(doc_key))
            item["can_edit"] = display["owner"] == owner
            latest = versions[-1]
            item["pending"] = None
            if latest["id"] != display["id"] and latest["status"] != "superseded":
                item["pending"] = {"document_id": latest["id"], "version": version_of(latest),
                    "status": latest["status"], "error": latest["error"]}
            result.append(item)
        return {"documents": result}

    # 保存上传文件并投递到 Redis 队列，由独立 Worker 解析和向量化。
    @app.post("/documents/upload", status_code=202)
    def upload_document(title: str | None = Form(None), file: UploadFile = File(...),
                        replace_document_id: UUID | None = Form(None), version_note: str | None = Form(None),
                        visibility: Literal["private", "shared", "public"] = Form("private"),
                        groups: str = Form("", max_length=700), owner=Depends(identity)):
        filename = Path(file.filename or "document").name
        suffix = Path(filename).suffix.lower()
        if suffix == ".xls":
            raise HTTPException(415, "暂不支持旧版 Excel（.xls），请在 Excel 里另存为 .xlsx 后再上传")
        if suffix not in ALLOWED_EXTENSIONS:
            raise HTTPException(415, UNSUPPORTED_MESSAGE)
        content = file.file.read(20 * 1024 * 1024 + 1)
        if len(content) > 20 * 1024 * 1024:
            raise HTTPException(413, "单个文件不能超过 20 MB")

        # 先分配版本再去重：替换已有文档时只和它的当前版本比较，内容没变就不再解析。
        content_sha256 = hashlib.sha256(content).hexdigest()
        replace_id = str(replace_document_id) if replace_document_id else None
        # 表单里的部门用逗号分隔。
        group_ids = []
        for item in groups.split(","):
            if item.strip():
                group_ids.append(item.strip())
        group_ids = check_permission(visibility, group_ids)
        doc_key, version = allocate_version(owner, replace_id)
        duplicate = app.state.store.find_duplicate(owner, content_sha256, doc_key, app.state.models.contextual)
        if duplicate:
            return {"document_id": duplicate, "status": "duplicate", "filename": filename}
        document_id = str(uuid4())
        upload_dir = Path(os.getenv("UPLOAD_DIR", "./uploads"))
        upload_dir.mkdir(parents=True, exist_ok=True)
        target = upload_dir / f"{document_id}{suffix}"
        target.write_bytes(content)
        document_title = (title or Path(filename).stem).strip()[:200]
        document_metadata = {"mime_type": mimetypes.guess_type(filename)[0] or file.content_type or "application/octet-stream",
            "file_size_bytes": len(content), "sha256": content_sha256}
        try:
            create_version(document_id, owner, document_title, filename, str(target), document_metadata,
                doc_key, version, version_note, content_sha256)
        except HTTPException:
            target.unlink(missing_ok=True)
            raise
        if doc_key is None:
            app.state.store.set_document_permission(document_id, visibility, group_ids)
        app.state.store.cache.rpush("ingest:jobs", json.dumps({
            "document_id": document_id, "owner": owner, "title": document_title, "path": str(target),
            "doc_key": doc_key or document_id
        }))
        return {"document_id": document_id, "status": "queued", "filename": filename, "version": version}

    # 分页返回当前用户文档的全部分块详情，处理流程由独立接口字段继续提供。
    @app.get("/documents/{document_id}/chunks")
    def list_document_chunks(document_id: UUID, page: int = Query(1, ge=1),
                              page_size: int = Query(10, ge=1, le=100),
                              source: str | None = Query(None, pattern="^(reused|computed)$"), owner=Depends(identity)):
        # 先按读权限找到文档，再以上传者身份读取分块：共享给自己的文档也能查看分块。
        row = app.state.store.readable_document(owner, str(document_id))
        if row is None:
            raise HTTPException(404, "文档不存在")
        result = app.state.store.list_document_chunks(row["owner"], str(document_id), page, page_size, source)
        if result is None:
            raise HTTPException(404, "文档不存在")
        return result

    # 返回当前用户可读的文档版本状态，并附带同一文档的全部版本历史和可见范围。
    @app.get("/documents/{document_id}")
    def document_status(document_id: UUID, owner=Depends(identity)):
        row = app.state.store.readable_document(owner, str(document_id))
        if not row:
            raise HTTPException(404, "文档不存在")
        with app.state.store.engine.connect() as connection:
            doc_key = row["doc_key"] or row["id"]
            head = connection.execute(select(document_heads).where(
                document_heads.c.doc_key == doc_key)).mappings().first()
            # 升级前的旧记录可能没有 doc_key，用自身 id 兜底。
            siblings = connection.execute(select(documents).where(documents.c.owner == row["owner"],
                (documents.c.doc_key == doc_key) | (documents.c.id == doc_key))).mappings().all()
        current_id = head["current_document_id"] if head else None
        result = version_view(app.state.store, row, current_id)
        history = []
        for sibling in sorted(siblings, key=version_of, reverse=True):
            history.append({"document_id": sibling["id"], "version": version_of(sibling),
                "status": sibling["status"], "error": sibling["error"], "filename": sibling["filename"],
                "created": sibling["created"], "version_note": sibling["version_note"],
                "is_current": sibling["id"] == current_id})
        result["versions"] = history
        result.update(app.state.store.document_permission(doc_key))
        result["can_edit"] = row["owner"] == owner
        # 缺少上下文说明的分片数和是否启用了 Contextual Retrieval，页面据此显示"补全"按钮或说明为什么没有。
        result["contextual_enabled"] = bool(app.state.models.contextual)
        result["context_missing"] = app.state.store.missing_context_count(row["id"]) \
            if row["status"].startswith("ready") else 0
        return result

    # 修改文档可见范围，只有上传者可以修改；对全部版本生效，检索下一次请求就按新范围过滤。
    @app.put("/documents/{document_id}/permission")
    def update_permission(document_id: UUID, body: PermissionInput, owner=Depends(identity)):
        row = app.state.store.readable_document(owner, str(document_id))
        if not row:
            raise HTTPException(404, "文档不存在")
        if row["owner"] != owner:
            raise HTTPException(403, "只有上传者可以修改可见范围")
        groups = check_permission(body.visibility, body.groups)
        doc_key = row["doc_key"] or row["id"]
        app.state.store.set_document_permission(doc_key, body.visibility, groups)
        return {"document_id": row["id"], **app.state.store.document_permission(doc_key)}

    # 重新处理一个失败的文档版本：改回排队状态并重新投递任务。
    # 以前失败后只能重新上传同一个文件，或者手动改数据库再重启 worker；现在上传者可以在详情页直接重试。
    @app.post("/documents/{document_id}/retry")
    def retry_document(document_id: UUID, owner=Depends(identity)):
        store = app.state.store
        row = store.readable_document(owner, str(document_id))
        if not row:
            raise HTTPException(404, "文档不存在")
        if row["owner"] != owner:
            raise HTTPException(403, "只有上传者可以重新处理文档")
        # 直接提交文本的导入没有原文件，worker 无法重做。
        if not row["path"] or not Path(row["path"]).exists():
            raise HTTPException(409, "原文件不存在，请重新上传")
        # 只在状态仍是 failed 时才改回排队：连续点两次时第二次不会重复投递任务。
        with store.engine.begin() as connection:
            changed = connection.execute(documents.update().where(
                documents.c.id == row["id"], documents.c.status == "failed").values(
                status="queued", error=None, updated=datetime.now(timezone.utc).isoformat())).rowcount
        if not changed:
            raise HTTPException(409, "只有处理失败的文档可以重新处理")
        # 清掉解析（第 2 步）及之后的旧步骤，页面上只保留"接收上传文件"并标明是重新排队。
        store.mysql.clear_document_steps(row["id"], 2)
        store.mysql.update_document_step(row["id"], "queued", 1, "queue", "接收上传文件", "completed",
            "已重新进入解析队列", {"filename": row["filename"], "title": row["title"]})
        store.cache.rpush("ingest:jobs", json.dumps({
            "document_id": row["id"], "owner": row["owner"], "title": row["title"], "path": row["path"],
            "doc_key": row["doc_key"] or row["id"]}))
        return {"document_id": row["id"], "status": "queued"}

    # 为已完成版本里上下文说明生成失败的分片补生成说明。只处理失败的那几个分片，不重新导入整份文档；
    # 任务交给 worker 执行（要调用大模型和向量服务，可能要几十秒），期间版本照常提供检索。
    @app.post("/documents/{document_id}/contexts/retry")
    def retry_document_contexts(document_id: UUID, owner=Depends(identity)):
        store = app.state.store
        row = store.readable_document(owner, str(document_id))
        if not row:
            raise HTTPException(404, "文档不存在")
        if row["owner"] != owner:
            raise HTTPException(403, "只有上传者可以补全上下文")
        if not row["status"].startswith("ready"):
            raise HTTPException(409, "文档处理完成后才能补全上下文")
        if not app.state.models.contextual:
            raise HTTPException(409, "当前没有启用 Contextual Retrieval")
        if not store.missing_context_count(row["id"]):
            raise HTTPException(409, "没有需要补全的分片")
        # 补全时要用原文件还原全文，直接提交文本的导入没有原文件。
        if not row["path"] or not Path(row["path"]).exists():
            raise HTTPException(409, "原文件不存在，无法补全")
        # 只在该步骤不是进行中时才改为进行中：重复点击不会投递第二个任务。
        with store.engine.begin() as connection:
            changed = connection.execute(document_steps.update().where(
                document_steps.c.document_id == row["id"], document_steps.c.step_id == "context",
                document_steps.c.status != "running").values(status="running", detail="正在补全失败的上下文说明",
                updated=datetime.now(timezone.utc).isoformat())).rowcount
        if not changed:
            raise HTTPException(409, "正在补全中，请稍候")
        store.cache.rpush("ingest:jobs", json.dumps({"type": "contexts", "document_id": row["id"], "path": row["path"]}))
        return {"document_id": row["id"], "status": "running"}

    # 删除整份文档（全部版本）及其索引和原文件；未完成版本也直接清理已经生成的数据。
    @app.delete("/documents/{document_id}")
    def delete_document(document_id: UUID, owner=Depends(identity)):
        document_key = str(document_id)
        readable = app.state.store.readable_document(owner, document_key)
        if readable is not None and readable["owner"] != owner:
            raise HTTPException(403, "只有上传者可以删除文档")
        with app.state.store.engine.connect() as connection:
            row = connection.execute(select(documents).where(
                documents.c.id == document_key, documents.c.owner == owner)).mappings().first()
            if not row:
                raise HTTPException(404, "文档不存在")
        paths = app.state.store.delete_document(owner, document_key)
        upload_dir = Path(os.getenv("UPLOAD_DIR", "./uploads")).resolve()
        for path in paths:
            if not path:
                continue
            target = Path(path).resolve()
            try:
                target.relative_to(upload_dir)
            except ValueError:
                continue
            target.unlink(missing_ok=True)
        return {"document_id": document_key, "deleted": True, "version_count": len(paths)}

    # 业务数据接口统一把校验和权限错误转换成 JSON：detail 是总的原因，errors 按字段给出原因，前端标在对应输入框上。
    @app.exception_handler(DataError)
    async def data_error_handler(request, error):
        return JSONResponse(status_code=error.status, content={"detail": error.message, "errors": error.errors})

    # 当前用户能看到的数据类型（tab）、字段配置和操作权限。没有查看权限的类型不返回，页面上也就没有这个 tab。
    @app.get("/data/types")
    def data_types(user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        result = []
        for data_type in DATA_TYPES:
            if "read" not in permissions[data_type]:
                continue
            item = public_schema(data_type)
            granted = []
            for action in ACTIONS:
                if action in permissions[data_type]:
                    granted.append(action)
            item["permissions"] = granted
            result.append(item)
        return {"types": result}

    @app.get("/data/{data_type}/records")
    def data_records(data_type: str, q: str = Query("", max_length=100), source: str | None = Query(None),
                     batch_id: str | None = Query(None, max_length=36), sort: str | None = Query(None, max_length=32),
                     direction: Literal["asc", "desc"] = "desc", page: int = Query(1, ge=1),
                     page_size: int = Query(20, ge=1, le=100), user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "read")
        return list_records(app.state.store.engine, data_type, permissions, q=q, source=source, batch_id=batch_id,
            sort=sort, direction=direction, page=page, page_size=page_size)

    # 引用字段的下拉选项，例如新增订单时选择客户和商品。
    @app.get("/data/{data_type}/options")
    def data_options(data_type: str, q: str = Query("", max_length=100), user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        if data_type not in DATA_TYPES:
            raise HTTPException(404, "数据类型不存在")
        if not can_pick(permissions, data_type):
            raise HTTPException(403, f"没有查看{DATA_TYPES[data_type]['label']}的权限")
        return {"options": ref_options(app.state.store.engine, data_type, q)}

    @app.post("/data/{data_type}/records", status_code=201)
    def create_data_record(data_type: str, body: DataRecordInput, user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "create")
        record_id = create_record(app.state.store.engine, data_type, body.values, user["username"])
        return {"id": record_id}

    @app.patch("/data/{data_type}/records/{record_id}")
    def update_data_record(data_type: str, record_id: str, body: DataRecordInput, user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "update")
        update_record(app.state.store.engine, data_type, record_id, body.values, user["username"])
        return {"id": record_id}

    @app.delete("/data/{data_type}/records/{record_id}")
    def delete_data_record(data_type: str, record_id: str, user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "delete")
        delete_record(app.state.store.engine, data_type, record_id, user["username"])
        return {"id": record_id, "deleted": True}

    # AI 生成预览：只返回数据和校验结果，不写库；用户在页面上确认后调用下面的 batches 接口写入。
    # 每次生成都可能调用付费模型，按用户限制每分钟 10 次，防止被刷导致费用失控。
    @app.post("/data/{data_type}/generate")
    def generate_data(data_type: str, body: DataGenerateInput, user=Depends(current_user)):
        store = app.state.store
        permissions = user_permissions(store.engine, user)
        require(permissions, data_type, "create")
        count = store.cache.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
            1, f"rate:datagen:{user['username']}")
        if count > 10:
            raise HTTPException(429, "每分钟最多生成 10 次")
        return generate_preview(store.engine, app.state.models, data_type, body.count, body.prompt, user["username"])

    # 写入确认后的 AI 生成数据，同一次写入共用一个 batch_id，之后可以整批删除。
    @app.post("/data/{data_type}/batches", status_code=201)
    def create_data_batch(data_type: str, body: DataBatchInput, user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "create")
        return create_batch(app.state.store.engine, data_type, body.rows, user["username"])

    @app.delete("/data/{data_type}/batches/{batch_id}")
    def delete_data_batch(data_type: str, batch_id: str, user=Depends(current_user)):
        permissions = user_permissions(app.state.store.engine, user)
        require(permissions, data_type, "delete")
        return {"batch_id": batch_id, "deleted": delete_batch(app.state.store.engine, data_type, batch_id,
            user["username"])}

    # 数据权限矩阵（仅管理员）：每个部门对每种数据的查看、新增、修改、删除权限。
    @app.get("/admin/data-permissions")
    def get_data_permissions(admin=Depends(require_admin)):
        types = []
        for data_type, config in DATA_TYPES.items():
            types.append({"key": data_type, "label": config["label"]})
        return {"types": types, "permissions": permission_matrix(app.state.store.engine)}

    @app.put("/admin/data-permissions")
    def put_data_permission(body: DataPermissionInput, admin=Depends(require_admin)):
        with app.state.store.engine.connect() as connection:
            group = connection.execute(select(user_groups.c.id).where(user_groups.c.id == body.group_id)).first()
        if group is None:
            raise HTTPException(404, "部门不存在")
        values = save_permission(app.state.store.engine, body.group_id, body.data_type, {"read": body.read,
            "create": body.create, "update": body.update, "delete": body.delete})
        return {"group_id": body.group_id, "data_type": body.data_type, **values}

    # 同一会话串行处理；成功请求持久化后，同一 request_id 重放直接返回原结果。
    def process_chat(body, request, owner, on_step=None, on_token=None):
        store = app.state.store
        session_id, request_id = str(body.session_id), str(body.request_id)
        check_session(store, session_id, owner)
        with store.engine.connect() as connection:
            existing = connection.execute(select(runs).where(runs.c.id == request_id)).mappings().first()
        if existing:
            if (existing["owner"], existing["session_id"], existing["question"]) != (owner, session_id, body.question):
                raise HTTPException(409, "request_id 已用于其他请求")
            return existing["response"]

        # Lua 保证计数和过期一起执行，Redis 不可用时拒绝处理。
        count = store.cache.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
            1, f"rate:{owner}")
        if count > 30:
            raise HTTPException(429, "每分钟最多 30 次问答")
        lock = store.cache.lock(f"chat:{owner}:{session_id}", timeout=180, blocking_timeout=0)

        if not lock.acquire(blocking=False):
            raise HTTPException(409, "该会话正在回答，请稍后重试")

        try:
            # 获取锁后再次检查，避免并发重试重复生成。
            with store.engine.connect() as connection:
                existing = connection.execute(select(runs).where(runs.c.id == request_id)).mappings().first()
            if existing:
                if (existing["owner"], existing["session_id"], existing["question"]) != (owner, session_id, body.question):
                    raise HTTPException(409, "request_id 已用于其他请求")
                return existing["response"]
            previous = app.state.memory.history(store, session_id, owner)
            last_order = app.state.memory.last_order(store, owner, session_id, previous)
            # 记下已完成的阶段，处理失败时据此判断失败发生在哪一步。
            completed_steps = []
            started = time.monotonic()

            def track_step(step):
                completed_steps.append({"id": step["id"], "title": step.get("title"),
                    "duration_ms": step.get("duration_ms")})
                if on_step is not None:
                    on_step(step)

            try:
                result = app.state.agent.run(store, app.state.models, owner, session_id, body.question,
                    previous, last_order, on_step=track_step, on_token=on_token)
            except Exception as error:
                record_run_error(request, owner, session_id, request_id, body.question, error,
                    completed_steps, round((time.monotonic() - started) * 1000))
                raise
            result.update({"request_id": request_id, "trace_id": request.state.trace_id})
            if not lock.owned():
                raise HTTPException(409, "处理时间过长，请重试")
            with store.engine.begin() as connection:
                connection.execute(runs.insert().values(id=request_id, session_id=session_id,
                    owner=owner, question=body.question, response=result,
                    created=datetime.now(timezone.utc).isoformat(), **run_columns(summarize_run(result))))
            # 长期记忆在后台提取，不增加这次回答的等待时间；提取失败只记日志。
            try:
                app.state.agent.response_agent.memory.long_term.schedule(owner, session_id, request_id, body.question, result)
            except Exception:
                logger.warning("long_memory_schedule_failed trace_id=%s", request.state.trace_id, exc_info=True)
            return result
        finally:
            # 解锁失败不覆盖已经提交的成功结果，锁会自动过期。
            try:
                if lock.owned():
                    lock.release()
            except Exception:
                logger.warning("lock_release_failed trace_id=%s", request.state.trace_id)

    # 记录一次失败的问答。错误详情只写入数据库供排查，不返回给客户端；记录本身失败不影响原来的错误响应。
    def record_run_error(request, owner, session_id, request_id, question, error, steps, duration_ms):
        status_code = error.status_code if isinstance(error, HTTPException) else 503
        detail = error.detail if isinstance(error, HTTPException) else f"{type(error).__name__}: {error}"
        try:
            with app.state.store.engine.begin() as connection:
                connection.execute(run_errors.insert().values(id=str(uuid4()), request_id=request_id,
                    session_id=session_id, owner=owner, question=question, status_code=status_code,
                    error=str(detail)[:500], last_step=steps[-1]["id"] if steps else None, steps=steps,
                    duration_ms=duration_ms, created=datetime.now(timezone.utc).isoformat()))
        except Exception:
            logger.exception("run_error_record_failed trace_id=%s", request.state.trace_id)

    @app.post("/chat")
    def chat(body: ChatInput, request: Request, owner=Depends(identity)):
        return process_chat(body, request, owner)

    # 通过 SSE 推送后端真实阶段和回答的逐段文字，前端可以在模型调用期间展示实际进度和已生成的内容。
    @app.post("/chat/stream")
    def chat_stream(body: ChatInput, request: Request, owner=Depends(identity)):
        events = Queue()

        def run():
            try:
                # 原来只推送阶段，回答要等 complete 才整段出现；现在额外推送 token 事件，前端可以逐字显示。
                result = process_chat(body, request, owner, on_step=lambda step: events.put(("step", step)),
                    on_token=lambda text: events.put(("token", {"text": text})))
                events.put(("complete", result))
            except Exception as error:
                if not isinstance(error, HTTPException):
                    logger.exception("chat_stream_failed")
                detail = error.detail if isinstance(error, HTTPException) else dependency_error_message(error)
                events.put(("error", {"detail": detail,
                    "status_code": getattr(error, "status_code", 500)}))

        Thread(target=run, daemon=True).start()

        def stream():
            yield "event: started\ndata: {}\n\n"
            while True:
                # 某个阶段（重排模型冷启动、大模型生成、充分性判断）可能几十秒没有任何输出，
                # nginx 默认 60 秒读不到数据就断开，浏览器只报 network error。每 15 秒发一行 SSE 注释保持连接，前端会忽略它。
                try:
                    event, payload = events.get(timeout=15)
                except Empty:
                    yield ": ping\n\n"
                    continue
                body_text = json.dumps(payload, ensure_ascii=False)
                yield f"event: {event}\ndata: {body_text}\n\n"
                if event in {"complete", "error"}:
                    break

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })

    # 评测相关接口只允许管理员调用：评测会导入语料、调用模型、修改项目评测集，普通用户不应看到或操作。
    # 评测集浏览：全部题目、题型和语料文档名。评测数据属于项目本身而不是某个用户。
    @app.get("/eval/dataset", dependencies=[Depends(require_admin)])
    def eval_dataset(owner=Depends(identity)):
        corpus = []
        for path in corpus_files():
            corpus.append(path.stem)
        items = load_dataset()
        reviewed_count = len(select_split(items, "all"))
        return {"items": items, "types": QUESTION_TYPES, "corpus": corpus,
            "reviewed_count": reviewed_count, "pending_count": len(items) - reviewed_count}

    # 证据原文所在的分片（评测语料当前的分片里现查，不存分片 id），本地向量模型时附带截断位置。
    @app.post("/eval/evidence", dependencies=[Depends(require_admin)])
    def eval_evidence(body: EvalEvidenceInput):
        texts = [text.strip()[:1000] for text in body.texts if text.strip()]
        return locate_evidence(app.state.store, app.state.models, texts)

    # 手动新增评测题：先验证题型、证据和语料一致性，再追加到项目评测集。
    @app.post("/eval/dataset/items", status_code=201, dependencies=[Depends(require_admin)])
    def add_eval_dataset_item(body: EvalDatasetItemInput, owner=Depends(identity)):
        if body.type not in QUESTION_TYPES:
            raise HTTPException(422, f"未知题型：{body.type}")
        if body.type == "多轮追问" and not body.history:
            raise HTTPException(422, "多轮追问题必须填写追问历史")
        with app.state.eval_dataset_lock:
            existing = load_dataset()
            evidence = [text.strip() for text in body.evidence if text.strip()]
            item = body.model_dump()
            item["id"] = next_item_id(existing, body.answerable)
            item["evidence"] = evidence
            item["origin"] = "manual"
            item["reviewed"] = True
            problems = validate_dataset(existing + [item], corpus_text())
            if problems:
                raise HTTPException(422, problems)
            append_items([item])
        return item

    # 同义改写题在编辑器里一次填写两个问法，但落盘为两条独立题目，检索评测仍逐题执行。
    @app.post("/eval/dataset/pairs", status_code=201, dependencies=[Depends(require_admin)])
    def add_eval_dataset_pair(body: EvalDatasetPairInput, owner=Depends(identity)):
        with app.state.eval_dataset_lock:
            existing = load_dataset()
            evidence = [text.strip() for text in body.evidence if text.strip()]
            pair_id = next_pair_id(existing)
            base = body.model_dump()
            base.pop("original_question")
            base.pop("paraphrase_question")
            items = []
            for question, role in ((body.original_question, "original"), (body.paraphrase_question, "paraphrase")):
                item = dict(base)
                item.update({
                    "id": next_item_id(existing + items, body.answerable),
                    "question": question,
                    "type": "同义改写",
                    "evidence": evidence,
                    "pair_id": pair_id,
                    "pair_role": role,
                    "origin": "manual",
                    "reviewed": True,
                })
                items.append(item)
            problems = validate_dataset(existing + items, corpus_text())
            if problems:
                raise HTTPException(422, problems)
            append_items(items)
        return {"pair_id": pair_id, "items": items}

    # 审核通过一道题后持久化 reviewed 状态，只有审核后的题目才会被实际评测读取。
    @app.post("/eval/dataset/items/{item_id}/review", dependencies=[Depends(require_admin)])
    def review_eval_dataset_item(item_id: str, owner=Depends(identity)):
        with app.state.eval_dataset_lock:
            item = mark_reviewed(item_id)
        if item is None:
            raise HTTPException(404, "评测题目不存在")
        return item

    # AI 起草评测题：只允许真实大模型，生成后立即做同样的证据校验并标记为待人工审核。
    @app.post("/eval/dataset/generate", status_code=201, dependencies=[Depends(require_admin)])
    def generate_eval_dataset_items(body: EvalDatasetGenerateInput, owner=Depends(identity)):
        if app.state.models.mode != "openai":
            raise HTTPException(422, "AI 生成题目需要真实大模型：请设置 MODEL_MODE=openai 和 LLM_API_KEY")
        if body.type and body.type not in QUESTION_TYPES:
            raise HTTPException(422, f"未知题型：{body.type}")
        with app.state.eval_dataset_lock:
            existing = load_dataset()
            try:
                items = generate_items(app.state.models, existing, body.count, body.split, body.type)
            except ValueError as error:
                raise HTTPException(422, str(error))
            except Exception:
                logger.exception("eval_dataset_generation_failed")
                raise HTTPException(502, "AI 生成题目失败，请稍后重试")
            append_items(items)
        return {"items": items}

    # 历次评测列表（不含逐题明细）以及可选的实验组。
    # 文件里仍是 running、但不是本进程正在跑的评测，说明进程中途退出，标记为已中断，避免界面一直显示运行中。
    @app.get("/eval/runs", dependencies=[Depends(require_admin)])
    def eval_runs(owner=Depends(identity)):
        runs = list_runs()
        for run in runs:
            if run["status"] == "running" and run["id"] != app.state.eval_running:
                run["status"] = "interrupted"
        suites = []
        for key, label in SUITES.items():
            variants = []
            for name, variant in VARIANTS.items():
                if variant["suite"] == key:
                    variants.append(variant["label"])
            suites.append({"key": key, "label": label, "variants": variants})
        return {"runs": runs, "running": app.state.eval_running, "suites": suites}

    # 单次评测的完整结果，附带上一次同类评测的编号，前端据此默认展示对比。
    @app.get("/eval/runs/{run_id}", dependencies=[Depends(require_admin)])
    def eval_run(run_id: str, owner=Depends(identity)):
        try:
            run = load_run(run_id)
        except ValueError:
            raise HTTPException(404, "评测不存在")
        if run is None:
            raise HTTPException(404, "评测不存在")
        if run["status"] == "running" and run["id"] != app.state.eval_running:
            run["status"] = "interrupted"
        runs = list_runs()
        if run.get("kind") == "special":
            special_suites.attach_previous(run, runs)
            run["previous_id"] = None
            return run
        base = previous_run(run, runs)
        run["previous_id"] = base["id"] if base else None
        return run

    # 删除单条已落盘评测记录；运行中的记录仍在持续写入，必须等它结束后才能删除。
    @app.delete("/eval/runs/{run_id}", dependencies=[Depends(require_admin)])
    def remove_eval_run(run_id: str, owner=Depends(identity)):
        if app.state.eval_running == run_id:
            raise HTTPException(409, "评测正在运行，不能删除")
        try:
            deleted = delete_run(run_id)
        except ValueError:
            raise HTTPException(404, "评测不存在")
        if not deleted:
            raise HTTPException(404, "评测不存在")
        return {"id": run_id, "deleted": True}

    # 比较任意两次评测的整体指标。
    @app.get("/eval/compare", dependencies=[Depends(require_admin)])
    def eval_compare(base: str, target: str, owner=Depends(identity)):
        try:
            base_run = load_run(base)
            target_run = load_run(target)
        except ValueError:
            raise HTTPException(404, "评测不存在")
        if base_run is None or target_run is None:
            raise HTTPException(404, "评测不存在")
        return compare_runs(base_run, target_run)

    # 界面上发起一次评测，在后台线程执行并立即返回编号，前端轮询进度。
    @app.post("/eval/runs", status_code=202, dependencies=[Depends(require_admin)])
    def create_eval_run(body: EvalRunInput, owner=Depends(identity)):
        for suite in body.suites:
            if suite not in SUITES:
                raise HTTPException(422, f"未知实验组：{suite}")
        special = None
        if body.kind == "special":
            # 专项评测：每个专项按自己的评测方式跑；回答和多轮对话要生成和评审，需要真实大模型。
            try:
                loaded = special_suites.load_for_run(app.state.store.engine, body.suite_ids)
            except ValueError as error:
                raise HTTPException(422, str(error))
            needs_llm = [suite["name"] for suite in loaded if suite["method"] in special_suites.LLM_METHODS]
            if needs_llm and app.state.models.mode != "openai":
                raise HTTPException(422, f"「{'」「'.join(needs_llm)}」需要真实大模型：请设置 MODEL_MODE=openai 和 LLM_API_KEY")
            special = {"suites": [{"id": suite["id"], "name": suite["name"]} for suite in loaded],
                "compare_memory": body.compare_memory}
            needs_responder = any(suite["method"] == "answer" for suite in loaded)
        else:
            needs_responder = body.kind == "generation"
            if body.kind == "generation" and app.state.models.mode != "openai":
                raise HTTPException(422, "生成评测需要真实大模型：请设置 MODEL_MODE=openai 和 LLM_API_KEY")
            if body.kind == "generation" and body.suites:
                raise HTTPException(422, "生成评测只运行基线，消融实验和参数对比请切换为检索评测")
            # 启动前检查审核后的题目，避免所有题目都在待审核时创建一个必然失败的空评测。
            if not select_split(load_dataset(), body.split):
                raise HTTPException(422, "当前题目范围没有已审核题目，请先审核评测题")
        if not app.state.eval_lock.acquire(blocking=False):
            raise HTTPException(409, "已有评测正在运行，请等待完成")
        try:
            run = start_run(body.kind, None if special else body.split, body.suites, special)
        except Exception:
            app.state.eval_lock.release()
            raise
        app.state.eval_running = run["id"]

        def work():
            responder = None
            try:
                if needs_responder:
                    # 生成评测只验证回答质量，不应把评测题写进线上会话的持久化记忆，回答 Agent 用进程内记忆。
                    responder = ResponseAgent(app.state.models, use_postgres=False)
                execute_run(app.state.store, app.state.models, [] if special else load_dataset(), run,
                    generate=body.kind == "generation", responder=responder)
            except Exception:
                logger.exception("eval_run_failed run_id=%s", run["id"])
            finally:
                if responder is not None:
                    responder.close()
                app.state.eval_running = None
                app.state.eval_lock.release()

        Thread(target=work, daemon=True).start()
        return {"id": run["id"], "status": "running"}

    # 专项评测集：管理员自建，每个专项针对一个方向，题目在评测语料上跑，不计入调参分数。
    def suite_or_404(result):
        if result is None:
            raise HTTPException(404, "专项不存在")
        return result

    @app.get("/eval/suites", dependencies=[Depends(require_admin)])
    def eval_suites_list():
        return special_suites.list_suites(app.state.store.engine)

    @app.post("/eval/suites", status_code=201)
    def eval_suite_create(body: EvalSuiteInput, admin=Depends(require_admin)):
        try:
            return special_suites.create_suite(app.state.store.engine, body.name, body.description, body.method,
                admin["username"], body.search_mode)
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.get("/eval/suites/{suite_id}", dependencies=[Depends(require_admin)])
    def eval_suite_get(suite_id: str):
        return suite_or_404(special_suites.get_suite(app.state.store.engine, suite_id))

    @app.put("/eval/suites/{suite_id}", dependencies=[Depends(require_admin)])
    def eval_suite_update(suite_id: str, body: EvalSuiteInput):
        try:
            return suite_or_404(special_suites.update_suite(app.state.store.engine, suite_id, body.name,
                body.description, body.method, body.search_mode))
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.delete("/eval/suites/{suite_id}", dependencies=[Depends(require_admin)])
    def eval_suite_delete(suite_id: str):
        if not special_suites.delete_suite(app.state.store.engine, suite_id):
            raise HTTPException(404, "专项不存在")
        return {"id": suite_id, "deleted": True}

    @app.post("/eval/suites/{suite_id}/items", status_code=201)
    def eval_suite_item_add(suite_id: str, body: EvalSuiteItemInput, admin=Depends(require_admin)):
        try:
            return suite_or_404(special_suites.add_item(app.state.store.engine, suite_id, body.model_dump(),
                admin["username"]))
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.put("/eval/suites/{suite_id}/items/{item_id}", dependencies=[Depends(require_admin)])
    def eval_suite_item_update(suite_id: str, item_id: str, body: EvalSuiteItemInput):
        try:
            result = special_suites.update_item(app.state.store.engine, suite_id, item_id, body.model_dump())
        except ValueError as error:
            raise HTTPException(422, str(error))
        if result is None:
            raise HTTPException(404, "题目不存在")
        return result

    @app.delete("/eval/suites/{suite_id}/items/{item_id}", dependencies=[Depends(require_admin)])
    def eval_suite_item_delete(suite_id: str, item_id: str):
        result = special_suites.delete_item(app.state.store.engine, suite_id, item_id)
        if result is None:
            raise HTTPException(404, "题目不存在")
        return result

    # 巡检复测集（代码里仍叫 regression / eval_sets）：题目是真实用户的提问，按提问人的权限在线上知识库里跑，只允许管理员调用。
    @app.get("/eval/sets", dependencies=[Depends(require_admin)])
    def eval_sets_list():
        return regression.list_sets(app.state.store)

    @app.post("/eval/sets", status_code=201)
    def eval_set_create(body: EvalSetInput, admin=Depends(require_admin)):
        try:
            return regression.create_set(app.state.store, body.name, body.description, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.get("/eval/sets/{set_id}", dependencies=[Depends(require_admin)])
    def eval_set_get(set_id: str):
        result = regression.get_set(app.state.store, set_id)
        if result is None:
            raise HTTPException(404, "评测集不存在")
        return result

    @app.patch("/eval/sets/{set_id}", dependencies=[Depends(require_admin)])
    def eval_set_update(set_id: str, body: EvalSetInput):
        try:
            result = regression.update_set(app.state.store, set_id, body.name, body.description)
        except ValueError as error:
            raise HTTPException(422, str(error))
        if result is None:
            raise HTTPException(404, "评测集不存在")
        return result

    @app.delete("/eval/sets/{set_id}", status_code=204, dependencies=[Depends(require_admin)])
    def eval_set_delete(set_id: str):
        if not regression.delete_set(app.state.store, set_id):
            raise HTTPException(404, "评测集不存在")

    @app.post("/eval/sets/{set_id}/items", status_code=201)
    def eval_set_items_add(set_id: str, body: EvalSetItemsInput, admin=Depends(require_admin)):
        try:
            added = regression.add_items(app.state.store, set_id, [item.model_dump() for item in body.items], admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        if added is None:
            raise HTTPException(404, "评测集不存在")
        return {"items": added}

    @app.put("/eval/sets/{set_id}/items/{item_id}", dependencies=[Depends(require_admin)])
    def eval_set_item_update(set_id: str, item_id: str, body: EvalSetItemInput):
        try:
            item = regression.update_item(app.state.store, set_id, item_id, body.model_dump())
        except ValueError as error:
            raise HTTPException(422, str(error))
        if item is None:
            raise HTTPException(404, "题目不存在")
        return item

    # 编辑题目时选择期望命中的文档。
    @app.get("/eval/documents", dependencies=[Depends(require_admin)])
    def eval_document_options():
        return {"documents": regression.document_options(app.state.store)}

    @app.delete("/eval/sets/{set_id}/items/{item_id}", status_code=204, dependencies=[Depends(require_admin)])
    def eval_set_item_delete(set_id: str, item_id: str):
        if not regression.delete_item(app.state.store, set_id, item_id):
            raise HTTPException(404, "题目不存在")

    # 运行巡检复测集：后台线程逐题执行，前端轮询评测集详情里的运行状态。
    @app.post("/eval/sets/{set_id}/runs", status_code=202)
    def eval_set_run(set_id: str, body: EvalSetRunInput, admin=Depends(require_admin)):
        try:
            run_id = regression.start_run(app.state.store, set_id, body.kind, admin["username"])
        except ValueError as error:
            raise HTTPException(409 if "正在运行" in str(error) else 422, str(error))
        if run_id is None:
            raise HTTPException(404, "评测集不存在")
        thread = Thread(target=regression.execute_run, args=(app.state.store, app.state.models, run_id), daemon=True)
        app.state.regression_threads[run_id] = thread
        thread.start()
        return {"id": run_id, "status": "running"}

    @app.get("/eval/sets/{set_id}/runs/{run_id}", dependencies=[Depends(require_admin)])
    def eval_set_run_get(set_id: str, run_id: str):
        result = regression.get_run(app.state.store, set_id, run_id)
        if result is None:
            raise HTTPException(404, "运行记录不存在")
        return result

    # 界面配色（蓝调 / 绿调）：所有页面启动时读取，登录页也要用，所以不需要登录。只返回这一项。
    @app.get("/settings/ui")
    def ui_settings():
        return {"theme": runtime_config.value("ui_theme")}

    # 设置页「RAG 配置」（检索、回答流程、对话记忆、知识巡检、模型服务）和「系统配置」（通用）共用这两个接口。
    # 返回每一项的当前值、来源（设置页 / .env / 默认）、默认值和允许范围，以及最近的修改记录。
    @app.get("/settings/runtime", dependencies=[Depends(require_admin)])
    def runtime_settings_get():
        return runtime_config.view(app.state.store.engine)

    # 保存修改：changes 里值为 null 表示恢复默认（回到 .env 或代码默认值）。不合规整批不保存。
    @app.put("/settings/runtime")
    def runtime_settings_save(body: RuntimeSettingsInput, admin=Depends(require_admin)):
        try:
            changed = runtime_config.save(app.state.store.engine, body.changes, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        result = runtime_config.view(app.state.store.engine)
        result["changed"] = changed
        return result

    # 提示词管理（只有管理员）：查看线上问答和文档导入用到的提示词，保存新版本、回滚到旧版本。
    @app.get("/prompts", dependencies=[Depends(require_admin)])
    def prompt_list():
        return prompts.view(app.state.store.engine)

    @app.get("/prompts/{prompt_id}", dependencies=[Depends(require_admin)])
    def prompt_detail(prompt_id: str):
        result = prompts.detail(app.state.store.engine, prompt_id)
        if result is None:
            raise HTTPException(404, "没有这个提示词")
        return result

    @app.post("/prompts/{prompt_id}/versions")
    def prompt_save(prompt_id: str, body: PromptVersionInput, admin=Depends(require_admin)):
        if prompt_id not in prompts.BY_ID:
            raise HTTPException(404, "没有这个提示词")
        try:
            prompts.save(app.state.store.engine, prompt_id, body.text, body.note, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        return prompts.detail(app.state.store.engine, prompt_id)

    @app.post("/prompts/{prompt_id}/activate")
    def prompt_activate(prompt_id: str, body: PromptActivateInput, admin=Depends(require_admin)):
        if prompt_id not in prompts.BY_ID:
            raise HTTPException(404, "没有这个提示词")
        try:
            prompts.activate(app.state.store.engine, prompt_id, body.version, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        return prompts.detail(app.state.store.engine, prompt_id)

    # 知识巡检：问题里有其他用户的提问和反馈，所有接口只允许管理员调用。
    @app.get("/inspection/issues", dependencies=[Depends(require_admin)])
    def inspection_issues_list(status: str | None = Query(None), kind: str | None = Query(None),
                               reason: str | None = Query(None), diagnosis: str | None = Query(None),
                               page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        if status is not None and status not in INSPECTION_STATUSES:
            raise HTTPException(422, f"未知状态：{status}")
        if kind is not None and kind not in INSPECTION_KINDS:
            raise HTTPException(422, f"未知问题类型：{kind}")
        if reason is not None and reason != "none" and reason not in CLOSE_REASONS:
            raise HTTPException(422, f"未知原因：{reason}")
        if diagnosis is not None and diagnosis != "none" and diagnosis not in DIAGNOSIS_CATEGORIES:
            raise HTTPException(422, f"未知诊断结论：{diagnosis}")
        result = list_issues(app.state.store, status, kind, page, page_size, reason=reason,
            days=load_schedule(app.state.store)["days"], diagnosis=diagnosis)
        result["running"] = bool(app.state.store.cache.get(INSPECTION_LOCK))
        return result

    @app.get("/inspection/issues/{issue_id}", dependencies=[Depends(require_admin)])
    def inspection_issue_detail(issue_id: str):
        issue = get_issue(app.state.store, issue_id)
        if issue is None:
            raise HTTPException(404, "问题不存在")
        return issue

    @app.patch("/inspection/issues/{issue_id}")
    def inspection_issue_update(issue_id: str, body: InspectionIssueInput, admin=Depends(require_admin)):
        if body.status is not None and body.status not in MANUAL_STATUSES:
            raise HTTPException(422, "只能标记为待处理、已处理或无需处理")
        try:
            issue = update_issue(app.state.store, issue_id, body.status, body.note, admin["username"], body.close_reason, body.fix_type)
        except ValueError as error:
            raise HTTPException(422, str(error))
        if issue is None:
            raise HTTPException(404, "问题不存在")
        return issue

    @app.get("/inspection/schedule", dependencies=[Depends(require_admin)])
    def inspection_schedule_get():
        return schedule_view(app.state.store)

    # 保存后由 worker 按新设置执行，不用重启；下一次执行时间从保存时刻算起。
    @app.put("/inspection/schedule")
    def inspection_schedule_put(body: InspectionScheduleInput, admin=Depends(require_admin)):
        try:
            save_schedule(app.state.store, body.model_dump(), admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        return schedule_view(app.state.store)

    # 立即重新检索一个知识缺口：按提问人现在的权限重跑检索，规则和巡检时相同（能检索到就关闭，已处理但仍检索不到就重新打开）。
    # 只检索不生成回答，几秒内完成，所以同步返回结果。
    @app.post("/inspection/issues/{issue_id}/verify")
    def inspection_issue_verify(issue_id: str, admin=Depends(require_admin)):
        try:
            issue = verify_issue(app.state.store, app.state.models, issue_id, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        if issue is None:
            raise HTTPException(404, "问题不存在")
        return issue

    # 关联记录上的"重新提问"：以提问人的身份把这条问题完整再问一遍，同步返回新回答（要调用大模型，可能十几秒）。
    @app.post("/inspection/issues/{issue_id}/events/{source}/{source_id}/replay")
    def inspection_event_replay(issue_id: str, source: Literal["run", "error"], source_id: str, admin=Depends(require_admin)):
        try:
            entry = replay_event(app.state.store, app.state.models, issue_id, source, source_id, admin["username"])
        except ValueError as error:
            raise HTTPException(422, str(error))
        if entry is None:
            raise HTTPException(404, "记录不存在")
        return entry

    # 把巡检问题加入巡检复测集前的预填内容：几种问法、提问人、期望结果和期望命中的文档。
    @app.get("/inspection/issues/{issue_id}/eval-candidates", dependencies=[Depends(require_admin)])
    def inspection_issue_eval_candidates(issue_id: str):
        result = regression.issue_candidates(app.state.store, issue_id)
        if result is None:
            raise HTTPException(404, "问题不存在")
        return result

    # 运行概览：近 N 天按天汇总的问答量、失败、拒答、耗时、Token 和反馈，只有管理员能看。
    @app.get("/overview", dependencies=[Depends(require_admin)])
    def get_overview(days: int = Query(7)):
        if days not in OVERVIEW_RANGES:
            raise HTTPException(422, "只能查看近 7、30 或 90 天")
        return build_overview(app.state.store.engine, days)

    @app.get("/inspection/runs", dependencies=[Depends(require_admin)])
    def inspection_runs_list():
        return {"runs": list_inspection_runs(app.state.store),
            "running": bool(app.state.store.cache.get(INSPECTION_LOCK))}

    # 立即巡检：在后台线程执行，前端轮询问题列表的 running 字段等待完成。
    @app.post("/inspection/runs", status_code=202)
    def inspection_run_start(body: InspectionRunInput | None = None, admin=Depends(require_admin)):
        if app.state.store.cache.get(INSPECTION_LOCK):
            raise HTTPException(409, "已有巡检正在运行，请稍后再试")
        run_id = str(uuid4())
        # 没有单独指定时，扫描范围和定时巡检的设置保持一致。
        days = body.days if body and body.days else load_schedule(app.state.store)["days"]

        def work():
            try:
                run_inspection(app.state.store, app.state.models, trigger="api", triggered_by=admin["username"],
                    days=days, run_id=run_id)
            except InspectionBusy:
                logger.warning("inspection_busy run_id=%s", run_id)
            except Exception:
                logger.exception("inspection_run_failed run_id=%s", run_id)

        thread = Thread(target=work, daemon=True)
        app.state.inspection_thread = thread
        thread.start()
        return {"id": run_id, "status": "running"}

    return app


app = create_app()
