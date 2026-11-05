from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import hashlib
import json
import logging
import os
import time
import uuid

from sqlalchemy import and_, delete, func, select

from .. import prompts
from ..mysql.tables import (
    chunks,
    document_chunks,
    document_heads,
    document_steps,
    documents,
    graph_builds,
    graph_build_inputs,
    graph_chunk_extractions,
    graph_merges,
    graph_mentions,
    graph_relations,
)
from . import resolve, review
from .extract import PROMPT_ID, cache_key, extract_chunk
from .schemas import DEFAULT_SCHEMA_ID, ONLINE_SPACE, get_schema, now

logger = logging.getLogger(__name__)

# 图谱任务单独一个队列：worker 先取文档导入（ingest:jobs），没有导入任务时才处理建图，长时间的建图不会堵住上传。
QUEUE = "graph:jobs"
# 每个任务只抽一批分片，抽完把剩下的重新排队：中间来了上传任务可以先处理。
BATCH_SIZE = 20
# 一批里同时调用模型的数量，和上下文说明（CONTEXT_WORKERS）一样。
WORKERS = 4
# 处理流程里的建图步骤，排在「完成」（9）之后。
# 二次检查在写入图谱之后单独跑，不阻塞建图；人工确认后「按确认结果重写图谱」再写一次。
STEPS = {
    "graph_extract": (10, "抽取实体关系"),
    "graph_merge": (11, "合并实体"),
    "graph_write": (12, "写入图谱"),
    "graph_review": (13, "二次检查合并"),
    "graph_rewrite": (14, "按确认结果重写图谱"),
}
# 写入图谱后自动在后台跑二次检查；设为 0 则需要手动点「开始二次检查」。
REVIEW_AUTO = os.getenv("GRAPH_REVIEW_AUTO", "1") != "0"
# 二次检查每个任务最多判断多少组，判断完剩下的重新排队（和抽取一样，不长时间占住 worker）。
REVIEW_BATCH = 20
# 处理完成、有分片的版本才能建图。
PROCESSED_PREFIXES = ("ready:", "staged:", "review:", "flagged:")
BUSY = ("queued", "running", "awaiting_review")
TRIGGERS = ("upload", "manual", "batch", "version")


class BuildError(ValueError):
    pass


class BuildStageError(BuildError):
    def __init__(self, message, step_id, duration_ms):
        super().__init__(message)
        self.step_id = step_id
        self.duration_ms = duration_ms


class BuildStopped(Exception):
    pass


def require_running(connection, build_id):
    status = connection.execute(
        select(graph_builds.c.status)
        .where(graph_builds.c.id == build_id)
        .with_for_update()
    ).scalar_one_or_none()
    if status not in BUSY:
        raise BuildStopped()


def stop(store, document_id, build_id):
    with store.engine.begin() as connection:
        row = (
            connection.execute(
                select(graph_builds)
                .where(
                    graph_builds.c.id == build_id,
                    graph_builds.c.document_id == document_id,
                )
                .with_for_update()
            )
            .mappings()
            .first()
        )
        if row is None:
            raise BuildError("建图记录不存在")
        if row["status"] == "stopped":
            return build_view(row)
        if row["status"] not in BUSY:
            raise BuildError("建图已结束，无需停止")
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build_id)
            .values(status="stopped", updated=now(), finished=now())
        )
        connection.execute(
            document_steps.update()
            .where(
                document_steps.c.document_id == document_id,
                document_steps.c.step_id.in_(STEPS),
                document_steps.c.status.in_(("running", "pending")),
            )
            .values(
                status="stopped",
                detail="建图已停止，已保存的抽取结果保留，可重新建图",
                updated=now(),
            )
        )
    return get_build(store.engine, build_id)


def is_processed(status):
    return any((status or "").startswith(prefix) for prefix in PROCESSED_PREFIXES)


def write_step(
    store, document_id, step_id, status, detail, result=None, duration_ms=None
):
    order, title = STEPS[step_id]
    with store.engine.begin() as connection:
        build_id = (result or {}).get("build_id")
        if build_id:
            current = connection.execute(
                select(graph_builds.c.status)
                .where(graph_builds.c.id == build_id)
                .with_for_update()
            ).scalar_one_or_none()
            if current == "stopped" or current is None:
                raise BuildStopped()
        store.mysql.update_document_step(
            document_id,
            step_id,
            order,
            step_id,
            title,
            status,
            detail,
            result,
            duration_ms,
            connection=connection,
        )


# 文档版本的全部分片，带上抽取时要用的标题、章节路径和上下文说明。
def chunk_rows(engine, document_id):
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    chunks.c.id,
                    chunks.c.chunk_key,
                    chunks.c.content,
                    chunks.c.text,
                    documents.c.title,
                    document_chunks.c.position,
                    document_chunks.c.chunk_metadata,
                )
                .select_from(
                    document_chunks.join(
                        chunks, chunks.c.id == document_chunks.c.chunk_id
                    ).join(documents, documents.c.id == document_chunks.c.document_id)
                )
                .where(document_chunks.c.document_id == document_id)
                .order_by(document_chunks.c.position)
            )
            .mappings()
            .all()
        )
    result = []
    for row in rows:
        metadata_value = row["chunk_metadata"] or {}
        content = row["content"] or row["text"] or ""
        result.append(
            {
                "chunk_id": row["id"],
                # 早期分片没有 chunk_key 时用文字的指纹代替，同样能复用。
                "chunk_key": row["chunk_key"]
                or hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "position": row["position"],
                "content": content,
                "document_title": row["title"],
                "heading_path": metadata_value.get("heading_path") or [],
                "context": metadata_value.get("context"),
            }
        )
    return result


