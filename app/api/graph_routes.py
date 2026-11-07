"""知识图谱的接口（第 1 期）：建图、预估、补跑，文档页签和全局页面读取的数据。

identity、require_admin 定义在 main.py，这里由 create_app 传进来，避免循环导入。
"""

from typing import Literal

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import prompts
from ..graph import build as graph_build
from ..graph import checks as graph_checks
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
    # 重试哪一次建图：处理流程里失败的那一步、分片卡片上的结果都带着自己的建图 id。
    # 不传时（旧页面）补最近一次。
    build_id: UUID | None = None


class ReviewChoice(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=100)


class ReviewRewriteInput(BaseModel):
    build_id: UUID
    # 连在一起的建议名字不一致时，人工选的最终名字和类型；键是组内最小的建议编号。
    resolutions: dict[str, ReviewChoice] = Field(default_factory=dict)


class ReviewManualInput(BaseModel):
    build_id: UUID
    ids: list[str] = Field(min_length=2, max_length=50)
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=100)
    reason: str = Field(default="", max_length=1000)


class ReviewDecideInput(BaseModel):
    build_id: UUID
    proposal_ids: list[str] = Field(min_length=1, max_length=10000)
    # approved 批准、rejected 否决、null 撤销
    decision: Literal["approved", "rejected"] | None = None


class StopInput(BaseModel):
    build_id: UUID


class VersionNoteInput(BaseModel):
    note: str = Field("", max_length=500)


CheckStep = Literal["glean", "relation", "type", "split"]


class CheckInput(BaseModel):
    build_id: UUID


class CheckStartInput(BaseModel):
    build_id: UUID
    # scope：补抽范围（few 抽出很少的分片 / all 全部）；sample：关系核对另外抽查通过的百分比；
    # llm：检查用的模型 {provider, model}，不传用建图时的模型。
    params: dict = Field(default_factory=dict)


class CheckDecideInput(BaseModel):
    build_id: UUID
    item_ids: list[str] = Field(min_length=1, max_length=10000)
    # accept 采纳建议、reject 不采纳、null 撤销
    decision: Literal["accept", "reject"] | None = None
    # 改了模型的建议：类型核对 {"type"}；拆分 {"groups": [{"mentions", "name"}]}
    edit: dict | None = None


