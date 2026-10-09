# 文档上架和审核（表结构见 app/mysql/tables.py 的 document_heads.listed 和 document_reviews）。
#
# 每个新版本解析、向量化、写完索引后先做安全扫描（规则逐片检查 + 注入检测模型逐片打分），然后停在下面两种状态之一：
# - staged:N  待上架。扫描没问题；worker 和接口导入默认马上替它上架（公开文档的新版本交给管理员审核），
#             自动上架没成功或接口指定不上架时停在这里，上传者自己点「上架」。
# - flagged:N 有问题。扫描发现疑似注入指令，不能上架。上传者在文档详情里看到哪几片有问题、原文哪里命中，
#             可以改好后重新上传，或者写明情况（例如这是一篇讲提示注入的文章）提交管理员审核。
# 上架后的文档可以下架（document_heads.listed = false）：当前版本保留，但谁都检索不到，包括上传者自己；
# 下架后再上架不需要重新扫描，当前版本当初已经扫描或审核过。
#
# 需要管理员审核的情况（document_reviews.kind）：
# - publish：普通用户申请公开。公开文档会进入所有人的检索结果，里面藏的注入指令会影响所有人。
#            通过之前可见范围保持原样，通过后改成所有人可见。
# - version：已公开的文档上架新版本（上传者不是管理员）。否则审核过一次，之后就能把内容整个换掉。
# - flagged：扫描有问题的版本，上传者说明情况后提交。通过后上架，不通过就清理这一版的数据。
# 等管理员审核的版本状态是 review:N，没通过的是 rejected。
# 管理员上传的文档不需要审核；扫描有问题时管理员看过可以直接上架，但要写备注说明为什么没问题，
# 备注记成一条管理员自己通过的审核记录（kind=flagged），之后能在「文档审核 › 已处理」里查到是谁、为什么上架的。
# 升级前已有的文档都视为已上架，不补扫；之后上传的版本都按上面的流程走。
from datetime import datetime, timezone
import logging
import uuid

from sqlalchemy import func, select

from .mysql.store import chunks, document_chunks, document_heads, document_permissions, document_reviews, documents, users
from .runtime_config import value as runtime_value
from .security import detect_injection, injection_spans


logger = logging.getLogger("production-rag")

STAGED = "staged:"
FLAGGED = "flagged:"
REVIEW_PREFIX = "review:"
REJECTED = "rejected"
# 处理完、还没成为当前版本、数据要保留的几种状态。
HELD_PREFIXES = (STAGED, FLAGGED, REVIEW_PREFIX)
KINDS = {"publish": "申请公开", "version": "公开文档的新版本", "flagged": "扫描有问题，上传者说明后提交",
    "share": "共享文档发现可疑内容"}
# 审核的是某一个版本（通过后上架这一版）的几种；share 是早期的类型，保留以便显示旧记录。
VERSION_KINDS = ("version", "flagged", "share")
STATUSES = {"pending": "待审核", "approved": "已通过", "rejected": "未通过", "cancelled": "已撤回", "superseded": "已被新版本取代"}
# 扫描结果里最多保存这么多条命中，整份文档都会检查。
HIT_LIMIT = 50


class ReviewError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now():
    return datetime.now(timezone.utc).isoformat()


def is_admin(connection, username):
    return bool(connection.execute(select(users.c.is_admin).where(users.c.username == username)).scalar_one_or_none())


def user_is_admin(store, username):
    with store.engine.connect() as connection:
        return is_admin(connection, username)


def is_held(status):
    return bool(status) and status.startswith(HELD_PREFIXES)


def chunk_count_of(status):
    try:
        return int(status.split(":", 1)[1])
    except (IndexError, ValueError):
        return 0


def review_view(row):
    if row is None:
        return None
    item = dict(row)
    item["kind_label"] = KINDS.get(item["kind"], item["kind"])
    item["status_label"] = STATUSES.get(item["status"], item["status"])
    return item


def pending_review(connection, doc_key, kind):
    return connection.execute(select(document_reviews).where(document_reviews.c.doc_key == doc_key,
        document_reviews.c.kind == kind, document_reviews.c.status == "pending")).mappings().first()


