import json
import logging
import os
import time

from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import or_, select

from app.inspection.schedule import ScheduleRunner
from app.models import Models
from app.mysql.store import document_steps, documents
from app.storage import Storage
from app.ingestion.parser import extract_sections_cached, parse_metadata


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("production-rag-worker")
QUEUE = "ingest:jobs"
MAX_ATTEMPTS = 3
# context 是 Contextual Retrieval 新增的阶段（为分片生成上下文说明），排在切分之后、生成向量之前。
STAGE_ORDER = {"parsing": 2, "chunking": 3, "context": 4, "embedding": 5, "indexing": 6, "complete": 7}
STAGE_TITLES = {"parsing": "解析文档", "chunking": "切分文本", "context": "生成分片上下文", "embedding": "生成向量",
    "indexing": "写入检索索引", "complete": "完成导入"}
# 文档本身的问题（没有文字、格式不支持、文件不存在、向量维度配置错误），重试多少次结果都一样，直接标记失败。
PERMANENT_ERRORS = (ValueError, FileNotFoundError)


# 从 Redis 消费文档任务，解析后写入 Milvus；状态写入 MySQL。
def main():
    models = Models()
    store = Storage(models)
    try:
        recovered = recover_jobs(store)
        if recovered:
            logger.warning("jobs_recovered count=%s", recovered)
        # 定时巡检由 worker 负责：只有一个 worker，不会重复执行；到点后在后台线程跑，不耽误文档导入。
        inspection_schedule = ScheduleRunner(store, models)
        while True:
            try:
                inspection_schedule.tick()
            except Exception:
                logger.exception("inspection_schedule_check_failed")
            try:
                item = store.cache.blpop(QUEUE, timeout=2)
            except RedisTimeoutError:
                # Redis 客户端 socket 超时小于阻塞读取时，空队列会正常返回下一轮。
                continue
            if item is None:
                continue
            sync_llm_settings(store, models)
            payload = json.loads(item[1])
            # 补全上下文是对已完成版本的局部修补，和整份文档的导入分开处理。
            if payload.get("type") == "contexts":
                handle_context_job(store, models, payload)
            else:
                handle_job(store, models, payload)
    finally:
        store.close()


# 处理每个文档前读取设置页保存的模型配置。worker 是独立进程，API 里切换模型不会影响它；
# 原来 Contextual Retrieval 会一直用启动时 .env 里的模型，现在和 API 保持一致。
def sync_llm_settings(store, models):
    saved = store.load_llm_settings()
    if not saved:
        return
    if saved.get("updated") == getattr(models, "llm_settings_updated", None):
        return
    models.apply_llm(saved)
    models.llm_settings_updated = saved.get("updated")
    logger.info("llm_settings_applied provider=%s model=%s", saved.get("provider"), saved.get("model"))


# 启动时把被中断的任务重新放回队列，返回恢复的数量。
# 以前 blpop 取出任务的同时就把它从 Redis 删掉了，worker 在处理中途被杀（容器重启、重新构建）后，
# 任务不在队列里，MySQL 状态永远停在 processing，没有任何东西会继续它。
# 现在以 MySQL 的状态作为"完成日志"：queued 或 processing 开头的版本都还没处理完，
# 不在队列里的就重新投递。compose 里只有一个 worker，启动时不会有别的 worker 正在处理，
# 所以 processing 状态一定是上次被中断留下的；以后扩成多个 worker 需要改成按心跳超时判断。
def recover_jobs(store):
    queued_ids = set()
    for raw in store.cache.lrange(QUEUE, 0, -1):
        queued_ids.add(json.loads(raw)["document_id"])
    with store.engine.connect() as connection:
        rows = connection.execute(select(documents).where(or_(
            documents.c.status == "queued", documents.c.status.like("processing%")))).mappings().all()
    recovered = 0
    for row in rows:
        if row["id"] in queued_ids:
            continue
        # 同步导入接口（POST /documents）没有原文件，只能在请求里处理；
        # 中断后无法由 worker 重做，标记失败并清理写了一半的数据，由用户重新导入。
        if not row["path"]:
            store.remove_version_data(row["id"])
            store.mysql.update_document(row["id"], "failed", "导入被中断，请重新导入")
            continue
        store.cache.rpush(QUEUE, json.dumps({"document_id": row["id"], "owner": row["owner"],
            "title": row["title"], "path": row["path"], "doc_key": row["doc_key"] or row["id"]}))
        recovered += 1
    # 补全上下文的任务中断后，"生成分片上下文"步骤会一直停在进行中，重新投递一次。
    with store.engine.connect() as connection:
        pending_contexts = connection.execute(select(documents).select_from(
            document_steps.join(documents, documents.c.id == document_steps.c.document_id)).where(
            document_steps.c.step_id == "context", document_steps.c.status == "running",
            documents.c.status.like("ready%"))).mappings().all()
    for row in pending_contexts:
        if row["id"] in queued_ids:
            continue
        store.cache.rpush(QUEUE, json.dumps({"type": "contexts", "document_id": row["id"], "path": row["path"]}))
        recovered += 1
    return recovered


