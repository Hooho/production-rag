"""图检索的向量：写入图谱版本后，给名字、关系算向量存进 Milvus（app/milvus/graph_store.py）。

- 每次写入版本后由 build.finalize 调用 index_version；失败只记日志，不影响图谱本身，可以用「补算向量」补上。
- 版本上记一个标记（graph_versions.summary["vectors"]），写明算在哪个集合、多少行，补算时只算缺的。
- 检索永远只按生效版本 id 过滤，旧版本的向量没删干净也不会被查到；删除只是回收空间。
"""

import hashlib
import json
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select, update

from ..milvus.graph_store import GraphVectorStore
from ..mysql.tables import graph_mentions, graph_relations, graph_versions
from .schemas import ONLINE_SPACE, now

logger = logging.getLogger(__name__)

BATCH = 64
# 一个名字最多拼几段描述、文字最长多少字（太长的描述对找名字没有帮助）。
MAX_DESCRIPTIONS = 3
MAX_CHARS = 500


# 取这个运行环境的图向量集合；测试可以直接给 store.graph_vectors 换成替身。
def vector_store(store, models=None):
    existing = getattr(store, "graph_vectors", None)
    if existing is not None:
        if existing.dimension is None and models is not None:
            existing.dimension = models.dimension
        return existing
    milvus = store.milvus
    created = GraphVectorStore(
        milvus.client,
        milvus.collection,
        getattr(models, "dimension", None) if models is not None else None,
    )
    store.graph_vectors = created
    return created


def name_key(version_id, entity_id, name):
    return hashlib.sha256(f"{version_id}|{entity_id}|{name}".encode()).hexdigest()[:40]


def clip(text):
    text = " ".join(str(text or "").split())
    return text[:MAX_CHARS]


# 名字的文字：「名字（类型）：描述1；描述2」。
def name_text(name, type_, descriptions):
    text = f"{name}（{type_}）"
    if descriptions:
        text += "：" + "；".join(descriptions)
    return clip(text)


# 描述取前几段不重复的。
def add_description(item, description):
    description = (description or "").strip()
    if (
        description
        and description not in item["descriptions"]
        and len(item["descriptions"]) < MAX_DESCRIPTIONS
    ):
        item["descriptions"].append(description)


# 名字的文字：「名字（类型）：描述1；描述2」。同一实体的同一个名字在一个版本里只算一行，描述取前几段不重复的。
def name_rows(connection, version_id):
    rows = (
        connection.execute(
            select(
                graph_mentions.c.entity_id,
                graph_mentions.c.name,
                graph_mentions.c.type,
                graph_mentions.c.description,
                graph_mentions.c.document_id,
            )
            .where(graph_mentions.c.build_id == version_id)
            .order_by(graph_mentions.c.chunk_id)
        )
        .mappings()
        .all()
    )
    grouped = {}
    for row in rows:
        key = (row["entity_id"], row["name"])
        item = grouped.setdefault(
            key,
            {
                "entity_id": row["entity_id"],
                "name": row["name"],
                "type": row["type"],
                "document_id": row["document_id"],
                "descriptions": [],
            },
        )
        add_description(item, row["description"])
    items = []
    for item in grouped.values():
        items.append(
            {
                **item,
                "id": name_key(version_id, item["entity_id"], item["name"]),
                "text": name_text(item["name"], item["type"], item["descriptions"]),
            }
        )
    return items