def document_row(engine, document_id):
    with engine.connect() as connection:
        return (
            connection.execute(select(documents).where(documents.c.id == document_id))
            .mappings()
            .first()
        )


# 抽取用哪个模型：不指定就用当前启用的；指定的必须是已保存的模型配置（和评测按次指定模型同一套）。
def resolve_llm(store, models, choice, fallback=False):
    active = {"provider": models.llm_provider, "model": models.llm_model}
    if not choice or not choice.get("provider"):
        return active, None
    if (
        choice["provider"] == active["provider"]
        and (choice.get("model") or active["model"]) == active["model"]
    ):
        return active, None
    from ..evaluation.params import _profile

    try:
        profile = _profile(store, models, choice, "抽取模型")
    except ValueError as error:
        # 自动建图（上传时开启、新版本）沿用的配置被删了：改用当前启用的模型，并写明原因。
        if fallback:
            return active, f"原来选的模型配置不可用（{error}），改用当前启用的模型"
        raise BuildError(str(error)) from None
    return {"provider": profile["provider"], "model": profile["model"]}, None


def models_for(store, models, build):
    if build["provider"] == models.llm_provider and build["model"] == models.llm_model:
        return models
    from ..evaluation.params import _profile

    profile = _profile(
        store,
        models,
        {"provider": build["provider"], "model": build["model"]},
        "抽取模型",
    )
    return models.fork(profile)


def schema_for(engine, schema_id):
    schema = get_schema(engine, schema_id or DEFAULT_SCHEMA_ID)
    if schema is None:
        raise BuildError("清单不存在")
    return schema


def prompt_snapshot():
    version, instructions = prompts.current(PROMPT_ID)
    text = instructions + "\n" + prompts.BY_ID[PROMPT_ID]["locked"]
    return {
        "system_prompt": text,
        "prompt_tag": f"{PROMPT_ID}@{prompts.version_label(version)}",
        "prompt_identity": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
    }