# 为已完成版本里上下文生成失败的分片补生成说明，结果写回"生成分片上下文"这一步。
# 失败时不影响文档本身：版本继续服务，步骤恢复成完成状态并写明补全失败的原因，可以再次点击补全。
def handle_context_job(store, models, payload):
    document_id = payload["document_id"]
    started = time.monotonic()
    with store.engine.connect() as connection:
        row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
    if row is None or not row["status"].startswith("ready"):
        logger.info("context_job_skipped id=%s", document_id)
        return
    order = STAGE_ORDER["context"]
    title = STAGE_TITLES["context"]
    try:
        # 全文要和导入时一致，才能让分片分到同一段原文；解析缓存命中时不会重新解析。
        cache_dir = os.path.join(os.getenv("UPLOAD_DIR", "./uploads"), ".parse_cache")
        sections, _, _ = extract_sections_cached(row["path"], cache_dir)
        content = "\n\n".join(section["text"] for section in sections)
        missing, generated, failed, total = store.retry_failed_contexts(models, document_id, content)
        store.mysql.update_document_step(document_id, "context", order, "context", title, "completed",
            f"已为 {total} 个分片生成上下文说明，失败 {failed} 个（本次补全 {generated} / {missing} 个）",
            {"generated_count": total, "failed_count": failed, "retried_count": generated},
            round((time.monotonic() - started) * 1000))
        logger.info("context_job_done id=%s missing=%s generated=%s failed=%s", document_id, missing, generated, failed)
    except Exception as error:
        logger.exception("context_job_failed id=%s", document_id)
        metadata_value = row["document_metadata"] or {}
        store.mysql.update_document_step(document_id, "context", order, "context", title, "completed",
            f"补全失败：{str(error)[:300]}",
            {"generated_count": metadata_value.get("context_generated", 0),
                "failed_count": metadata_value.get("context_failed", 0), "error": str(error)[:300]}, None)


# 处理一个任务：暂时性错误（Milvus 或向量服务连不上、超时）最多尝试 MAX_ATTEMPTS 次，
# 文档本身的错误直接标记失败。以前任何异常都立即标记失败，服务抖动一下就要用户手动重新上传。
def handle_job(store, models, payload):
    document_id = payload["document_id"]
    # 同一个版本可能被投递两次（例如恢复时它正好也在别处排队），已经处理完或已被删除的直接跳过，
    # 避免重复处理把已经生效的版本数据删掉重写。
    with store.engine.connect() as connection:
        status = connection.execute(select(documents.c.status).where(
            documents.c.id == document_id)).scalar_one_or_none()
    if status is None or not (status == "queued" or status.startswith("processing")):
        logger.info("job_skipped id=%s status=%s", document_id, status)
        return
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        stage = {"current": "parsing", "attempt": attempt, "last_error": last_error}
        try:
            # 每次尝试前清掉本版本可能残留的数据：上次中断或失败时可能已写了一部分分片，
            # 不清理的话重新写 MySQL 分片会主键冲突。本版本还没生效，删掉不影响检索。
            store.remove_version_data(document_id)
            # 每次尝试开始都清掉解析及之后的旧步骤。以前只在同一任务内重试时清理，
            # worker 重启后恢复的任务仍会显示上一轮的"切分完成""生成向量失败"，和正在解析的当前状态矛盾。
            store.mysql.clear_document_steps(document_id, STAGE_ORDER["parsing"])
            process_document(store, models, payload, stage)
            return
        except Exception as error:
            # 切换当前版本之后才出错（例如写"完成"步骤时 MySQL 断开），版本已经生效，
            # 不能再按失败处理：清理数据会把正在服务的版本删掉。
            if stage.get("activated"):
                logger.exception("document_after_activate_failed id=%s", document_id)
                return
            message = str(error)[:500]
            retry = attempt < MAX_ATTEMPTS and not isinstance(error, PERMANENT_ERRORS)
            if retry:
                wait = 2 ** attempt
                message = f"第 {attempt} 次尝试失败，{wait} 秒后重试：{message}"[:500]
            store.mysql.update_document_step(document_id, stage["current"], STAGE_ORDER[stage["current"]],
                stage["current"], STAGE_TITLES[stage["current"]], "failed", message, {"error": message}, None)
            try:
                store.remove_version_data(document_id)
            except Exception:
                logger.exception("failed_version_cleanup_failed id=%s", document_id)
            if not retry:
                # 失败版本从未成为当前版本，旧版本不受影响。
                store.mysql.update_document(document_id, "failed", str(error)[:500])
                logger.exception("document_failed id=%s attempt=%s", document_id, attempt)
                return
            logger.warning("document_retry id=%s attempt=%s error=%s", document_id, attempt, error)
            # 失败原因写进下一次尝试的解析步骤说明里；旧步骤在下一次尝试开始时统一清理。
            last_error = f"{STAGE_TITLES[stage['current']]}失败：{str(error)[:200]}"
            # 只有一个 worker，等待期间其他任务也要等；间隔只有几秒，换来的是不用引入延迟队列。
            time.sleep(wait)