# 诊断用：查匹配到的名字在各自版本里的描述，按算向量时同样的规则拼出那段文字。
# 返回 {(version_id, entity_id, name): 算向量用的文字}；matches 每条带 version_id / entity_id / name。
def name_vector_texts(engine, matches):
    if not matches:
        return {}
    wanted = {
        (match["version_id"], match["entity_id"], match["name"]) for match in matches
    }
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    graph_mentions.c.build_id,
                    graph_mentions.c.entity_id,
                    graph_mentions.c.name,
                    graph_mentions.c.type,
                    graph_mentions.c.description,
                )
                .where(
                    graph_mentions.c.build_id.in_({key[0] for key in wanted}),
                    graph_mentions.c.entity_id.in_({key[1] for key in wanted}),
                    graph_mentions.c.name.in_({key[2] for key in wanted}),
                )
                .order_by(graph_mentions.c.chunk_id)
            )
            .mappings()
            .all()
        )
    grouped = {}
    for row in rows:
        key = (row["build_id"], row["entity_id"], row["name"])
        if key not in wanted:
            continue
        item = grouped.setdefault(
            key, {"name": row["name"], "type": row["type"], "descriptions": []}
        )
        add_description(item, row["description"])
    return {
        key: name_text(item["name"], item["type"], item["descriptions"])
        for key, item in grouped.items()
    }


# 关系的文字：「起点 → 终点（分类）：描述」，起点、终点用抽取时的原名。
def relation_rows(connection, version_id, clip_text=True):
    source = graph_mentions.alias("source")
    target = graph_mentions.alias("target")
    rows = (
        connection.execute(
            select(
                graph_relations.c.id,
                graph_relations.c.document_id,
                graph_relations.c.category,
                graph_relations.c.description,
                source.c.name.label("source"),
                target.c.name.label("target"),
            )
            .select_from(
                graph_relations.join(
                    source, source.c.id == graph_relations.c.source_mention_id
                ).join(target, target.c.id == graph_relations.c.target_mention_id)
            )
            .where(
                graph_relations.c.build_id == version_id,
                graph_relations.c.status == "active",
            )
        )
        .mappings()
        .all()
    )
    return [
        {
            "id": row["id"],
            "document_id": row["document_id"],
            "text": (clip if clip_text else str)(
                f"{row['source']} → {row['target']}（{row['category']}）：{row['description'] or ''}"
            ),
        }
        for row in rows
    ]


# 分批算向量；每算完一批调用一次 progress(这一批的条数)，给页面显示进度。
def embed_all(models, texts, progress=None):
    vectors = []
    for start in range(0, len(texts), BATCH):
        batch = texts[start : start + BATCH]
        vectors.extend(models.embed(batch))
        if progress is not None:
            progress(len(batch))
    return vectors


def marker(version):
    summary = version.get("summary") or {}
    if isinstance(summary, str):
        summary = json.loads(summary)
    return summary.get("vectors") or {}


# 这个版本的向量是否已经算在当前集合里。
def indexed(version, collection):
    value = marker(version)
    return value.get("status") == "done" and value.get("collection") == collection


# 排队中、计算中超过这么久没有更新，当作 worker 中断了：补算时可以重新排队，页面上也不再显示为进行中。
STALE_SECONDS = 600


def busy(value):
    if value.get("status") not in ("queued", "running"):
        return False
    try:
        at = datetime.fromisoformat(value.get("at"))
    except (TypeError, ValueError):
        return False
    return (datetime.now(timezone.utc) - at).total_seconds() < STALE_SECONDS


# 给页面看的向量状态：none 没算 / queued 排队中 / running 计算中 / done 已算 / failed 失败 /
# stale 算在别的集合里（换过 embedding 模型，要重新算）/ interrupted 排队或计算后很久没动静。
def view(value, collection):
    value = dict(value or {})
    status = value.get("status")
    if not status:
        state = "none"
    elif status in ("queued", "running"):
        state = status if busy(value) else "interrupted"
    elif status == "done" and value.get("collection") != collection:
        state = "stale"
    else:
        state = status
    return {**value, "state": state}


def set_marker(engine, version_id, value):
    with engine.begin() as connection:
        row = connection.execute(
            select(graph_versions.c.summary).where(graph_versions.c.id == version_id)
        ).first()
        if row is None:
            return
        summary = row[0] or {}
        if isinstance(summary, str):
            summary = json.loads(summary)
        connection.execute(
            update(graph_versions)
            .where(graph_versions.c.id == version_id)
            .values(summary={**summary, "vectors": value})
        )


