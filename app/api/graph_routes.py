"""知识图谱的接口（第 1 期）：建图、预估、补跑，文档页签和全局页面读取的数据。

identity、require_admin 定义在 main.py，这里由 create_app 传进来，避免循环导入。
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import prompts
from ..graph import build as graph_build
from ..graph import query as graph_query
from ..graph.extract import PROMPT_ID, build_messages
from ..graph.schemas import DEFAULT_SCHEMA_ID, MATCHING_RULES, get_schema, list_schemas
from ..mysql.tables import documents


class LLMChoice(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    model: str | None = Field(None, max_length=128)


class BuildInput(BaseModel):
    schema_id: str | None = Field(None, max_length=36)
    llm: LLMChoice | None = None


class BatchBuildInput(BuildInput):
    document_ids: list[UUID] = Field(min_length=1, max_length=200)


class RetryInput(BaseModel):
    chunk_id: str | None = Field(None, max_length=64)


EXAMPLE_CHUNK = {
    "content": "2011 年，阿段买入了苹果公司的股票，他认为苹果有很强的护城河……",
    "document_title": "段永平投资问答录",
    "heading_path": ["投资", "苹果"],
    "context": "这段讲段永平 2011 年开始买入苹果股票的经过。",
}


def build_router(current_user, identity, require_admin):
    router = APIRouter()

    def readable(request_state, username, document_id):
        row = request_state.store.readable_document(username, str(document_id))
        if row is None:
            raise HTTPException(404, "文档不存在")
        return row

    # 建图要调用模型、会花钱：只有上传者和管理员可以。
    def check_can_build(user, row):
        if row["owner"] != user["username"] and not user["is_admin"]:
            raise HTTPException(403, "只有上传者和管理员可以建图")

    def choice_dict(choice):
        return choice.model_dump() if choice else None

    def start(state, user, document_id, body, trigger):
        try:
            return graph_build.start_build(
                state.store,
                state.models,
                str(document_id),
                body.schema_id,
                choice_dict(body.llm),
                trigger=trigger,
                user=user["username"],
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    # 清单列表，以及页面「如何匹配」要看的：规范化和合并规则、抽取提示词（拼好的系统提示词和一条示例用户消息）。
    @router.get("/graph/schemas")
    def schemas(request: Request, username=Depends(identity)):
        state = request.app.state
        default = get_schema(state.store.engine, DEFAULT_SCHEMA_ID)
        example = build_messages(default, EXAMPLE_CHUNK)
        return {
            "schemas": list_schemas(state.store.engine),
            "default_id": DEFAULT_SCHEMA_ID,
            "matching": MATCHING_RULES,
            "prompt": {
                "id": PROMPT_ID,
                "tag": prompts.tag(PROMPT_ID),
                "system": example[0]["content"],
                "example_user": example[1]["content"],
            },
            "model_mode": state.models.mode,
        }

    @router.get("/documents/{document_id}/graph/estimate")
    def estimate(
        request: Request,
        document_id: UUID,
        schema_id: str | None = Query(None, max_length=36),
        provider: str | None = Query(None, max_length=32),
        model: str | None = Query(None, max_length=128),
        username=Depends(identity),
    ):
        state = request.app.state
        readable(state, username, document_id)
        choice = {"provider": provider, "model": model} if provider else None
        try:
            return graph_build.estimate(
                state.store, state.models, str(document_id), schema_id, choice
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    @router.post("/documents/{document_id}/graph", status_code=202)
    def build_document(
        request: Request,
        document_id: UUID,
        body: BuildInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        return start(state, user, document_id, body, "manual")

    # 批量建图：逐份开始，不能建的（没权限、没处理完、正在建）列在 skipped 里说明原因。
    @router.post("/graph/builds", status_code=202)
    def build_batch(
        request: Request, body: BatchBuildInput, user=Depends(current_user)
    ):
        state = request.app.state
        started = []
        skipped = []
        for document_id in dict.fromkeys(body.document_ids):
            row = state.store.readable_document(user["username"], str(document_id))
            title = row["title"] if row else None
            if row is None:
                skipped.append(
                    {
                        "document_id": str(document_id),
                        "title": title,
                        "reason": "文档不存在",
                    }
                )
                continue
            if row["owner"] != user["username"] and not user["is_admin"]:
                skipped.append(
                    {
                        "document_id": str(document_id),
                        "title": title,
                        "reason": "只有上传者和管理员可以建图",
                    }
                )
                continue
            try:
                started.append(
                    graph_build.start_build(
                        state.store,
                        state.models,
                        str(document_id),
                        body.schema_id,
                        choice_dict(body.llm),
                        trigger="batch",
                        user=user["username"],
                    )
                )
            except graph_build.BuildError as error:
                skipped.append(
                    {
                        "document_id": str(document_id),
                        "title": title,
                        "reason": str(error),
                    }
                )
        return {"started": started, "skipped": skipped}

    @router.post("/documents/{document_id}/graph/retry", status_code=202)
    def retry(
        request: Request,
        document_id: UUID,
        body: RetryInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            build = graph_query.latest_build(connection, str(document_id))
        if build is None:
            raise HTTPException(409, "这份文档还没有建过图")
        try:
            return graph_build.retry(state.store, build["id"], body.chunk_id)
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    # 文档详情「实体关系」页签。view：network 图、entities 实体表、relations 关系表、merges 合并记录。
    @router.get("/documents/{document_id}/graph")
    def document_graph(
        request: Request,
        document_id: UUID,
        view: str = Query(
            "network", pattern="^(network|entities|relations|merges|summary)$"
        ),
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
        q: str | None = Query(None, max_length=100),
        entity_type: str | None = Query(None, alias="type", max_length=32),
        category: str | None = Query(None, max_length=32),
        focus: str | None = Query(None, max_length=2000),
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        result = graph_query.document_graph(
            state.store.engine,
            str(document_id),
            view,
            page,
            page_size,
            q or None,
            entity_type or None,
            category or None,
            [item for item in (focus or "").split(",") if item],
        )
        result["can_build"] = row["owner"] == user["username"] or bool(user["is_admin"])
        result["processed"] = graph_build.is_processed(row["status"])
        result["settings"] = (row["document_metadata"] or {}).get("graph")
        return result

    # 实体详情。带 document_id 时只看这份文档里的（读得到这份文档就行）；不带时看全局，只有管理员可以。
    @router.get("/graph/entities/{entity_id}")
    def entity_detail(
        request: Request,
        entity_id: str,
        document_id: UUID | None = Query(None),
        user=Depends(current_user),
    ):
        state = request.app.state
        if document_id:
            readable(state, user["username"], document_id)
        elif not user["is_admin"]:
            raise HTTPException(403, "需要管理员权限")
        result = graph_query.entity_detail(
            state.store.engine, entity_id, str(document_id) if document_id else None
        )
        if result is None:
            raise HTTPException(404, "实体不存在")
        return result

    @router.get("/graph/overview")
    def overview(
        request: Request,
        document_id: UUID | None = Query(None),
        entity_type: str | None = Query(None, alias="type", max_length=32),
        category: str | None = Query(None, max_length=32),
        q: str | None = Query(None, max_length=100),
        focus: str | None = Query(None, max_length=2000),
        limit: int = Query(graph_query.NETWORK_LIMIT, ge=5, le=300),
        admin=Depends(require_admin),
    ):
        return graph_query.overview(
            request.app.state.store.engine,
            str(document_id) if document_id else None,
            entity_type or None,
            category or None,
            [item for item in (focus or "").split(",") if item],
            q or None,
            limit,
        )

    @router.get("/graph/tasks")
    def tasks(request: Request, admin=Depends(require_admin)):
        return {"items": graph_query.tasks(request.app.state.store.engine)}

    return router


# 上传时的图检索选项：graph=on 时检查清单和模型，记进文档 metadata；没传 graph 而且是新版本时沿用上一版的设置。
def upload_settings(store, models, graph, schema_id, provider, model, doc_key):
    if graph == "off":
        return None
    if graph == "on":
        schema = get_schema(store.engine, schema_id or DEFAULT_SCHEMA_ID)
        if schema is None:
            raise HTTPException(422, "清单不存在")
        try:
            llm, _ = graph_build.resolve_llm(
                store,
                models,
                {"provider": provider, "model": model} if provider else None,
            )
        except graph_build.BuildError as error:
            raise HTTPException(422, str(error)) from None
        return {
            "enabled": True,
            "schema_id": schema["id"],
            "provider": llm["provider"],
            "model": llm["model"],
            "trigger": "version" if doc_key else "upload",
        }
    if graph is None and doc_key:
        from ..mysql.tables import document_heads

        with store.engine.connect() as connection:
            row = connection.execute(
                select(documents.c.document_metadata)
                .select_from(
                    document_heads.join(
                        documents,
                        documents.c.id == document_heads.c.current_document_id,
                    )
                )
                .where(document_heads.c.doc_key == doc_key)
            ).first()
        previous = ((row[0] if row else None) or {}).get("graph") or {}
        if previous.get("enabled"):
            return {**previous, "trigger": "version"}
    return None