def visibility_of(connection, doc_key):
    return connection.execute(select(document_permissions.c.visibility).where(
        document_permissions.c.doc_key == doc_key)).scalar_one_or_none() or "private"


# ---------- 公开申请 ----------

# 普通用户申请公开。已经有待审核的申请时直接返回它，不重复提交。
# document_id 记录申请时的版本：还没上架的新文档用它自己，已有当前版本的用当前版本。
def request_publish(store, doc_key, document_id, username):
    with store.engine.begin() as connection:
        existing = pending_review(connection, doc_key, "publish")
        if existing is not None:
            return review_view(existing)
        head = connection.execute(select(document_heads).where(document_heads.c.doc_key == doc_key)).mappings().first()
        target = head["current_document_id"] if head else document_id
        version = connection.execute(select(documents.c.version).where(documents.c.id == target)).scalar_one_or_none()
        row = {"id": str(uuid.uuid4()), "doc_key": doc_key, "kind": "publish", "document_id": target,
            "version": version or 1, "chunk_count": None, "status": "pending", "requested_by": username,
            "created": now(), "reviewed_by": None, "reviewed": None, "note": None, "request_note": None}
        connection.execute(document_reviews.insert().values(**row))
    return review_view(row)


# 上传者把可见范围改成别的（或改回原来的），撤回还没审核的公开申请。
def cancel_publish(store, doc_key, username):
    with store.engine.begin() as connection:
        connection.execute(document_reviews.update().where(document_reviews.c.doc_key == doc_key,
            document_reviews.c.kind == "publish", document_reviews.c.status == "pending").values(
                status="cancelled", reviewed_by=username, reviewed=now(), note="上传者修改了可见范围，撤回申请"))


# 每份文档最近一次公开申请的结果，供上传者看到「审核中」或「没通过及原因」；通过或撤回的不再提示。
def publish_states(store, doc_keys):
    if not doc_keys:
        return {}
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_reviews).where(document_reviews.c.doc_key.in_(list(doc_keys)),
            document_reviews.c.kind == "publish").order_by(document_reviews.c.created.desc())).mappings().all()
    states = {}
    for row in rows:
        if row["doc_key"] in states:
            continue
        states[row["doc_key"]] = review_view(row) if row["status"] in ("pending", "rejected") else None
    return states


# ---------- 安全扫描 ----------

def scan_hit_count(scan):
    return (scan.get("rule_hits") or 0) + (scan.get("model_hits") or 0)


def version_chunks(connection, document_id):
    return connection.execute(select(chunks.c.id, chunks.c.content, chunks.c.text, document_chunks.c.chunk_metadata).select_from(
        document_chunks.join(chunks, chunks.c.id == document_chunks.c.chunk_id)).where(
            document_chunks.c.document_id == document_id).order_by(document_chunks.c.position, chunks.c.id)).mappings().all()


# 扫描一个版本的全部分片：规则逐片检查；注入检测模型可用并且开启时逐片打分，超过阈值算命中。
# 模型没部署、没加载好或调用失败时只用规则，错误写进结果，不影响导入。
def scan_version(store, document_id, guard=None):
    with store.engine.connect() as connection:
        rows = version_chunks(connection, document_id)
    texts = [row["content"] or row["text"] or "" for row in rows]
    hits = []
    rule_hits = 0
    for index, text in enumerate(texts, start=1):
        for hit in detect_injection(text):
            rule_hits += 1
            hits.append({"position": index, "source": "rule", "rule": hit["rule"], "text": hit["text"]})
    result = {"checked": len(texts), "rule_hits": rule_hits, "model_hits": 0, "model": None, "model_error": None,
        "threshold": None, "scanned": now()}
    if guard is not None and guard.deployed() and texts and runtime_value("injection_model_enabled"):
        threshold = runtime_value("injection_model_threshold")
        result["threshold"] = threshold
        try:
            scores, result["model"] = guard.score_many(texts)
            for index, (text, score) in enumerate(zip(texts, scores), start=1):
                if score >= threshold:
                    result["model_hits"] += 1
                    hits.append({"position": index, "source": "model", "rule": "model_judged",
                        "text": " ".join(text.split())[:100], "score": round(score, 4)})
        except Exception as error:
            logger.warning("ingest_scan_model_failed document_id=%s error=%s", document_id, error)
            result["model_error"] = f"{type(error).__name__}: {str(error)[:200]}"
    hits.sort(key=lambda hit: hit["position"])
    result["hits"] = hits[:HIT_LIMIT]
    return result