def ensure_keyword_versions(store, models, version_ids):
    """旧图谱只补全文索引，不重算向量；成功后再持久化集合标记。"""
    target = vector_store(store, models)
    collection_existed = target.exists(target.keyword_relations)
    target.ensure_keywords()
    with store.engine.connect() as connection:
        versions = (
            connection.execute(
                select(graph_versions.c.id, graph_versions.c.summary).where(
                    graph_versions.c.id.in_(version_ids)
                )
            )
            .mappings()
            .all()
        )
    for version in versions:
        summary = version["summary"] or {}
        if isinstance(summary, str):
            summary = json.loads(summary)
        if (
            collection_existed
            and summary.get("relation_keyword_collection") == target.keyword_relations
        ):
            continue
        index_relation_keywords(store, target, version["id"])


def index_relation_keywords(store, target, version_id):
    with store.engine.connect() as connection:
        rows = relation_rows(connection, version_id, clip_text=False)
    target.upsert_relation_keywords([{**row, "version_id": version_id} for row in rows])
    with store.engine.begin() as connection:
        summary = (
            connection.execute(
                select(graph_versions.c.summary).where(
                    graph_versions.c.id == version_id
                )
            ).scalar()
            or {}
        )
        if isinstance(summary, str):
            summary = json.loads(summary)
        connection.execute(
            update(graph_versions)
            .where(graph_versions.c.id == version_id)
            .values(
                summary={
                    **summary,
                    "relation_keyword_collection": target.keyword_relations,
                }
            )
        )


# 给一个版本算名字、关系向量并写入；同一版本重复调用会先删掉旧的再写，结果一样。
def index_version(store, models, version_id):
    target = vector_store(store, models)
    with store.engine.connect() as connection:
        version = connection.execute(
            select(graph_versions.c.id, graph_versions.c.document_id).where(
                graph_versions.c.id == version_id
            )
        ).first()
        if version is None:
            return None
        names = name_rows(connection, version_id)
        relations = relation_rows(connection, version_id)
    started = now()
    clock = time.monotonic()
    base = {
        "status": "running",
        "collection": target.base,
        "model": getattr(models, "embedding_model", None),
        "names": len(names),
        "relations": len(relations),
        "started": started,
    }
    progress = {"names_done": 0, "relations_done": 0}

    def report(phase, key=None):
        def advance(count):
            progress[key] += count
            set_marker(
                store.engine,
                version_id,
                {**base, **progress, "phase": phase, "at": now()},
            )

        return advance

    set_marker(
        store.engine, version_id, {**base, **progress, "phase": "names", "at": started}
    )
    name_vectors = embed_all(
        models, [item["text"] for item in names], report("names", "names_done")
    )
    relation_vectors = embed_all(
        models,
        [item["text"] for item in relations],
        report("relations", "relations_done"),
    )
    set_marker(
        store.engine, version_id, {**base, **progress, "phase": "writing", "at": now()}
    )
    target.ensure()
    target.delete_versions([version_id])
    target.upsert_names(
        [
            {
                "id": item["id"],
                "version_id": version_id,
                "document_id": item["document_id"],
                "entity_id": item["entity_id"],
                "name": item["name"],
                "vector": vector,
            }
            for item, vector in zip(names, name_vectors)
        ]
    )
    target.upsert_relations(
        [
            {
                "id": item["id"],
                "version_id": version_id,
                "document_id": item["document_id"],
                "vector": vector,
            }
            for item, vector in zip(relations, relation_vectors)
        ]
    )
    index_relation_keywords(store, target, version_id)
    value = {
        **base,
        **progress,
        "status": "done",
        "phase": "done",
        "at": now(),
        "duration_ms": round((time.monotonic() - clock) * 1000),
    }
    set_marker(store.engine, version_id, value)
    return value