def build_inputs(engine, build_id):
    with engine.connect() as connection:
        row = (
            connection.execute(
                select(graph_build_inputs).where(
                    graph_build_inputs.c.build_id == build_id
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        raise BuildError("旧建图任务没有配置快照，请重新建图，避免混用提示词或清单")
    return dict(row)


# 预估：这次建图有多少分片、多少能复用以前的抽取结果、要调用模型多少次。
def estimate(store, models, document_id, schema_id=None, choice=None):
    row = document_row(store.engine, document_id)
    if row is None:
        raise BuildError("文档不存在")
    schema = schema_for(store.engine, schema_id)
    llm, _ = resolve_llm(store, models, choice)
    snapshot = prompt_snapshot()
    identity = snapshot["prompt_identity"]
    items = chunk_rows(store.engine, document_id)
    keys = [
        cache_key(item["chunk_key"], schema, llm["provider"], llm["model"], identity)
        for item in items
    ]
    reusable = reusable_extractions(store.engine, keys)
    return {
        "document_id": document_id,
        "schema_id": schema["id"],
        "provider": llm["provider"],
        "model": llm["model"],
        "prompt_tag": snapshot["prompt_tag"],
        "total": len(items),
        "reusable": sum(1 for key in keys if key in reusable),
        "to_extract": sum(1 for key in keys if key not in reusable),
    }


# 以前抽过、可以直接复用的结果：cache_key 相同、抽取成功的最新一条。
# 不在 SQL 里 ORDER BY：抽取记录带着完整提示词和模型输出（JSON / TEXT），MySQL 排序时要把整行放进
# sort buffer，分片一多就报 1038 Out of sort memory。取出来以后在 Python 里按时间挑最新的。
def reusable_extractions(engine, keys):
    if not keys:
        return {}
    found = {}
    with engine.connect() as connection:
        for start in range(0, len(keys), 500):
            part = keys[start : start + 500]
            rows = (
                connection.execute(
                    select(graph_chunk_extractions).where(
                        graph_chunk_extractions.c.cache_key.in_(part),
                        graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                current = found.get(row["cache_key"])
                if current is None or row["created"] >= current["created"]:
                    found[row["cache_key"]] = dict(row)
    return found


def build_view(row):
    if row is None:
        return None
    value = dict(row)
    value["trigger"] = value.pop("trigger_kind")
    return value


def get_build(engine, build_id):
    with engine.connect() as connection:
        return build_view(
            connection.execute(
                select(graph_builds).where(graph_builds.c.id == build_id)
            )
            .mappings()
            .first()
        )


# stage="review"：只跑二次检查（模型判断），不重新抽取和写入。
def enqueue(store, build_id, stage=None):
    payload = {"type": "graph", "build_id": build_id}
    if stage:
        payload["stage"] = stage
    store.cache.rpush(QUEUE, json.dumps(payload))


# 开始建图：检查文档、清单和模型，写一条排队中的建图记录，投递给 worker。
def start_build(
    store,
    models,
    document_id,
    schema_id=None,
    choice=None,
    trigger="manual",
    user="system",
    space=ONLINE_SPACE,
):
    if trigger not in TRIGGERS:
        raise BuildError("未知的触发方式")
    if getattr(models, "mode", "openai") != "openai":
        raise BuildError("演示模式（MODEL_MODE=demo）没有大模型，不能建图")
    row = document_row(store.engine, document_id)
    if row is None:
        raise BuildError("文档不存在")
    if not is_processed(row["status"]):
        raise BuildError("文档还没有处理完成，处理完才能建图")
    schema = schema_for(store.engine, schema_id)
    llm, note = resolve_llm(
        store, models, choice, fallback=trigger in ("upload", "version")
    )
    total = len(chunk_rows(store.engine, document_id))
    if total == 0:
        raise BuildError("这个版本没有分片，不能建图")
    timestamp = now()
    build_id = str(uuid.uuid4())
    snapshot = prompt_snapshot()
    with store.engine.begin() as connection:
        busy = connection.execute(
            select(graph_builds.c.id).where(
                graph_builds.c.document_id == document_id,
                graph_builds.c.space == space,
                graph_builds.c.status.in_(BUSY),
            )
        ).first()
        if busy is not None:
            raise BuildError("这份文档正在建图，完成后再试")
        connection.execute(
            graph_builds.insert().values(
                id=build_id,
                space=space,
                document_id=document_id,
                doc_key=row["doc_key"] or document_id,
                schema_id=schema["id"],
                provider=llm["provider"] or "",
                model=llm["model"] or "",
                prompt_tag=snapshot["prompt_tag"],
                prompt_identity=snapshot["prompt_identity"],
                status="queued",
                active=False,
                trigger_kind=trigger,
                total=total,
                extracted=0,
                reused=0,
                failed=0,
                entity_count=0,
                relation_count=0,
                input_tokens=0,
                output_tokens=0,
                note=note,
                created_by=user,
                created=timestamp,
                updated=timestamp,
            )
        )
        connection.execute(
            graph_build_inputs.insert().values(
                build_id=build_id,
                system_prompt=snapshot["system_prompt"],
                schema_snapshot=schema,
            )
        )
    write_step(
        store,
        document_id,
        "graph_extract",
        "running",
        f"排队中：共 {total} 个分片，清单「{schema['name']}」，模型 {llm['model']}",
        {
            "build_id": build_id,
            "total": total,
            "schema": schema["name"],
            "model": llm["model"],
        },
    )
    store.mysql.clear_document_steps(document_id, STEPS["graph_merge"][0])
    for step_id in ("graph_merge", "graph_write", "graph_review"):
        write_step(
            store,
            document_id,
            step_id,
            "pending",
            "等待抽取完成",
            {"build_id": build_id},
        )
    enqueue(store, build_id)
    return get_build(store.engine, build_id)


# 上传时开启了图检索（或者新版本沿用了上一版的设置）：文档处理完后自动建图。没开启的什么都不做。
def auto_build(store, models, document_id):
    row = document_row(store.engine, document_id)
    if row is None:
        return None
    settings = (row["document_metadata"] or {}).get("graph") or {}
    if not settings.get("enabled"):
        return None
    choice = (
        {"provider": settings["provider"], "model": settings.get("model")}
        if settings.get("provider")
        else None
    )
    return start_build(
        store,
        models,
        document_id,
        settings.get("schema_id"),
        choice,
        trigger=settings.get("trigger") or "upload",
        user=row["owner"],
    )


def counts(connection, build_id):
    rows = connection.execute(
        select(graph_chunk_extractions.c.status, func.count())
        .where(graph_chunk_extractions.c.build_id == build_id)
        .group_by(graph_chunk_extractions.c.status)
    ).all()
    value = {"extracted": 0, "reused": 0, "failed": 0}
    for status, count in rows:
        value[status] = count
    tokens = connection.execute(
        select(
            func.coalesce(func.sum(graph_chunk_extractions.c.input_tokens), 0),
            func.coalesce(func.sum(graph_chunk_extractions.c.output_tokens), 0),
        ).where(graph_chunk_extractions.c.build_id == build_id)
    ).first()
    value["input_tokens"], value["output_tokens"] = int(tokens[0]), int(tokens[1])
    return value


def mark_failed(store, build, message, step_id="graph_extract", duration_ms=None):
    saved = review_report(store.engine, build) if step_id == "graph_review" else None
    with store.engine.begin() as connection:
        try:
            require_running(connection, build["id"])
        except BuildStopped:
            return
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build["id"])
            .values(
                status="failed", error=message[:2000], updated=now(), finished=now()
            )
        )
    write_step(
        store,
        build["document_id"],
        step_id,
        "failed",
        f"建图失败：{message[:300]}",
        {**(saved or {}), "build_id": build["id"], "error": message[:300]},
        duration_ms,
    )


# worker 处理一个建图任务：抽一批分片，还有剩下的就重新排队，全部抽完后合并实体、写入图谱。
def run_job(store, models, payload):
    if payload.get("stage") == "review":
        run_review_job(store, models, payload["build_id"])
        return
    build = get_build(store.engine, payload["build_id"])
    if (
        build is None
        or build["status"] not in BUSY
        or build["status"] == "awaiting_review"
    ):
        logger.info("graph_job_skipped id=%s", payload.get("build_id"))
        return
    try:
        run_batch(store, models, build)
    except BuildStopped:
        logger.info("graph_job_stopped id=%s", build["id"])
    except Exception as error:
        logger.exception("graph_job_failed id=%s", build["id"])
        mark_failed(
            store,
            build,
            str(error),
            getattr(error, "step_id", "graph_extract"),
            getattr(error, "duration_ms", None),
        )


def run_batch(store, models, build):
    inputs = build_inputs(store.engine, build["id"])
    schema = inputs["schema_snapshot"]
    with store.engine.begin() as connection:
        require_running(connection, build["id"])
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build["id"])
            .values(status="running", updated=now())
        )
        done = set(
            connection.execute(
                select(graph_chunk_extractions.c.chunk_id).where(
                    graph_chunk_extractions.c.build_id == build["id"]
                )
            )
            .scalars()
            .all()
        )
    items = [
        item
        for item in chunk_rows(store.engine, build["document_id"])
        if item["chunk_id"] not in done
    ]
    if not items and not done:
        raise BuildError("这个版本的分片已经被清理，不能继续建图")
    batch = items[:BATCH_SIZE]
    if batch:
        keys = {
            item["chunk_id"]: cache_key(
                item["chunk_key"],
                schema,
                build["provider"],
                build["model"],
                build["prompt_identity"],
            )
            for item in batch
        }
        reusable = reusable_extractions(store.engine, list(keys.values()))
        to_call = [item for item in batch if keys[item["chunk_id"]] not in reusable]

        def persist(item, result):
            row = {
                "id": str(uuid.uuid4()),
                "build_id": build["id"],
                "document_id": build["document_id"],
                "chunk_id": item["chunk_id"],
                "chunk_key": item["chunk_key"],
                "position": item["position"],
                "cache_key": keys[item["chunk_id"]],
                "created": now(),
                **result,
            }
            with store.engine.begin() as connection:
                require_running(connection, build["id"])
                connection.execute(graph_chunk_extractions.insert().values(**row))
                value = counts(connection, build["id"])
                connection.execute(
                    graph_builds.update()
                    .where(graph_builds.c.id == build["id"])
                    .values(**value, updated=now())
                )
            processed = value["extracted"] + value["reused"] + value["failed"]
            write_step(
                store,
                build["document_id"],
                "graph_extract",
                "running",
                f"已处理 {processed} / {build['total']} 个分片：新抽取 {value['extracted']}，复用 {value['reused']}，失败 {value['failed']}",
                {"build_id": build["id"], "total": build["total"], **value},
            )

        for item in batch:
            source = reusable.get(keys[item["chunk_id"]])
            if source is not None:
                persist(
                    item,
                    {
                        "status": "reused",
                        "reused_from": source["id"],
                        "prompt": source["prompt"],
                        "raw_output": source["raw_output"],
                        "result": source["result"],
                        "error": None,
                        "input_tokens": None,
                        "output_tokens": None,
                        "duration_ms": None,
                    },
                )
        if to_call:
            run_models = models_for(store, models, build)
            executor = ThreadPoolExecutor(max_workers=WORKERS)
            remaining = iter(to_call)
            futures = {}

            def submit_next():
                with store.engine.connect() as connection:
                    require_running(connection, build["id"])
                item = next(remaining, None)
                if item is not None:
                    futures[
                        executor.submit(
                            extract_chunk,
                            run_models,
                            schema,
                            item,
                            inputs["system_prompt"],
                        )
                    ] = item

            try:
                for _ in range(WORKERS):
                    submit_next()
                while futures:
                    with store.engine.connect() as connection:
                        require_running(connection, build["id"])
                    completed, _ = wait(
                        futures, timeout=0.5, return_when=FIRST_COMPLETED
                    )
                    for future in completed:
                        persist(
                            futures.pop(future),
                            {"reused_from": None, **future.result()},
                        )
                        submit_next()
            finally:
                executor.shutdown(wait=False, cancel_futures=True)
    with store.engine.connect() as connection:
        require_running(connection, build["id"])
    if len(items) > len(batch):
        enqueue(store, build["id"])
        return
    finalize(store, build, models)


# 全部分片抽完：按分片顺序合并实体、写入名字和关系；这份文档在空间里只保留这一次建图为 active。
def finalize(store, build, models=None):
    with store.engine.connect() as connection:
        value = counts(connection, build["id"])
        rows = (
            connection.execute(
                select(graph_chunk_extractions).where(
                    graph_chunk_extractions.c.build_id == build["id"],
                    graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                )
            )
            .mappings()
            .all()
        )
        # 按分片顺序合并；排序放在 Python 里，原因见 reusable_extractions。
        rows = sorted(rows, key=lambda row: row["position"])
    extract_status = (
        "completed" if not value["failed"] else ("warning" if rows else "failed")
    )
    write_step(
        store,
        build["document_id"],
        "graph_extract",
        extract_status,
        f"共 {build['total']} 个分片：新抽取 {value['extracted']}，复用 {value['reused']}，失败 {value['failed']}；"
        f"token 输入 {value['input_tokens']}，输出 {value['output_tokens']}",
        {"build_id": build["id"], "total": build["total"], **value},
    )
    summary = None
    step_id = "graph_merge"
    started = time.monotonic()
    try:
        if rows:
            write_step(
                store,
                build["document_id"],
                step_id,
                "running",
                "正在计算名字归属",
                {"build_id": build["id"]},
            )
            with store.engine.connect() as connection:
                plan = resolve.prepare_build(
                    connection,
                    build["space"],
                    build["id"],
                    [dict(row) for row in rows],
                    build["created_by"],
                )
            summary = plan["summary"]
            labels = {
                "new": "新建",
                "exact": "名字相同",
                "normalized": "规范化后相同",
                "canonical": "模型标准名",
                "alias": "别名表",
            }
            methods = "，".join(
                f"{labels.get(key, key)} {count}"
                for key, count in summary["methods"].items()
            )
            write_step(
                store,
                build["document_id"],
                step_id,
                "completed",
                f"归到 {summary['entity_count']} 个实体（新建 {summary['created_count']} 个）；"
                f"名字归属：新建 {summary['scope_counts']['new']}，文档内合并 {summary['scope_counts']['document']}，跨文档合并 {summary['scope_counts']['global']}；{methods}",
                {"build_id": build["id"], **summary},
                round((time.monotonic() - started) * 1000),
            )
            # 之前人工确认并「重写图谱」过的合并，每次写入都按它应用（补跑分片、重写时都一样）。
            report = review_report(store.engine, build)
            applied = (report or {}).get("applied")
            records = None
            if applied:
                with store.engine.connect() as connection:
                    _, ids = review.inventory(plan, {})
                    records = review.apply(
                        connection, plan, build, applied["groups"], ids, applied["by"]
                    )
                summary = plan["summary"]
            step_id = "graph_write"
            started = time.monotonic()
            write_step(
                store,
                build["document_id"],
                step_id,
                "running",
                "正在保存实体、名字出处和关系",
                {"build_id": build["id"]},
            )
        status = (
            ("completed" if not value["failed"] else "partial") if rows else "failed"
        )
        with store.engine.begin() as connection:
            require_running(connection, build["id"])
            if rows:
                resolve.write_build(connection, build["space"], build["id"], plan)
                connection.execute(
                    graph_builds.update()
                    .where(
                        graph_builds.c.space == build["space"],
                        graph_builds.c.doc_key == build["doc_key"],
                        graph_builds.c.id != build["id"],
                    )
                    .values(active=False)
                )
            connection.execute(
                graph_builds.update()
                .where(graph_builds.c.id == build["id"])
                .values(
                    **value,
                    status=status,
                    active=summary is not None,
                    entity_count=summary["entity_count"] if summary else 0,
                    relation_count=summary["relation_count"] if summary else 0,
                    error=None if rows else "全部分片都抽取失败",
                    updated=now(),
                    finished=now(),
                )
            )
        if summary is not None:
            write_step(
                store,
                build["document_id"],
                "graph_write",
                "completed",
                f"已保存 {summary['entity_count']} 个实体的归属、{summary['mention_count']} 条名字出处、{summary['relation_count']} 条关系，建图已生效",
                {"build_id": build["id"], **summary},
                round((time.monotonic() - started) * 1000),
            )
            after_write(store, build, report, records)
        else:
            for pending in ("graph_merge", "graph_write", "graph_review"):
                write_step(
                    store,
                    build["document_id"],
                    pending,
                    "pending",
                    "未执行：全部分片都抽取失败",
                    {"build_id": build["id"]},
                )
    except BuildStopped:
        raise
    except Exception as error:
        raise BuildStageError(
            str(error), step_id, round((time.monotonic() - started) * 1000)
        ) from error
    logger.info("graph_build_done id=%s status=%s", build["id"], status)


# 补跑失败的分片（或者只补跑某一片）：删掉失败的抽取记录，重新排队；全部抽完后重新合并。
def retry(store, build_id, chunk_id=None):
    build = get_build(store.engine, build_id)
    if build is None:
        raise BuildError("建图记录不存在")
    if build["status"] == "stopped":
        raise BuildError("建图已停止，请重新建图")
    if build["status"] in BUSY:
        raise BuildError("正在建图，完成后再试")
    build_inputs(store.engine, build_id)
    with store.engine.begin() as connection:
        condition = and_(
            graph_chunk_extractions.c.build_id == build_id,
            graph_chunk_extractions.c.status == "failed",
        )
        if chunk_id:
            condition = and_(condition, graph_chunk_extractions.c.chunk_id == chunk_id)
        removed = connection.execute(
            delete(graph_chunk_extractions).where(condition)
        ).rowcount
        if not removed:
            raise BuildError("没有需要补跑的分片")
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build_id)
            .values(status="queued", updated=now(), error=None)
        )
    write_step(
        store,
        build["document_id"],
        "graph_extract",
        "running",
        f"排队中：补跑 {removed} 个失败的分片",
        {"build_id": build_id},
    )
    # 二次检查的报告（含人工决定和已应用的合并）保留：补跑完写入时会继续应用已确认的合并。
    for step_id in ("graph_merge", "graph_write"):
        write_step(
            store,
            build["document_id"],
            step_id,
            "pending",
            "等待补跑完成",
            {"build_id": build_id},
        )
    enqueue(store, build_id)
    return get_build(store.engine, build_id)