# 有问题的分片和原文：规则命中的位置（start/end 是在分片正文里的字符位置，前端据此标出来），
# 模型判断为攻击的分片标出攻击概率（模型看整段，没有具体位置）。只返回有问题的分片。
def problem_chunks(store, document_id):
    with store.engine.connect() as connection:
        row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
        if row is None:
            return None
        rows = version_chunks(connection, document_id)
    scan = (row["document_metadata"] or {}).get("injection_scan")
    model_scores = {hit["position"]: hit.get("score") for hit in (scan or {}).get("hits", []) if hit.get("source") == "model"}
    items = []
    for index, chunk in enumerate(rows, start=1):
        content = chunk["content"] or chunk["text"] or ""
        spans = injection_spans(content)
        if not spans and index not in model_scores:
            continue
        metadata = chunk["chunk_metadata"] or {}
        items.append({"position": index, "chunk_id": chunk["id"], "content": content, "spans": spans,
            "model_score": model_scores.get(index), "heading_path": metadata.get("heading_path") or [],
            "page_start": metadata.get("page_start"), "page_end": metadata.get("page_end")})
    return {"document_id": document_id, "status": row["status"], "scan": scan, "chunks": items}


# ---------- 版本：处理完先停下，上架才生效 ----------

# 一个版本写完以后调用（worker 和同步导入都用）：扫描，然后停在 staged:N（待上架）或 flagged:N（有问题）。
# 同一文档只保留最新的一个待处理版本：比它旧的待上架、有问题、待审核版本标记为被取代并清理数据，
# 已经有更新的版本在等时，这一版直接被取代。返回 {"status": "staged" | "flagged" | "superseded", "scan"}。
def finish_version(store, document_id, chunk_count, guard=None, scan=None):
    if scan is None:
        scan = scan_version(store, document_id, guard)
    store.mysql.update_document_metadata(document_id, {"injection_scan": scan})
    state = "flagged" if scan_hit_count(scan) else "staged"
    # 对账脚本把数据不完整的当前版本交给 worker 重建：它本来就是当前版本，重建完直接恢复，不用重新上架。
    with store.engine.connect() as connection:
        row = connection.execute(select(documents.c.doc_key).where(documents.c.id == document_id)).first()
        current = connection.execute(select(document_heads.c.current_document_id).where(
            document_heads.c.doc_key == ((row[0] if row else None) or document_id))).scalar_one_or_none()
    if current == document_id:
        store.activate_version(document_id, chunk_count)
        return {"status": "current", "scan": scan}
    stale = []
    timestamp = now()
    with store.engine.begin() as connection:
        row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
        doc_key = row["doc_key"] or row["id"]
        version = row["version"] or 1
        held = [item for item in connection.execute(select(documents.c.id, documents.c.version, documents.c.status).where(
            documents.c.doc_key == doc_key, documents.c.id != document_id)).mappings().all() if is_held(item["status"])]
        if any((item["version"] or 0) > version for item in held):
            state = "superseded"
            connection.execute(documents.update().where(documents.c.id == document_id).values(
                status="superseded", updated=timestamp))
            stale.append(document_id)
        else:
            for item in held:
                connection.execute(documents.update().where(documents.c.id == item["id"]).values(
                    status="superseded", updated=timestamp))
                connection.execute(document_reviews.update().where(document_reviews.c.document_id == item["id"],
                    document_reviews.c.status == "pending").values(status="superseded", reviewed=timestamp,
                        note=f"上传了更新的第 {version} 版"))
                stale.append(item["id"])
            prefix = FLAGGED if state == "flagged" else STAGED
            connection.execute(documents.update().where(documents.c.id == document_id).values(
                status=f"{prefix}{chunk_count}", error=None, updated=timestamp))
    # 和切换版本一样，状态提交以后再回收存储；清理失败只记日志，对账脚本会把残留数据找出来。
    for stale_id in stale:
        try:
            store.remove_version_data(stale_id)
        except Exception:
            logger.exception("review_cleanup_failed document_id=%s", stale_id)
    return {"status": state, "scan": scan}