# 写入版本后调用：算向量失败只记日志和标记，不影响建图结果。
def index_after_write(store, models, version_id):
    if models is None or not hasattr(models, "embed"):
        return None
    try:
        return index_version(store, models, version_id)
    except Exception as error:
        logger.exception("graph_vectors_failed version=%s", version_id)
        try:
            # 保留失败前的进度（算到哪一步、多少条），页面上能看出卡在哪里。
            previous = marker(version_row(store.engine, version_id) or {})
            previous = previous if previous.get("status") == "running" else {}
            set_marker(
                store.engine,
                version_id,
                {
                    **previous,
                    "status": "failed",
                    "error": str(error)[:500],
                    "at": now(),
                },
            )
        except Exception:
            logger.exception("graph_vectors_marker_failed version=%s", version_id)
        return None


# 删掉版本的向量（版本被清理时）；失败只记日志，检索只看生效版本，不影响正确性。
def remove_versions(store, version_ids):
    if not version_ids:
        return
    try:
        vector_store(store).delete_versions(version_ids)
    except Exception:
        logger.exception("graph_vectors_remove_failed versions=%s", version_ids)


def remove_document(store, document_id):
    try:
        vector_store(store).delete_document(document_id)
    except Exception:
        logger.exception("graph_vectors_remove_failed document=%s", document_id)


def version_row(engine, version_id):
    with engine.connect() as connection:
        row = (
            connection.execute(
                select(graph_versions.c.id, graph_versions.c.summary).where(
                    graph_versions.c.id == version_id
                )
            )
            .mappings()
            .first()
        )
    return dict(row) if row else None


def active_versions(engine, space=ONLINE_SPACE):
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(graph_versions.c.id, graph_versions.c.summary).where(
                    graph_versions.c.space == space, graph_versions.c.active.is_(True)
                )
            )
            .mappings()
            .all()
        )
    return [dict(row) for row in rows]


# 生效版本里有多少已经算好向量、多少还缺（换了 embedding 模型后全部算缺）。
def status(store, models):
    collection = vector_store(store, models).base
    rows = active_versions(store.engine)
    missing = [row["id"] for row in rows if not indexed(row, collection)]
    failed = sum(1 for row in rows if marker(row).get("status") == "failed")
    working = sum(1 for row in rows if busy(marker(row)))
    return {
        "active": len(rows),
        "indexed": len(rows) - len(missing),
        "missing": len(missing),
        "failed": failed,
        "working": working,
    }


def mark_queued(store, models, version_id):
    collection = vector_store(store, models).base
    set_marker(
        store.engine,
        version_id,
        {
            "status": "queued",
            "collection": collection,
            "model": getattr(models, "embedding_model", None),
            "queued_at": now(),
            "at": now(),
        },
    )


# 补算向量：把缺向量的生效版本排进建图队列，worker 逐个计算。
# 已经在排队、在算的不重复排；先在版本上记「排队中」，页面马上能看到。
def backfill(store, models, enqueue):
    collection = vector_store(store, models).base
    missing = [
        row["id"]
        for row in active_versions(store.engine)
        if not indexed(row, collection) and not busy(marker(row))
    ]
    for version_id in missing:
        mark_queued(store, models, version_id)
    for start in range(0, len(missing), 20):
        enqueue(missing[start : start + 20])
    return len(missing)


# 单独给一个生效版本算（或重算）向量。返回 None 表示版本不存在或没生效，False 表示已经在排队或在算。
def queue_version(store, models, version_id, enqueue, space=ONLINE_SPACE):
    with store.engine.connect() as connection:
        row = (
            connection.execute(
                select(graph_versions.c.id, graph_versions.c.summary).where(
                    graph_versions.c.id == version_id,
                    graph_versions.c.space == space,
                    graph_versions.c.active.is_(True),
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        return None
    if busy(marker(row)):
        return False
    mark_queued(store, models, version_id)
    enqueue([version_id])
    return True


def run_job(store, models, version_ids):
    for version_id in version_ids or []:
        index_after_write(store, models, version_id)