# worker 启动时把被中断的建图任务重新放回队列（和 recover_jobs 一样以 MySQL 状态为准）。
def recover(store):
    queued = set()
    for raw in store.cache.lrange(QUEUE, 0, -1):
        queued.add(json.loads(raw).get("build_id"))
    with store.engine.connect() as connection:
        ids = (
            connection.execute(
                select(graph_builds.c.id).where(
                    graph_builds.c.status.in_(("queued", "running"))
                )
            )
            .scalars()
            .all()
        )
    count = 0
    for build_id in ids:
        if build_id not in queued:
            enqueue(store, build_id)
            count += 1
    # 二次检查是建图完成后的独立任务：中断的（排队中、判断中）也放回队列。
    with store.engine.connect() as connection:
        results = (
            connection.execute(
                select(document_steps.c.result).where(
                    document_steps.c.step_id == "graph_review",
                    document_steps.c.status.in_(("pending", "running")),
                )
            )
            .scalars()
            .all()
        )
    for result in results:
        build_id = (result or {}).get("build_id")
        if (
            build_id
            and build_id not in queued
            and result.get("status") in ("queued", "running")
        ):
            build = get_build(store.engine, build_id)
            if build and build["status"] in ("completed", "partial"):
                enqueue(store, build_id, "review")
                count += 1
    return count