def set_listed(store, doc_key, listed):
    with store.engine.begin() as connection:
        connection.execute(document_heads.update().where(document_heads.c.doc_key == doc_key).values(
            listed=listed, updated=now()))


# 上架这一版：切换为当前版本，文档设为上架。
def activate_and_list(store, document_id, chunk_count):
    activated, previous = store.activate_version(document_id, chunk_count)
    with store.engine.connect() as connection:
        doc_key = connection.execute(select(documents.c.doc_key).where(documents.c.id == document_id)).scalar_one() \
            or document_id
    if activated:
        set_listed(store, doc_key, True)
    return activated, previous


# 把一个版本交给管理员审核，状态改成 review:N。
def submit_version(store, row, kind, username, request_note=None):
    timestamp = now()
    count = chunk_count_of(row["status"])
    review = {"id": str(uuid.uuid4()), "doc_key": row["doc_key"] or row["id"], "kind": kind, "document_id": row["id"],
        "version": row["version"] or 1, "chunk_count": count, "status": "pending", "requested_by": username,
        "created": timestamp, "reviewed_by": None, "reviewed": None, "note": None, "request_note": request_note}
    with store.engine.begin() as connection:
        result = connection.execute(documents.update().where(documents.c.id == row["id"],
            documents.c.status == row["status"]).values(status=f"{REVIEW_PREFIX}{count}", updated=timestamp))
        if result.rowcount != 1:
            raise ReviewError(409, "这一版的状态已经变了，请刷新后再操作")
        connection.execute(document_reviews.insert().values(**review))
    return review_view(review)


# 上传者点「上架」。document_id 是要上架的版本：
# - 待上架的版本：公开文档（上传者不是管理员）交给管理员审核，其余直接切换为当前版本并上架；
# - 有问题的版本：管理员可以直接上架，普通用户不行，要提交审核；
# - 已经是当前版本、文档下架了：重新上架（当初已经扫描或审核过，不用重来）。
# 返回 {"state": "listed" | "review", "review"}。
def list_version(store, document_id, username, note=None):
    with store.engine.connect() as connection:
        row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
        if row is None:
            raise ReviewError(404, "文档不存在")
        doc_key = row["doc_key"] or row["id"]
        head = connection.execute(select(document_heads).where(document_heads.c.doc_key == doc_key)).mappings().first()
        admin = is_admin(connection, username)
        visibility = visibility_of(connection, doc_key)
    status = row["status"]
    if head is not None and head["current_document_id"] == document_id:
        if head["listed"]:
            raise ReviewError(409, "文档已经上架了")
        set_listed(store, doc_key, True)
        return {"state": "listed", "review": None}
    if status.startswith(FLAGGED) and not admin:
        raise ReviewError(409, "安全扫描发现疑似注入指令，不能直接上架。请改好后重新上传，或者写明情况提交管理员审核。")
    if status.startswith(FLAGGED):
        note = (note or "").strip()
        if not note:
            raise ReviewError(409, "这一版安全扫描有问题，直接上架需要填写备注，说明为什么没问题。")
        record_self_approval(store, row, username, note)
    if status.startswith(STAGED) or status.startswith(FLAGGED):
        if visibility == "public" and not admin:
            return {"state": "review", "review": submit_version(store, row, "version", username)}
        activate_and_list(store, document_id, chunk_count_of(status))
        return {"state": "listed", "review": None}
    if status.startswith(REVIEW_PREFIX):
        raise ReviewError(409, "这一版正在等管理员审核")
    raise ReviewError(409, "这一版不能上架")


# 管理员直接上架扫描有问题的版本：记一条自己提交、自己通过的审核记录，留下备注。
def record_self_approval(store, row, username, note):
    timestamp = now()
    with store.engine.begin() as connection:
        connection.execute(document_reviews.insert().values(id=str(uuid.uuid4()), doc_key=row["doc_key"] or row["id"],
            kind="flagged", document_id=row["id"], version=row["version"] or 1, chunk_count=chunk_count_of(row["status"]),
            status="approved", requested_by=username, created=timestamp, reviewed_by=username, reviewed=timestamp,
            note="管理员确认没问题，直接上架", request_note=note[:500]))