# 解析、切分、向量化并写入一个文档版本，全部完成后切换为当前版本。
# stage["current"] 记录正在执行的阶段，失败时用来标记是哪一步出错。
def process_document(store, models, payload, stage):
    document_id = payload["document_id"]
    stage_started = {}

    def update_stage(name, status, detail, result=None):
        stage["current"] = name
        if status == "running":
            stage_started[name] = time.monotonic()
        duration_ms = None
        if status == "completed" and name in stage_started:
            duration_ms = round((time.monotonic() - stage_started[name]) * 1000)
        store.mysql.update_document_step(document_id, name, STAGE_ORDER[name], name, STAGE_TITLES[name],
            status, detail, result, duration_ms)
        if status == "running":
            store.mysql.update_document(document_id, f"processing:{name}")

    processing_started = time.monotonic()
    parse_started = time.monotonic()
    detail = "正在根据文件格式提取文本"
    if stage.get("last_error"):
        detail = f"第 {stage['attempt']} 次尝试（上次{stage['last_error']}），{detail}"
    update_stage("parsing", "running", detail)
    # 解析结果缓存在上传目录下（api 和 worker 共用的卷），重试或重启后同一文件不再重新解析。
    cache_dir = os.path.join(os.getenv("UPLOAD_DIR", "./uploads"), ".parse_cache")
    sections, stats, parse_cached = extract_sections_cached(payload["path"], cache_dir)
    content = "\n\n".join(section["text"] for section in sections)
    if not content.strip():
        raise ValueError("文档没有可提取的文本")
    parse_result = parse_metadata(payload["path"], sections, stats=stats)
    parse_result["parse_duration_ms"] = round((time.monotonic() - parse_started) * 1000)
    parse_result["parse_cached"] = parse_cached
    store.mysql.update_document_metadata(document_id, parse_result)
    update_stage("parsing", "completed", "文本提取完成（使用缓存的解析结果）" if parse_cached else "文本提取完成", {
        "parse_cached": parse_cached,
        "characters": len(content), "sections": len(sections),
        "extension": os.path.splitext(payload["path"])[1].lower(),
        "parser": parse_result["parser"], "parser_version": parse_result["parser_version"],
        "parse_strategy": parse_result["parse_strategy"],
        "page_count": parse_result["page_count"],
        "empty_pages": len(parse_result["empty_pages"] or []),
        "heading_detected": parse_result["heading_detected"],
        "parse_duration_ms": parse_result["parse_duration_ms"]})
    update_stage("chunking", "running", "正在切分文本并生成重叠片段")
    # 旧任务可能没有 doc_key，此时版本本身就是一份新文档。
    doc_key = payload.get("doc_key") or document_id
    chunks = store.ingest(payload["owner"], payload["title"], content, models,
        document_id, doc_key, on_stage=update_stage, sections=sections,
        source_format=os.path.splitext(payload["path"])[1].lower())
    store.mysql.update_document_metadata(document_id, {
        "processing_duration_ms": round((time.monotonic() - processing_started) * 1000)})
    # 全部写完才切换当前版本；切换之前新版本对检索不可见，旧版本一直在服务。
    activated, previous = store.activate_version(document_id, chunks)
    stage["activated"] = True
    detail = "文档已完成解析、向量化和索引，并设为当前版本" if activated else \
        "文档已处理完成，但已有更新的版本在服务，本版本不再生效"
    update_stage("complete", "completed", detail, {
        "chunks": chunks, "collection": store.collection,
        "activated": activated, "superseded_document_id": previous})
    logger.info("document_ready id=%s chunks=%s activated=%s", document_id, chunks, activated)


if __name__ == "__main__":
    main()
