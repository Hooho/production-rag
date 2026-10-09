import json
import logging
import os
import time

from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import or_, select

from app.inspection.schedule import ScheduleRunner
from app.models import Models
from app.document_reviews import ReviewError, finish_version, list_version, scan_version
from app.security_model import InjectionModel
from app.mysql.store import document_steps, documents
from app.storage import Storage
from app.ingestion.parser import extract_sections_cached, parse_metadata


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("production-rag-worker")
QUEUE = "ingest:jobs"
MAX_ATTEMPTS = 3
# context 是 Contextual Retrieval 新增的阶段（为分片生成上下文说明），排在切分之后、生成向量之前。
# scan：写完索引、切换当前版本之前扫描注入（规则 + 注入检测模型），结果决定直接生效还是先交给管理员审核。
# verify：写完索引后核对 MySQL、Milvus 两边的分片数和应写的一致，对不上就当场按暂时性错误重试这一版。
STAGE_ORDER = {"parsing": 2, "chunking": 3, "context": 4, "embedding": 5, "indexing": 6, "verify": 7, "scan": 8, "complete": 9}
STAGE_TITLES = {"parsing": "解析文档", "chunking": "切分文本", "context": "生成分片上下文", "embedding": "生成向量",
    "indexing": "写入检索索引", "verify": "写入校验", "scan": "安全扫描", "complete": "完成导入"}
# 写入校验发现两个库的分片数对不上。属于暂时性错误：清掉这一版重写一遍通常就好了。
class WriteMismatch(RuntimeError):
    pass


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