# 有问题的版本，上传者写明情况后提交管理员审核。
def submit_flagged(store, document_id, username, note):
    with store.engine.connect() as connection:
        row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
    if row is None:
        raise ReviewError(404, "文档不存在")
    if not row["status"].startswith(FLAGGED):
        raise ReviewError(409, "只有安全扫描有问题的版本需要提交审核")
    return submit_version(store, row, "flagged", username, note)


# 下架：当前版本保留，谁都检索不到。
def unlist(store, doc_key):
    with store.engine.connect() as connection:
        head = connection.execute(select(document_heads).where(document_heads.c.doc_key == doc_key)).mappings().first()
    if head is None or not head["listed"]:
        raise ReviewError(409, "文档没有上架")
    set_listed(store, doc_key, False)


# 文档改成仅自己可见：因为「公开文档的新版本」在等审核的版本不需要再审了，退回待上架，上传者自己上架；
# 扫描有问题提交的审核不受影响，仍然要管理员看。
def release_versions(store, doc_key, username):
    timestamp = now()
    with store.engine.begin() as connection:
        pending = connection.execute(select(document_reviews).where(document_reviews.c.doc_key == doc_key,
            document_reviews.c.kind == "version", document_reviews.c.status == "pending")).mappings().all()
        for item in pending:
            connection.execute(document_reviews.update().where(document_reviews.c.id == item["id"]).values(
                status="cancelled", reviewed_by=username, reviewed=timestamp, note="文档改成仅自己可见，退回待上架"))
            connection.execute(documents.update().where(documents.c.id == item["document_id"],
                documents.c.status.like(f"{REVIEW_PREFIX}%")).values(
                    status=f"{STAGED}{item['chunk_count'] or 0}", updated=timestamp))


# 文档的上架状态：listed 已上架、unlisted 已下架、never 还没有上架过（没有当前版本）。
def listing_states(store, doc_keys):
    if not doc_keys:
        return {}
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_heads.c.doc_key, document_heads.c.listed).where(
            document_heads.c.doc_key.in_(list(doc_keys)))).all()
    states = {doc_key: "never" for doc_key in doc_keys}
    for doc_key, listed in rows:
        states[doc_key] = "listed" if listed else "unlisted"
    return states


# ---------- 管理员审核 ----------

# 审核要看的版本：版本类审核看提交的那一版；publish 审核看现在的当前版本（申请之后可能又更新过）。
def review_target(connection, review):
    if review["kind"] in VERSION_KINDS:
        return review["document_id"]
    return connection.execute(select(document_heads.c.current_document_id).where(
        document_heads.c.doc_key == review["doc_key"])).scalar_one_or_none()


# 审核列表：status=pending 看待审核的，done 看处理过的（最近 100 条）。带上文档标题、上传者和当前可见范围。
def list_reviews(store, status="pending", limit=100):
    condition = document_reviews.c.status == "pending" if status == "pending" else document_reviews.c.status != "pending"
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_reviews, documents.c.title, documents.c.owner,
            documents.c.filename, document_permissions.c.visibility).select_from(document_reviews.join(
                documents, documents.c.id == document_reviews.c.document_id).outerjoin(
                document_permissions, document_permissions.c.doc_key == document_reviews.c.doc_key)).where(
                condition).order_by(document_reviews.c.created.desc()).limit(limit)).mappings().all()
        pending = connection.execute(select(func.count()).select_from(document_reviews).where(
            document_reviews.c.status == "pending")).scalar_one()
    items = []
    for row in rows:
        item = review_view(row)
        item["visibility"] = row["visibility"] or "private"
        items.append(item)
    return {"items": items, "pending": pending, "kinds": KINDS, "statuses": STATUSES}