# 删除文档时一起删掉它所有版本的图谱数据，再清理没有任何名字的实体。
def remove_documents(connection, document_ids):
    if not document_ids:
        return
    rows = connection.execute(
        select(graph_builds.c.id, graph_builds.c.space).where(
            graph_builds.c.document_id.in_(document_ids)
        )
    ).all()
    build_ids = [row[0] for row in rows]
    if build_ids:
        for table in (graph_relations, graph_mentions, graph_merges):
            connection.execute(delete(table).where(table.c.build_id.in_(build_ids)))
        connection.execute(
            delete(graph_build_inputs).where(
                graph_build_inputs.c.build_id.in_(build_ids)
            )
        )
        connection.execute(delete(graph_builds).where(graph_builds.c.id.in_(build_ids)))
    connection.execute(
        delete(graph_chunk_extractions).where(
            graph_chunk_extractions.c.document_id.in_(document_ids)
        )
    )
    for space in {row[1] for row in rows}:
        resolve.remove_orphans(connection, space)


# 当前版本（document_heads 指向的）有没有过期的图谱：这份文档最近一次生效的建图是给旧版本建的。
def current_document_ids(connection):
    return {
        row[0]: row[1]
        for row in connection.execute(
            select(document_heads.c.doc_key, document_heads.c.current_document_id)
        ).all()
    }