EXAMPLE_CHUNK = {
    "content": "<待抽取的分片原文>",
    "document_title": "<当前文档标题>",
    "heading_path": ["<当前章节路径>"],
    "context": "<当前分片的上下文说明>",
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

    @router.post("/documents/{document_id}/graph/stop")
    def stop(
        request: Request, document_id: UUID, body: StopInput, user=Depends(current_user)
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        try:
            return graph_build.stop(state.store, str(document_id), str(body.build_id))
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

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
        if body.build_id:
            build = graph_build.get_build(state.store.engine, str(body.build_id))
            if build is None or build["document_id"] != str(document_id):
                raise HTTPException(404, "建图记录不存在")
        else:
            with state.store.engine.connect() as connection:
                build = graph_query.newest_build(connection, str(document_id))
        if build is None:
            raise HTTPException(409, "这份文档还没有建过图")
        try:
            return graph_build.retry(state.store, build["id"], body.chunk_id)
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    @router.get("/documents/{document_id}/graph/review")
    def review_detail(request: Request, document_id: UUID, user=Depends(current_user)):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        with state.store.engine.connect() as connection:
            build = graph_query.latest_build(connection, str(document_id))
        report = graph_build.review_report(state.store.engine, build) if build else None
        if report:
            report = {**report, "status": graph_build.review_state(report, build)}
        return {
            "report": report,
            "build_status": build["status"] if build else None,
            "can_confirm": row["owner"] == user["username"] or bool(user["is_admin"]),
        }

    # 按当前所有已批准的建议重写图谱（不调用模型）；不确认也不影响已写入的图谱。
    @router.post("/documents/{document_id}/graph/review/rewrite", status_code=202)
    def review_rewrite(
        request: Request,
        document_id: UUID,
        body: ReviewRewriteInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest or latest["id"] != str(body.build_id):
            raise HTTPException(409, "建图记录已切换，请刷新")
        try:
            return graph_build.rewrite_review(
                state.store,
                str(body.build_id),
                user["username"],
                {key: value.model_dump() for key, value in body.resolutions.items()},
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    # 人工合并：搜这份文档的全部实体（q 按名字或描述；ids 按编号，逗号分隔）。
    @router.get("/documents/{document_id}/graph/review/entities")
    def review_entities(
        request: Request,
        document_id: UUID,
        q: str = Query("", max_length=100),
        ids: str = Query("", max_length=5000),
        user=Depends(current_user),
    ):
        state = request.app.state
        readable(state, user["username"], document_id)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest:
            raise HTTPException(409, "这份文档还没有建过图")
        try:
            items = graph_build.review_entities(
                state.store,
                latest["id"],
                q,
                [key for key in ids.split(",") if key] or None,
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None
        return {"items": items}

    # 人工添加一条合并建议（默认已批准），到第 4 步确认后写入图谱。
    @router.post("/documents/{document_id}/graph/review/manual")
    def review_manual(
        request: Request,
        document_id: UUID,
        body: ReviewManualInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest or latest["id"] != str(body.build_id):
            raise HTTPException(409, "建图记录已切换，请刷新")
        try:
            return graph_build.add_manual_review(
                state.store,
                str(body.build_id),
                body.ids,
                body.name,
                body.type,
                body.reason,
                user["username"],
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    @router.post("/documents/{document_id}/graph/review/decide")
    def review_decide(
        request: Request,
        document_id: UUID,
        body: ReviewDecideInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest or latest["id"] != str(body.build_id):
            raise HTTPException(409, "建图记录已切换，请刷新")
        try:
            return graph_build.decide_review(
                state.store,
                str(body.build_id),
                body.proposal_ids,
                body.decision,
                user["username"],
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    # 只重试判断失败的组，其他组的判断和人工决定保留。
    @router.post("/documents/{document_id}/graph/review/retry-failed", status_code=202)
    def review_retry_failed(
        request: Request, document_id: UUID, user=Depends(current_user)
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest:
            raise HTTPException(409, "这份文档还没有建过图")
        try:
            return graph_build.retry_failed_review(state.store, latest["id"])
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    def check_target(state, user, document_id, build_id):
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest or latest["id"] != str(build_id):
            raise HTTPException(409, "建图记录已切换，请刷新")
        return latest

    def check_call(operation):
        try:
            return operation()
        except (graph_checks.CheckError, graph_build.BuildError) as error:
            raise HTTPException(409, str(error)) from None

    # 图谱检查前 4 步的状态（步骤条用，不带明细）。
    @router.get("/documents/{document_id}/graph/check")
    def check_summary(request: Request, document_id: UUID, user=Depends(current_user)):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        with state.store.engine.connect() as connection:
            build = graph_query.latest_build(connection, str(document_id))
        if not build:
            return {"build_id": None, "steps": {}}
        items = graph_checks.reports(state.store.engine, build, judgments="light")
        return {
            "build_id": build["id"],
            "can_confirm": row["owner"] == user["username"] or bool(user["is_admin"]),
            "steps": {
                step: graph_checks.summary(value) for step, value in items.items()
            },
        }

    @router.get("/documents/{document_id}/graph/check/{step}")
    def check_detail(
        request: Request, document_id: UUID, step: CheckStep, user=Depends(current_user)
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        with state.store.engine.connect() as connection:
            build = graph_query.latest_build(connection, str(document_id))
        return {
            "report": graph_checks.report(state.store.engine, build, step)
            if build
            else None,
            "build_id": build["id"] if build else None,
            "can_confirm": row["owner"] == user["username"] or bool(user["is_admin"]),
        }

    @router.post("/documents/{document_id}/graph/check/{step}/start", status_code=202)
    def check_start(
        request: Request,
        document_id: UUID,
        step: CheckStep,
        body: CheckStartInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        check_target(state, user, document_id, body.build_id)
        return check_call(
            lambda: graph_checks.start(
                state.store, str(body.build_id), step, body.params, user["username"]
            )
        )

    @router.post("/documents/{document_id}/graph/check/{step}/decide")
    def check_decide(
        request: Request,
        document_id: UUID,
        step: CheckStep,
        body: CheckDecideInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        check_target(state, user, document_id, body.build_id)
        return check_call(
            lambda: graph_checks.decide(
                state.store,
                str(body.build_id),
                step,
                body.item_ids,
                body.decision,
                body.edit,
                user["username"],
            )
        )

    @router.post("/documents/{document_id}/graph/check/{step}/{action}")
    def check_action(
        request: Request,
        document_id: UUID,
        step: CheckStep,
        action: Literal["judge", "stop", "write", "skip", "retry-failed", "rejudge"],
        body: CheckInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        check_target(state, user, document_id, body.build_id)
        build_id = str(body.build_id)
        operations = {
            "judge": lambda: graph_checks.judge_now(state.store, build_id, step),
            "stop": lambda: graph_checks.stop(state.store, build_id, step),
            "write": lambda: graph_checks.write_step_result(
                state.store, build_id, step, user["username"]
            ),
            "skip": lambda: graph_checks.skip(
                state.store, build_id, step, user["username"]
            ),
            "retry-failed": lambda: graph_checks.retry_failed(
                state.store, build_id, step
            ),
            "rejudge": lambda: graph_checks.rejudge(state.store, build_id, step),
        }
        return check_call(operations[action])

    # 停止检查（已经判断完的保留）/ 继续检查（只判断还没判断的）。
    @router.post("/documents/{document_id}/graph/review/stop")
    def review_stop(request: Request, document_id: UUID, user=Depends(current_user)):
        return review_stop_or_continue(request, document_id, "stop", user)

    @router.post("/documents/{document_id}/graph/review/continue", status_code=202)
    def review_continue(
        request: Request, document_id: UUID, user=Depends(current_user)
    ):
        return review_stop_or_continue(request, document_id, "continue", user)

    def review_stop_or_continue(request, document_id, action, user):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest:
            raise HTTPException(409, "这份文档还没有建过图")
        operation = (
            graph_build.stop_review if action == "stop" else graph_build.continue_review
        )
        try:
            return operation(state.store, latest["id"])
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None

    @router.post("/documents/{document_id}/graph/review/retry", status_code=202)
    def review_retry(request: Request, document_id: UUID, user=Depends(current_user)):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        with state.store.engine.connect() as connection:
            latest = graph_query.latest_build(connection, str(document_id))
        if not latest:
            raise HTTPException(409, "这份文档还没有建过图")
        try:
            return graph_build.retry_review(state.store, latest["id"])
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
        focus: str | None = Query(None, max_length=12000),
        center: UUID | None = Query(None),
        limit: int = Query(graph_query.NETWORK_LIMIT, ge=5, le=300),
        version: UUID | None = Query(None),
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        try:
            result = graph_query.document_graph(
                state.store.engine,
                str(document_id),
                view,
                page,
                page_size,
                q or None,
                entity_type or None,
                category or None,
                [item for item in (focus or "").split(",") if item][:300],
                str(center) if center else None,
                limit,
                str(version) if version else None,
            )
        except ValueError as error:
            raise HTTPException(404, str(error)) from None
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
        version: UUID | None = Query(None),
        user=Depends(current_user),
    ):
        state = request.app.state
        if document_id:
            readable(state, user["username"], document_id)
        elif not user["is_admin"]:
            raise HTTPException(403, "需要管理员权限")
        result = graph_query.entity_detail(
            state.store.engine,
            entity_id,
            str(document_id) if document_id else None,
            str(version) if version and document_id else None,
        )
        if result is None:
            raise HTTPException(404, "实体不存在")
        return result

    @router.get("/graph/relations")
    def edge_relations(
        request: Request,
        source_id: str = Query(..., min_length=1, max_length=36),
        target_id: str = Query(..., min_length=1, max_length=36),
        document_id: UUID | None = Query(None),
        category: str | None = Query(None, max_length=32),
        version: UUID | None = Query(None),
        user=Depends(current_user),
    ):
        state = request.app.state
        if document_id:
            readable(state, user["username"], document_id)
        elif not user["is_admin"]:
            raise HTTPException(403, "需要管理员权限")
        return {
            "items": graph_query.edge_relations(
                state.store.engine,
                source_id,
                target_id,
                str(document_id) if document_id else None,
                category,
                str(version) if version and document_id else None,
            )
        }

    # 把一个图谱版本设为生效：检索和全局图谱从此用这个版本。只有上传者和管理员可以。
    @router.post("/documents/{document_id}/graph/versions/{version_id}/activate")
    def activate_version(
        request: Request,
        document_id: UUID,
        version_id: UUID,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        try:
            items = graph_build.activate_version(
                state.store, str(document_id), str(version_id)
            )
        except graph_build.BuildError as error:
            raise HTTPException(409, str(error)) from None
        return {"versions": [graph_query.version_view(item) for item in items]}

    @router.post("/documents/{document_id}/graph/versions/{version_id}/note")
    def note_version(
        request: Request,
        document_id: UUID,
        version_id: UUID,
        body: VersionNoteInput,
        user=Depends(current_user),
    ):
        state = request.app.state
        row = readable(state, user["username"], document_id)
        check_can_build(user, row)
        try:
            graph_build.note_version(
                state.store, str(document_id), str(version_id), body.note
            )
        except graph_build.BuildError as error:
            raise HTTPException(404, str(error)) from None
        return {"ok": True}

    @router.get("/graph/overview")
    def overview(
        request: Request,
        document_id: UUID | None = Query(None),
        entity_type: str | None = Query(None, alias="type", max_length=32),
        category: str | None = Query(None, max_length=32),
        q: str | None = Query(None, max_length=100),
        focus: str | None = Query(None, max_length=12000),
        center: UUID | None = Query(None),
        limit: int = Query(graph_query.NETWORK_LIMIT, ge=5, le=300),
        admin=Depends(require_admin),
    ):
        return graph_query.overview(
            request.app.state.store.engine,
            str(document_id) if document_id else None,
            entity_type or None,
            category or None,
            [item for item in (focus or "").split(",") if item][:300],
            q or None,
            limit,
            str(center) if center else None,
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