# 跨用户复制：上传的文件和当前用户能看到的某份已处理文档（别人公开的、共享给我部门的）内容完全相同时，
# 直接复制它的解析结果、分片、上下文说明和向量，跳过解析、切分、上下文和向量计算；之后照常写入校验、安全扫描。
# 来源在排队期间被删、被改，或者数据不完整，返回 None，调用方按正常流程处理。
def copy_from_source(store, models, payload, update_stage):
    source_id = payload.get("copy_from")
    if not source_id:
        return None
    document_id = payload["document_id"]
    if store.find_copy_source(payload["owner"], payload.get("content_sha256"), models) != source_id:
        return None
    with store.engine.connect() as connection:
        source = connection.execute(select(documents.c.title, documents.c.document_metadata).where(
            documents.c.id == source_id)).first()
    if source is None:
        return None
    update_stage("parsing", "running", "内容和一份你能看到的已处理文档完全相同，正在复制它的处理结果")
    try:
        chunks = store.copy_version(source_id, document_id, payload.get("doc_key") or document_id,
            payload["owner"], payload["title"])
    except ValueError as error:
        logger.warning("document_copy_failed id=%s source=%s error=%s", document_id, source_id, error)
        store.remove_version_data(document_id)
        return None
    # 解析结果（解析器、页数、表格识别等）和处理设置一起带过来；文件大小、哈希用这次上传自己的。
    skipped = {"mime_type", "file_size_bytes", "sha256", "injection_scan", "processing_duration_ms"}
    metadata = {key: value for key, value in (source[1] or {}).items() if key not in skipped}
    metadata.update({"copied_from": source_id, "reused_vectors": chunks, "embedded_vectors": 0})
    store.mysql.update_document_metadata(document_id, metadata)
    update_stage("parsing", "completed", f"内容和《{source[0]}》完全相同，复制它已处理好的 {chunks} 个分片，"
        "跳过解析、切分、生成上下文和生成向量", {"copied_from": source[0], "chunks": chunks})
    update_stage("indexing", "completed", "向量、全文索引和分片均已写入（复制）", {"milvus_count": chunks, "keyword_count": chunks})
    return chunks


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
        if status in ("completed", "warning") and name in stage_started:
            duration_ms = round((time.monotonic() - stage_started[name]) * 1000)
        store.mysql.update_document_step(document_id, name, STAGE_ORDER[name], name, STAGE_TITLES[name],
            status, detail, result, duration_ms)
        if status == "running":
            store.mysql.update_document(document_id, f"processing:{name}")

    processing_started = time.monotonic()
    doc_key = payload.get("doc_key") or document_id
    chunks = copy_from_source(store, models, payload, update_stage)
    if chunks is None:
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
    # 写入校验：两个库没法放进同一个事务，写完逐个核对分片数。对不上时先等一下再查一次（排除刚写完还没可见），
    # 仍然对不上就抛出 WriteMismatch：外层按暂时性错误处理，清掉这一版写了一半的数据，从头重试，最多 MAX_ATTEMPTS 次。
    update_stage("verify", "running", "正在核对 MySQL 和 Milvus 里的分片数")
    counts = store.version_counts(document_id)
    if counts["mysql"] != chunks or counts["milvus"] != chunks:
        time.sleep(1)
        counts = store.version_counts(document_id)
    result = {"expected": chunks, "mysql_count": counts["mysql"], "milvus_rows": counts["milvus"]}
    if counts["mysql"] != chunks or counts["milvus"] != chunks:
        missing = [f"{name} 少了 {chunks - counts[key]} 个" for key, name in (("mysql", "MySQL"), ("milvus", "Milvus"))
            if counts[key] != chunks]
        raise WriteMismatch(f"写入不完整：应写 {chunks} 个分片，{'，'.join(missing)}")
    update_stage("verify", "completed", f"MySQL {chunks} / {chunks}，Milvus {chunks} / {chunks}，两边都已保存", result)
    # 安全扫描：规则逐片检查，注入检测模型逐片打分。模型不可用时只用规则，原因写在这一步的结果里。
    update_stage("scan", "running", "正在用规则和注入检测模型检查每个分片")
    scan = scan_version(store, document_id, InjectionModel())
    hits = scan["rule_hits"] + scan["model_hits"]
    model_note = f"模型没参与：{scan['model_error']}" if scan.get("model_error") else \
        scan["model"] if scan.get("model") else "没有部署注入检测模型，只用规则"
    positions = "、".join(f"第 {position} 片" for position in sorted({hit["position"] for hit in scan["hits"]})[:5])
    # 有命中时这一步记为 warning（页面上标红）：步骤本身跑完了，但结果有问题；不用 failed，failed 表示处理出错、会出现重试按钮。
    update_stage("scan", "warning" if hits else "completed",
        f"检测到疑似注入指令，在{positions}，这一版不能上架" if hits else "没有发现疑似注入指令", {
        "checked": scan["checked"], "rule_hits": scan["rule_hits"], "model_hits": scan["model_hits"],
        "scan_model": model_note})
    # 处理完不直接生效：没问题的停在「待上架」，上传者确认后上架；有问题的不能上架，提醒上传者处理。
    # 旧版本在这期间继续服务。见 app/document_reviews.py。
    finished = finish_version(store, document_id, chunks, scan=scan)
    # 之后再出错也不能按失败清理数据：这一版已经处理完。
    stage["activated"] = True
    # 扫描没问题的默认直接上架（公开文档的新版本，上传者不是管理员时会交给管理员审核）；有问题的停下来等上传者处理。
    status = finished["status"]
    if status == "staged":
        try:
            status = {"listed": "listed", "review": "review"}[list_version(store, document_id, payload["owner"])["state"]]
        except ReviewError as error:
            logger.warning("document_auto_list_failed id=%s error=%s", document_id, error.message)
    details = {"staged": "处理完成，等待上架：在文档详情里确认后点「上架」，上架后才会被检索到",
        "listed": "文档已完成解析、向量化和索引，安全扫描没有问题，已上架",
        "review": "安全扫描没有问题。这是公开文档的新版本，已交给管理员审核，通过后替换当前版本",
        "flagged": "安全扫描发现疑似注入指令，不能上架。请在文档详情里查看有问题的分片，改好后重新上传，或者写明情况提交管理员审核",
        "superseded": "处理完成，但已经有更新的版本，本版本不再生效",
        "current": "当前版本已重建完成"}
    update_stage("complete", "completed", details[status], {"chunks": chunks,
        "collection": store.collection, "listing": {"staged": "待上架", "listed": "已上架", "review": "待管理员审核",
            "flagged": "有问题，不能上架", "superseded": "已被更新的版本取代", "current": "当前版本"}[status]})
    logger.info("document_processed id=%s chunks=%s status=%s", document_id, chunks, status)


if __name__ == "__main__":
    main()