# 审核详情：审核记录、要看的版本、有问题的分片（原文和命中位置）、分页的全部分片正文。
def review_detail(store, review_id, page=1, page_size=10):
    with store.engine.connect() as connection:
        review = connection.execute(select(document_reviews).where(
            document_reviews.c.id == review_id)).mappings().first()
        if review is None:
            raise ReviewError(404, "审核记录不存在")
        target_id = review_target(connection, review)
        target = connection.execute(select(documents).where(documents.c.id == target_id)).mappings().first() \
            if target_id else None
        head = connection.execute(select(document_heads).where(
            document_heads.c.doc_key == review["doc_key"])).mappings().first()
        visibility = visibility_of(connection, review["doc_key"])
    blocked = None
    if review["status"] != "pending":
        blocked = "这条审核已经处理过了"
    elif target is None:
        blocked = "文档还没有上架过的版本，上架后再审核"
    elif review["kind"] == "publish" and not target["status"].startswith("ready"):
        blocked = "当前版本还没处理完，完成后再审核"
    elif review["kind"] in VERSION_KINDS and not target["status"].startswith(REVIEW_PREFIX):
        blocked = "这一版已经不在等待审核"
    chunks_page = store.list_document_chunks(target["owner"], target["id"], page, page_size) if target else None
    problems = problem_chunks(store, target["id"]) if target else None
    document = None
    if target is not None:
        document = {"document_id": target["id"], "title": target["title"], "owner": target["owner"],
            "filename": target["filename"], "version": target["version"] or 1, "status": target["status"],
            "created": target["created"], "version_note": target["version_note"],
            "metadata": target["document_metadata"] or {}}
    return {"review": review_view(review), "document": document, "visibility": visibility,
        "current_version": head["current_version"] if head else None, "chunks": chunks_page,
        "problems": problems, "can_decide": blocked is None, "blocked_reason": blocked}


# 把一条待审核记录改成 status。条件更新保证两个管理员同时点时只有一个生效。
def claim(connection, review_id, status, admin, note=None):
    result = connection.execute(document_reviews.update().where(document_reviews.c.id == review_id,
        document_reviews.c.status == "pending").values(status=status, reviewed_by=admin, reviewed=now(), note=note))
    return result.rowcount == 1


# 通过。publish：可见范围改成所有人；版本类：切换为当前版本并上架。
# document_id 是管理员审核时看到的版本：publish 审核期间上传者又更新了文档，就要重新看过再通过。
def approve(store, review_id, admin, document_id=None):
    detail = review_detail(store, review_id, page=1, page_size=1)
    review = detail["review"]
    if not detail["can_decide"]:
        raise ReviewError(409, detail["blocked_reason"])
    target = detail["document"]
    if document_id and document_id != target["document_id"]:
        raise ReviewError(409, "上传者在你查看之后更新了文档，请重新查看后再审核")
    with store.engine.begin() as connection:
        if not claim(connection, review_id, "approved", admin):
            raise ReviewError(409, "这条审核已经处理过了")
    try:
        if review["kind"] == "publish":
            store.set_document_permission(review["doc_key"], "public", [])
        else:
            activate_and_list(store, review["document_id"], review["chunk_count"] or 0)
    except Exception:
        # 生效失败时把审核改回待审核，管理员可以再点一次。
        with store.engine.begin() as connection:
            connection.execute(document_reviews.update().where(document_reviews.c.id == review_id).values(
                status="pending", reviewed_by=None, reviewed=None))
        raise
    return review_detail(store, review_id)


# 不通过。publish：可见范围不变；版本类：标记为未通过并清理数据，旧版本照常。
def reject(store, review_id, admin, note):
    detail = review_detail(store, review_id, page=1, page_size=1)
    review = detail["review"]
    if review["status"] != "pending":
        raise ReviewError(409, "这条审核已经处理过了")
    with store.engine.begin() as connection:
        if not claim(connection, review_id, "rejected", admin, note):
            raise ReviewError(409, "这条审核已经处理过了")
        if review["kind"] in VERSION_KINDS:
            connection.execute(documents.update().where(documents.c.id == review["document_id"],
                documents.c.status.like(f"{REVIEW_PREFIX}%")).values(
                    status=REJECTED, error=f"审核未通过：{note}"[:500], updated=now()))
    if review["kind"] in VERSION_KINDS:
        try:
            store.remove_version_data(review["document_id"])
        except Exception:
            logger.exception("review_cleanup_failed document_id=%s", review["document_id"])
    return review_detail(store, review_id)
