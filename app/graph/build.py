from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import time
import uuid

from sqlalchemy import and_, delete, func, select

from .. import prompts
from ..mysql.tables import (
    chunks,
    document_chunks,
    document_heads,
    documents,
    graph_builds,
    graph_build_inputs,
    graph_chunk_extractions,
    graph_merges,
    graph_mentions,
    graph_relations,
)
from . import resolve
from .extract import PROMPT_ID, cache_key, extract_chunk
from .schemas import DEFAULT_SCHEMA_ID, ONLINE_SPACE, get_schema, now

logger = logging.getLogger(__name__)

# 图谱任务单独一个队列：worker 先取文档导入（ingest:jobs），没有导入任务时才处理建图，长时间的建图不会堵住上传。
QUEUE = "graph:jobs"
# 每个任务只抽一批分片，抽完把剩下的重新排队：中间来了上传任务可以先处理。
BATCH_SIZE = 20
# 一批里同时调用模型的数量，和上下文说明（CONTEXT_WORKERS）一样。
WORKERS = 4
# 处理流程里的三步，排在「完成」（9）之后。
STEPS = {
    "graph_extract": (10, "抽取实体关系"),
    "graph_merge": (11, "合并实体"),
    "graph_write": (12, "写入图谱"),
}
# 处理完成、有分片的版本才能建图。
PROCESSED_PREFIXES = ("ready:", "staged:", "review:", "flagged:")
BUSY = ("queued", "running")
TRIGGERS = ("upload", "manual", "batch", "version")


class BuildError(ValueError):
    pass


class BuildStageError(BuildError):
    def __init__(self, message, step_id, duration_ms):
        super().__init__(message)
        self.step_id = step_id
        self.duration_ms = duration_ms


def is_processed(status):
    return any((status or "").startswith(prefix) for prefix in PROCESSED_PREFIXES)


def write_step(
    store, document_id, step_id, status, detail, result=None, duration_ms=None
):
    order, title = STEPS[step_id]
    store.mysql.update_document_step(
        document_id, step_id, order, step_id, title, status, detail, result, duration_ms
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
def reusable_extractions(engine, keys):
    if not keys:
        return {}
    found = {}
    with engine.connect() as connection:
        for start in range(0, len(keys), 500):
            part = keys[start : start + 500]
            rows = (
                connection.execute(
                    select(graph_chunk_extractions)
                    .where(
                        graph_chunk_extractions.c.cache_key.in_(part),
                        graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                    )
                    .order_by(graph_chunk_extractions.c.created)
                )
                .mappings()
                .all()
            )
            for row in rows:
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


def enqueue(store, build_id):
    store.cache.rpush(QUEUE, json.dumps({"type": "graph", "build_id": build_id}))


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
    for step_id in ("graph_merge", "graph_write"):
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
    with store.engine.begin() as connection:
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
        {"build_id": build["id"], "error": message[:300]},
        duration_ms,
    )


# worker 处理一个建图任务：抽一批分片，还有剩下的就重新排队，全部抽完后合并实体、写入图谱。
def run_job(store, models, payload):
    build = get_build(store.engine, payload["build_id"])
    if build is None or build["status"] not in BUSY:
        logger.info("graph_job_skipped id=%s", payload.get("build_id"))
        return
    try:
        run_batch(store, models, build)
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
        results = {}
        if to_call:
            run_models = models_for(store, models, build)
            with ThreadPoolExecutor(max_workers=WORKERS) as executor:
                for item, result in zip(
                    to_call,
                    executor.map(
                        lambda item: extract_chunk(
                            run_models, schema, item, inputs["system_prompt"]
                        ),
                        to_call,
                    ),
                ):
                    results[item["chunk_id"]] = result
        timestamp = now()
        rows = []
        for item in batch:
            key = keys[item["chunk_id"]]
            base = {
                "id": str(uuid.uuid4()),
                "build_id": build["id"],
                "document_id": build["document_id"],
                "chunk_id": item["chunk_id"],
                "chunk_key": item["chunk_key"],
                "position": item["position"],
                "cache_key": key,
                "created": timestamp,
            }
            if key in reusable:
                source = reusable[key]
                rows.append(
                    {
                        **base,
                        "status": "reused",
                        "reused_from": source["id"],
                        "prompt": source["prompt"],
                        "raw_output": source["raw_output"],
                        "result": source["result"],
                        "error": None,
                        "input_tokens": None,
                        "output_tokens": None,
                        "duration_ms": None,
                    }
                )
            else:
                result = results[item["chunk_id"]]
                rows.append({**base, "reused_from": None, **result})
        with store.engine.begin() as connection:
            connection.execute(graph_chunk_extractions.insert(), rows)
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
    if len(items) > len(batch):
        enqueue(store, build["id"])
        return
    finalize(store, build)


# 全部分片抽完：按分片顺序合并实体、写入名字和关系；这份文档在空间里只保留这一次建图为 active。
def finalize(store, build):
    with store.engine.connect() as connection:
        value = counts(connection, build["id"])
        rows = (
            connection.execute(
                select(graph_chunk_extractions)
                .where(
                    graph_chunk_extractions.c.build_id == build["id"],
                    graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                )
                .order_by(graph_chunk_extractions.c.position)
            )
            .mappings()
            .all()
        )
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
                f"归到 {summary['entity_count']} 个实体（新建 {summary['created_count']} 个）；{methods}",
                {"build_id": build["id"], **summary},
                round((time.monotonic() - started) * 1000),
            )
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
        else:
            for pending in ("graph_merge", "graph_write"):
                write_step(
                    store,
                    build["document_id"],
                    pending,
                    "pending",
                    "未执行：全部分片都抽取失败",
                    {"build_id": build["id"]},
                )
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
                select(graph_builds.c.id).where(graph_builds.c.status.in_(BUSY))
            )
            .scalars()
            .all()
        )
    count = 0
    for build_id in ids:
        if build_id not in queued:
            enqueue(store, build_id)
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