def review_report(engine, build):
    with engine.connect() as connection:
        result = connection.execute(
            select(document_steps.c.result).where(
                document_steps.c.document_id == build["document_id"],
                document_steps.c.step_id == "graph_review",
            )
        ).scalar_one_or_none()
    return (
        result
        if isinstance(result, dict) and result.get("build_id") == build["id"]
        else None
    )


# 报告状态：queued 排队 / running 模型判断中 / ready 可以逐条决定 / rewriting 正在按确认结果重写 / failed / idle 未开始。
# 旧流程留下的状态（awaiting_review、confirmed、completed）都当作 ready；重写中断（建图已不在跑）也回到 ready。
def review_state(report, build):
    status = (report or {}).get("status")
    if status in ("awaiting_review", "confirmed", "prepared", "completed"):
        return "ready"
    if status == "rewriting" and build["status"] not in ("queued", "running"):
        return "ready"
    return status


def review_progress(report):
    decisions = report.get("decisions") or {}
    valid = review.proposals(report)
    total = len(valid)
    approved = sum(
        item["decision"] == "approved"
        for key, item in decisions.items()
        if key in valid
    )
    rejected = sum(
        item["decision"] == "rejected"
        for key, item in decisions.items()
        if key in valid
    )
    applied = len((report.get("applied") or {}).get("groups") or [])
    text = (
        f"模型给出 {total} 条合并建议：已批准 {approved}，已否决 {rejected}，"
        f"待处理 {total - approved - rejected}"
    )
    return text + (
        f"；图谱已应用 {applied} 个合并结果" if applied else "；不影响已写入的图谱"
    )


def _review_step(store, build, report, status, detail):
    write_step(store, build["document_id"], "graph_review", status, detail, report)


def _carry(report):
    return {"applied": report["applied"]} if report and report.get("applied") else {}


# 写入图谱之后：如果这次是「按确认结果重写」，记下结果；否则（新建图、补跑分片）开始或排队二次检查。
def after_write(store, build, report, records):
    if report and report.get("status") == "rewriting":
        report["applied"]["records"] = records or []
        report["status"] = "ready"
        done = [row for row in records or [] if row["status"] == "completed"]
        skipped = len(records or []) - len(done)
        write_step(
            store,
            build["document_id"],
            "graph_rewrite",
            "completed",
            f"已按 {len(done)} 个合并结果重写图谱"
            + (f"，{skipped} 个因抽取结果变化跳过" if skipped else "")
            + f"（确认人 {report['applied']['by']}）",
            {"build_id": build["id"], "records": records or []},
        )
        _review_step(store, build, report, "completed", review_progress(report))
        return
    if not REVIEW_AUTO and not report:
        _review_step(
            store,
            build,
            {"build_id": build["id"], "status": "idle"},
            "pending",
            "未开始：可在「实体关系」页签手动开始二次检查（不影响已写入的图谱）",
        )
        return
    # 保留原报告（模型判断、人工决定）：抽取结果没变时直接沿用，不重复调用模型。
    queued = {**(report or {}), "build_id": build["id"], "status": "queued"}
    _review_step(
        store, build, queued, "pending", "排队等待二次检查（不影响已写入的图谱）"
    )
    enqueue(store, build["id"], "review")


def extraction_rows(engine, build_id):
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(graph_chunk_extractions).where(
                    graph_chunk_extractions.c.build_id == build_id,
                    graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                )
            )
            .mappings()
            .all()
        )
    return sorted((dict(row) for row in rows), key=lambda row: row["position"])


# 二次检查任务：从已保存的抽取结果重新算一遍归属（只读，不调用模型），找候选，再逐组让模型判断。
def run_review_job(store, models, build_id):
    build = get_build(store.engine, build_id)
    report = review_report(store.engine, build) if build else None
    if (
        build is None
        or build["status"] not in ("completed", "partial")
        or review_state(report, build) not in ("queued", "running")
    ):
        logger.info("graph_review_skipped id=%s", build_id)
        return
    try:
        run_review(store, models, build, report)
    except BuildStopped:
        logger.info("graph_review_stopped id=%s", build_id)
    except Exception as error:
        logger.exception("graph_review_failed id=%s", build_id)
        current = review_report(store.engine, build) or report
        current.update(status="failed", error=str(error)[:1000])
        try:
            _review_step(
                store, build, current, "failed", f"二次检查失败：{str(error)[:300]}"
            )
        except BuildStopped:
            pass


def run_review(store, models, build, report):
    inputs = build_inputs(store.engine, build["id"])
    evidence = {
        item["chunk_id"]: item["content"]
        for item in chunk_rows(store.engine, build["document_id"])
    }
    scan_started = time.monotonic()
    with store.engine.connect() as connection:
        plan = resolve.prepare_build(
            connection,
            build["space"],
            build["id"],
            extraction_rows(store.engine, build["id"]),
            build["created_by"],
        )
    items, _ = review.inventory(plan, evidence)
    method = review.method_info(models)
    signature = hashlib.sha256(
        json.dumps(
            [
                review.VERSION,
                items,
                build["provider"],
                build["model"],
                inputs["schema_snapshot"],
                method,
            ],
            ensure_ascii=False,
            sort_keys=True,
        ).encode()
    ).hexdigest()
    if report.get("signature") != signature:
        try:
            candidates, stats = review.candidates(items, models.embed)
        except Exception as error:  # 向量服务不可用时只按名字相同找，并在报告里说明。
            logger.warning("二次检查计算实体向量失败：%s", error)
            candidates, stats = review.candidates(items)
            method["error"] = (
                f"计算实体向量失败，只按名字相同找候选：{str(error)[:300]}"
            )
        # 提示词在这一刻定下来：之后分批判断都用同一版；改了提示词要点「重新检查」才用新版本。
        snapshot = review.prompt_snapshot()
        report = {
            "build_id": build["id"],
            "signature": signature,
            "prompt_tag": snapshot["prompt_tag"],
            "system_prompt": snapshot["system_prompt"],
            "status": "running",
            "scan": {
                "status": "completed",
                "entity_count": len(items),
                "candidate_count": len(candidates),
                "duration_ms": round((time.monotonic() - scan_started) * 1000),
                "candidates": candidates,
                "method": method,
                "stats": stats,
            },
            "judgments": [],
            **_carry(report),
        }
    report["status"] = "running"
    candidates = report["scan"]["candidates"]
    done = {
        row["candidate_id"] for row in report["judgments"] if row["status"] != "running"
    }
    todo = [row for row in candidates if row["id"] not in done]
    run_models = models_for(store, models, build) if todo else None
    for candidate in todo[:REVIEW_BATCH]:
        latest = review_report(store.engine, build)
        if review_state(latest, build) not in ("queued", "running"):
            raise BuildStopped()
        report["judgments"] = [
            row for row in report["judgments"] if row["candidate_id"] != candidate["id"]
        ]
        report["judgments"].append(
            review.judge(
                run_models,
                inputs["schema_snapshot"],
                candidate,
                report.get("system_prompt"),
            )
        )
        _review_step(
            store,
            build,
            report,
            "running",
            f"模型判断：{len(report['judgments'])}/{len(candidates)} 组（不影响已写入的图谱）",
        )
    if len(todo) > REVIEW_BATCH:
        enqueue(store, build["id"], "review")
        return report
    report["status"] = "ready"
    _review_step(
        store,
        build,
        report,
        "completed",
        review_progress(report)
        if candidates
        else "没有疑似重复或类型冲突的候选，无需合并",
    )
    return report


def _ready_report(store, build_id):
    build = get_build(store.engine, build_id)
    if build is None:
        raise BuildError("建图记录不存在")
    report = review_report(store.engine, build)
    if review_state(report, build) != "ready":
        raise BuildError("二次检查还没完成，或正在重写图谱，请稍后再试")
    return build, report


def _lock_build(connection, build_id):
    current = connection.execute(
        select(graph_builds.c.status)
        .where(graph_builds.c.id == build_id)
        .with_for_update()
    ).scalar_one()
    if current in ("queued", "running"):
        raise BuildError("建图进行中，完成后再试")
    return current


def _save_report(connection, build, report, **values):
    connection.execute(
        document_steps.update()
        .where(
            document_steps.c.document_id == build["document_id"],
            document_steps.c.step_id == "graph_review",
        )
        .values(result=report, updated=now(), **values)
    )


# 单独或批量记录人工决定（批准 / 否决 / 撤销），只保存，不改图谱；「按确认结果重写图谱」时统一执行。
def decide_review(store, build_id, proposal_ids, decision, username):
    build, report = _ready_report(store, build_id)
    valid = review.proposals(report)
    if not proposal_ids or not set(proposal_ids) <= set(valid):
        raise BuildError("包含无效的合并建议")
    with store.engine.begin() as connection:
        _lock_build(connection, build_id)
        build, report = _ready_report(store, build_id)
        decisions = report.setdefault("decisions", {})
        for proposal_id in proposal_ids:
            if decision is None:
                decisions.pop(proposal_id, None)
            else:
                decisions[proposal_id] = {
                    "decision": decision,
                    "by": username,
                    "at": now(),
                }
        _save_report(connection, build, report, detail=review_progress(report))
    return report


# 按当前所有已批准的建议重写图谱：从已保存的抽取结果重新写一遍，不调用模型。
# 结果只取决于「现在批准了哪些」：撤销某条后再重写，那个合并就会消失。
def rewrite_review(store, build_id, username, resolutions=None):
    build, report = _ready_report(store, build_id)
    valid = review.proposals(report)
    approved = sorted(
        key
        for key, item in (report.get("decisions") or {}).items()
        if item["decision"] == "approved" and key in valid
    )
    try:
        groups = review.resolve_groups(report, approved, resolutions)
    except ValueError as error:
        raise BuildError(str(error)) from None
    if not groups and not (report.get("applied") or {}).get("groups"):
        raise BuildError("还没有批准任何合并建议")
    report.update(
        status="rewriting",
        applied={
            "groups": groups,
            "approved_ids": approved,
            "by": username,
            "at": now(),
            "records": None,
        },
    )
    with store.engine.begin() as connection:
        _lock_build(connection, build_id)
        _save_report(
            connection,
            build,
            report,
            status="completed",
            detail=f"已提交：按 {len(groups)} 个合并结果重写图谱",
        )
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build_id)
            .values(status="queued", updated=now(), error=None)
        )
    write_step(
        store,
        build["document_id"],
        "graph_rewrite",
        "running",
        f"排队中：按 {len(groups)} 个合并结果重写图谱（不调用模型）",
        {"build_id": build_id},
    )
    enqueue(store, build_id)
    return get_build(store.engine, build_id)


# 只重试判断失败的组：其他组的判断、人工决定、已应用的合并都保留，用这次检查定下的同一版提示词。
def retry_failed_review(store, build_id):
    build, report = _ready_report(store, build_id)
    failed = [
        row["candidate_id"] for row in report["judgments"] if row["status"] == "failed"
    ]
    if not failed:
        raise BuildError("没有判断失败的组")
    report["judgments"] = [
        row for row in report["judgments"] if row["status"] != "failed"
    ]
    report["status"] = "queued"
    with store.engine.begin() as connection:
        _lock_build(connection, build_id)
        _save_report(
            connection,
            build,
            report,
            status="pending",
            detail=f"排队重试 {len(failed)} 个判断失败的组（不影响已写入的图谱）",
        )
    enqueue(store, build_id, "review")
    return report


# 重新检查（或手动开始）：清掉模型判断和人工决定，只保留图谱上已应用的合并，重新找候选、判断。
def retry_review(store, build_id):
    build = get_build(store.engine, build_id)
    if build is None:
        raise BuildError("建图记录不存在")
    report = review_report(store.engine, build)
    if review_state(report, build) in ("queued", "running", "rewriting"):
        raise BuildError("二次检查正在进行，不能重复开始")
    fresh = {"build_id": build_id, "status": "queued", **_carry(report)}
    with store.engine.begin() as connection:
        current = _lock_build(connection, build_id)
        # 旧流程停在「等待人工确认」的建图还没写入图谱：先写入，写完自动开始检查。
        legacy = current == "awaiting_review"
        if legacy:
            connection.execute(
                graph_builds.update()
                .where(graph_builds.c.id == build_id)
                .values(status="queued", updated=now(), error=None)
            )
        _save_report(
            connection, build, fresh, status="pending", detail="排队等待重新检查"
        )
    enqueue(store, build_id, None if legacy else "review")
    return get_build(store.engine, build_id)
