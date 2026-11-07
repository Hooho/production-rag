"""图检索（参考 LightRAG，只走一跳）：

① 提关键词：调用方给了（Agent 传入 entities / themes）就直接用，没给就用 graph_keywords 提示词从问题里提取。
② 找实体（local）：每个具体关键词去名字向量里找相似的名字，按名字的归属合并成实体。
③ 实体的关系：取找到的实体直接相连的关系，按关系和问题的相似度排序，每个实体最多留 N 条。
④ 找关系（global）：每个概括关键词去关系向量里找相似的关系。
⑤ 取分片：③ 的关系的出处分片 → 排名表「图 · 实体」；④ 的 → 排名表「图 · 关系」，两张表都进入 RRF。

范围（权限 + 生效版本）在一开始就算成版本 id 列表，所有查询都带着它：没权限的文档、不是生效版本的、
已删除的关系从头就查不到，看不到的文档里的名字也不会参与匹配。所以诊断里只有检索本身的取舍（低于阈值、超过条数）。
"""

import json
import logging
import re
import time

from langchain_core.messages import HumanMessage, SystemMessage
from sqlalchemy import or_, select

from .. import prompts
from ..models import strip_think
from ..mysql.tables import (
    chunks,
    document_chunks,
    graph_entities,
    graph_mentions,
    graph_relations,
    graph_versions,
)
from .extract import model_options
from .schemas import ONLINE_SPACE
from .vectors import vector_store

logger = logging.getLogger(__name__)

PROMPT_ID = "graph_keywords"
# 默认参数；系统设置里可以改（runtime_config 的 graph_* 项）。
DEFAULTS = {
    "graph_name_min_score": 0.5,
    "graph_name_top_k": 10,
    "graph_entity_relation_limit": 10,
    "graph_relation_min_score": 0.5,
    "graph_relation_top_k": 20,
}
MAX_ENTITIES = 8
MAX_THEMES = 5
KEYWORD_LENGTH = 50
KEYWORD_MAX_TOKENS = 1000
KEYWORD_TIMEOUT = 30
# 诊断里去掉的项最多存多少条明细，其余只记数量。
DROPPED_DETAIL = 50


def setting(settings, key):
    value = (settings or {}).get(key)
    return DEFAULTS[key] if value is None else value


# 图检索范围：可检索文档（已按权限、当前版本算好）里有生效图谱的版本。
def scope_versions(engine, scope, space=ONLINE_SPACE):
    documents = {item["document_id"]: item for item in (scope or {}).get("documents") or []}
    if not documents:
        return []
    with engine.connect() as connection:
        rows = connection.execute(
            select(graph_versions.c.id, graph_versions.c.document_id, graph_versions.c.number)
            .where(graph_versions.c.space == space, graph_versions.c.active.is_(True),
                graph_versions.c.document_id.in_(list(documents)))
        ).mappings().all()
    result = [{"version_id": row["id"], "document_id": row["document_id"], "number": row["number"],
        "title": documents[row["document_id"]].get("title"),
        "document_version": documents[row["document_id"]].get("version")} for row in rows]
    result.sort(key=lambda item: item["title"] or "")
    return result


def clean_keywords(values, limit):
    result = []
    for value in values or []:
        if not isinstance(value, str):
            continue
        text = " ".join(value.split())[:KEYWORD_LENGTH]
        if text and text not in result:
            result.append(text)
    return result[:limit]


def parse_keywords(text):
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        raise ValueError("模型没有返回 JSON")
    value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    return clean_keywords(value.get("entities"), MAX_ENTITIES), clean_keywords(value.get("themes"), MAX_THEMES)


# ① 提关键词。返回 {"source", "entities", "themes", ...}；source 是 agent / model / fallback。
def keywords(models, question, entities=None, themes=None):
    started = time.monotonic()
    given_entities = clean_keywords(entities, MAX_ENTITIES)
    given_themes = clean_keywords(themes, MAX_THEMES)
    if given_entities or given_themes:
        return {"source": "agent", "entities": given_entities, "themes": given_themes, "duration_ms": 0}
    result = {"source": "model", "entities": [], "themes": [], "prompt_tag": prompts.tag(PROMPT_ID)}
    chat_model = getattr(models, "chat_model", None)
    if chat_model is None or getattr(models, "mode", "openai") != "openai":
        result.update(source="fallback", reason="没有可用的聊天模型（演示模式），用整个问题当具体关键词")
    else:
        messages = [{"role": "system", "content": prompts.compose(PROMPT_ID)},
            {"role": "user", "content": json.dumps({"question": question}, ensure_ascii=False)}]
        result["prompt"] = messages
        try:
            response = chat_model.bind(max_tokens=KEYWORD_MAX_TOKENS, timeout=KEYWORD_TIMEOUT,
                **model_options(getattr(models, "llm_model", None))).invoke(
                [SystemMessage(content=messages[0]["content"]), HumanMessage(content=messages[1]["content"])])
            content = response.content if isinstance(response.content, str) else ""
            usage = getattr(response, "usage_metadata", None) or {}
            result.update(raw_output=content, input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"), model=getattr(models, "llm_model", None))
            result["entities"], result["themes"] = parse_keywords(strip_think(content))
        except Exception as error:
            logger.warning("graph_keywords_failed error=%s", error)
            result.update(error=str(error)[:500])
        if not result["entities"] and not result["themes"]:
            result["reason"] = ("提关键词失败，" if result.get("error") else "没有提出关键词，") + "用整个问题当具体关键词"
    if not result["entities"] and not result["themes"]:
        result["entities"] = [question[:KEYWORD_LENGTH * 4]]
        result["fallback"] = True
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


def relation_details(connection, relation_ids):
    if not relation_ids:
        return {}
    source = graph_mentions.alias("source")
    target = graph_mentions.alias("target")
    source_entity = graph_entities.alias("source_entity")
    target_entity = graph_entities.alias("target_entity")
    rows = connection.execute(
        select(graph_relations.c.id, graph_relations.c.build_id, graph_relations.c.document_id,
            graph_relations.c.chunk_id, graph_relations.c.category, graph_relations.c.description,
            graph_relations.c.evidence,
            source.c.name.label("source"), source.c.entity_id.label("source_entity_id"),
            source_entity.c.name.label("source_entity"), source_entity.c.type.label("source_type"),
            target.c.name.label("target"), target.c.entity_id.label("target_entity_id"),
            target_entity.c.name.label("target_entity"), target_entity.c.type.label("target_type"))
        .select_from(graph_relations
            .join(source, source.c.id == graph_relations.c.source_mention_id)
            .join(target, target.c.id == graph_relations.c.target_mention_id)
            .outerjoin(source_entity, source_entity.c.id == source.c.entity_id)
            .outerjoin(target_entity, target_entity.c.id == target.c.entity_id))
        .where(graph_relations.c.id.in_(list(relation_ids)))
    ).mappings().all()
    return {row["id"]: dict(row) for row in rows}


def relation_view(row, versions, score):
    version = versions.get(row["build_id"]) or {}
    return {"relation_id": row["id"], "source": row["source"], "source_entity_id": row["source_entity_id"],
        "source_entity": row["source_entity"], "source_type": row["source_type"],
        "target": row["target"], "target_entity_id": row["target_entity_id"],
        "target_entity": row["target_entity"], "target_type": row["target_type"],
        "category": row["category"], "description": row["description"], "evidence": row["evidence"],
        "chunk_id": row["chunk_id"], "document_id": row["document_id"], "title": version.get("title"),
        "version_id": row["build_id"], "version_number": version.get("number"),
        "score": round(float(score), 4) if score is not None else None}


def limit_dropped(items):
    kept = [item for item in items if item.get("kept")]
    dropped = [item for item in items if not item.get("kept")]
    return kept + dropped[:DROPPED_DETAIL], max(0, len(dropped) - DROPPED_DETAIL)


# 分片原文，组装成和向量、关键词检索一样的来源结构，交给 RRF。
def chunk_sources(engine, chunk_ids, document_versions):
    from ..storage import row_range

    if not chunk_ids:
        return {}
    with engine.connect() as connection:
        rows = connection.execute(
            select(chunks.c.id, chunks.c.title, chunks.c.text, chunks.c.chunk_key,
                document_chunks.c.document_id, document_chunks.c.position, document_chunks.c.chunk_metadata)
            .select_from(document_chunks.join(chunks, chunks.c.id == document_chunks.c.chunk_id))
            .where(document_chunks.c.chunk_id.in_(list(chunk_ids)),
                document_chunks.c.document_id.in_(list(document_versions)))
        ).mappings().all()
    result = {}
    for row in rows:
        metadata_value = row["chunk_metadata"] or {}
        page_start = metadata_value.get("page_start")
        heading_path = metadata_value.get("heading_path") or []
        result[row["id"]] = {"id": row["id"], "title": row["title"], "text": row["text"],
            "document_id": row["document_id"], "chunk_key": row["chunk_key"], "position": row["position"],
            "version": document_versions.get(row["document_id"]),
            "page_start": page_start if page_start is not None and page_start >= 0 else None,
            "heading": " · ".join(part for part in (" / ".join(heading_path), row_range(metadata_value)) if part) or None}
    return result


# ⑤ 一张排名表：关系按出处分片去重，名次按这一片对应的关系里相似度最高的那条排。
def chunk_table(relations):
    by_chunk = {}
    for relation in relations:
        item = by_chunk.setdefault(relation["chunk_id"], {"chunk_id": relation["chunk_id"],
            "score": relation["score"] or 0, "relation_ids": []})
        item["score"] = max(item["score"], relation["score"] or 0)
        if relation["relation_id"] not in item["relation_ids"]:
            item["relation_ids"].append(relation["relation_id"])
    table = sorted(by_chunk.values(), key=lambda item: item["score"], reverse=True)
    for rank, item in enumerate(table, start=1):
        item["rank"] = rank
    return table


def empty(status, reason, scope=None, **extra):
    return {"status": status, "reason": reason, "scope": scope or [], "keywords": None,
        "name_matches": [], "entities": [], "entity_relations": [], "relation_matches": [],
        "tables": {"entity": [], "relation": []}, "sources": {"entity": [], "relation": []},
        "dropped_more": {}, "timings": {}, **extra}


# 图检索主流程。scope 是这次检索的权限范围（Storage.readable_scope 的结果）；
# entities / themes 是调用方给的关键词（Agent），不给就提取。返回诊断，sources 里是两张排名表的来源。
def retrieve(store, models, question, scope, settings=None, entities=None, themes=None):
    started = time.monotonic()
    timings = {}
    graph_scope = scope_versions(store.engine, scope)
    if not graph_scope:
        return empty("skipped", "范围内没有建了图的文档", [])
    versions = {item["version_id"]: item for item in graph_scope}
    version_ids = list(versions)
    document_versions = {item["document_id"]: item["document_version"] for item in graph_scope}
    target = vector_store(store, models)

    words = keywords(models, question, entities, themes)
    timings["keywords_ms"] = words["duration_ms"]

    step = time.monotonic()
    texts = [question] + words["entities"] + words["themes"]
    vectors = models.embed(texts)
    question_vector = vectors[0]
    entity_vectors = vectors[1:1 + len(words["entities"])]
    theme_vectors = vectors[1 + len(words["entities"]):]
    timings["embed_ms"] = round((time.monotonic() - step) * 1000)

    # ② 找实体
    step = time.monotonic()
    name_min = setting(settings, "graph_name_min_score")
    name_matches = []
    for keyword, vector in zip(words["entities"], entity_vectors):
        for hit in target.search_names(vector, version_ids, int(setting(settings, "graph_name_top_k"))):
            kept = hit["score"] >= name_min
            name_matches.append({"keyword": keyword, "name": hit["name"], "entity_id": hit["entity_id"],
                "version_id": hit["version_id"], "document_id": hit["document_id"],
                "title": (versions.get(hit["version_id"]) or {}).get("title"),
                "version_number": (versions.get(hit["version_id"]) or {}).get("number"),
                "score": round(hit["score"], 4), "kept": kept,
                "reason": None if kept else f"相似度低于 {name_min}"})
    entity_ids = []
    for match in name_matches:
        if match["kept"] and match["entity_id"] not in entity_ids:
            entity_ids.append(match["entity_id"])
    with store.engine.connect() as connection:
        entity_rows = {row["id"]: dict(row) for row in connection.execute(
            select(graph_entities.c.id, graph_entities.c.name, graph_entities.c.type)
            .where(graph_entities.c.id.in_({match["entity_id"] for match in name_matches} or {""}))
        ).mappings().all()}
    for match in name_matches:
        entity = entity_rows.get(match["entity_id"]) or {}
        match.update(entity_name=entity.get("name"), entity_type=entity.get("type"))
    found = []
    for entity_id in entity_ids:
        entity = entity_rows.get(entity_id) or {}
        found.append({"entity_id": entity_id, "name": entity.get("name"), "type": entity.get("type"),
            "names": sorted({match["name"] for match in name_matches if match["kept"] and match["entity_id"] == entity_id}),
            "score": max(match["score"] for match in name_matches if match["kept"] and match["entity_id"] == entity_id)})
    timings["entities_ms"] = round((time.monotonic() - step) * 1000)

    # ③ 实体的关系（一跳）
    step = time.monotonic()
    per_entity = int(setting(settings, "graph_entity_relation_limit"))
    entity_relations = []
    with store.engine.connect() as connection:
        linked = {}
        if entity_ids:
            source = graph_mentions.alias("source")
            target_mention = graph_mentions.alias("target")
            rows = connection.execute(
                select(graph_relations.c.id, source.c.entity_id.label("source_entity_id"),
                    target_mention.c.entity_id.label("target_entity_id"))
                .select_from(graph_relations
                    .join(source, source.c.id == graph_relations.c.source_mention_id)
                    .join(target_mention, target_mention.c.id == graph_relations.c.target_mention_id))
                .where(graph_relations.c.build_id.in_(version_ids), graph_relations.c.status == "active",
                    or_(source.c.entity_id.in_(entity_ids), target_mention.c.entity_id.in_(entity_ids)))
            ).mappings().all()
            for row in rows:
                for entity_id in (row["source_entity_id"], row["target_entity_id"]):
                    if entity_id in entity_ids:
                        linked.setdefault(entity_id, [])
                        if row["id"] not in linked[entity_id]:
                            linked[entity_id].append(row["id"])
        scores = {}
        all_ids = sorted({relation_id for ids in linked.values() for relation_id in ids})
        if all_ids:
            for hit in target.search_relations(question_vector, version_ids, len(all_ids), ids=all_ids):
                scores[hit["id"]] = hit["score"]
        # 还没算向量的关系查不到相似度，记为 0，排在最后。
        theme_hits = []
        for keyword, vector in zip(words["themes"], theme_vectors):
            hits = target.search_relations(vector, version_ids, int(setting(settings, "graph_relation_top_k")))
            theme_hits.append((keyword, hits))
        detail_ids = set(all_ids) | {hit["id"] for _, hits in theme_hits for hit in hits}
        details = relation_details(connection, detail_ids)
    kept_entity_relations = set()
    for entity_id in entity_ids:
        ranked = sorted(linked.get(entity_id, []), key=lambda relation_id: scores.get(relation_id, 0), reverse=True)
        entity = entity_rows.get(entity_id) or {}
        for index, relation_id in enumerate(ranked):
            row = details.get(relation_id)
            if row is None:
                continue
            kept = index < per_entity
            if kept:
                kept_entity_relations.add(relation_id)
            entity_relations.append({**relation_view(row, versions, scores.get(relation_id)),
                "entity_id": entity_id, "entity_name": entity.get("name"), "kept": kept,
                "reason": None if kept else f"超过每个实体 {per_entity} 条"})
    timings["entity_relations_ms"] = round((time.monotonic() - step) * 1000)

    # ④ 找关系（global）
    step = time.monotonic()
    relation_min = setting(settings, "graph_relation_min_score")
    relation_matches = []
    for keyword, hits in theme_hits:
        for hit in hits:
            row = details.get(hit["id"])
            if row is None:
                continue
            kept = hit["score"] >= relation_min
            relation_matches.append({**relation_view(row, versions, hit["score"]), "keyword": keyword,
                "kept": kept, "also_entity": hit["id"] in kept_entity_relations,
                "reason": None if kept else f"相似度低于 {relation_min}"})
    timings["relations_ms"] = round((time.monotonic() - step) * 1000)

    # ⑤ 取分片
    step = time.monotonic()
    entity_kept = [item for item in entity_relations if item["kept"]]
    theme_kept = {}
    for item in relation_matches:
        if item["kept"]:
            previous = theme_kept.get(item["relation_id"])
            if previous is None or (item["score"] or 0) > (previous["score"] or 0):
                theme_kept[item["relation_id"]] = item
    tables = {"entity": chunk_table(entity_kept), "relation": chunk_table(list(theme_kept.values()))}
    sources_by_id = chunk_sources(store.engine,
        {item["chunk_id"] for table in tables.values() for item in table}, document_versions)
    sources = {}
    for name, table in tables.items():
        rows, rank = [], 0
        for item in table:
            source = sources_by_id.get(item["chunk_id"])
            if source is None:
                item.update(kept=False, reason="分片不在当前文档版本")
                continue
            rank += 1
            # 正文一起存进诊断：页面上点「原文」时在整片里高亮引用和实体名字。
            item.update(kept=True, rank=rank, title=source["title"], text=source["text"],
                version=source["version"], heading=source["heading"])
            rows.append({**source, "score": item["score"], "relation_ids": item["relation_ids"]})
        sources[name] = rows
    timings["chunks_ms"] = round((time.monotonic() - step) * 1000)

    name_matches, names_more = limit_dropped(name_matches)
    entity_relations, entity_more = limit_dropped(entity_relations)
    relation_matches, relation_more = limit_dropped(relation_matches)
    timings["total_ms"] = round((time.monotonic() - started) * 1000)
    unique = {item["id"] for rows in sources.values() for item in rows}
    return {"status": "ok", "reason": None, "scope": graph_scope, "keywords": words,
        "name_matches": name_matches, "entities": found, "entity_relations": entity_relations,
        "relation_matches": relation_matches, "tables": tables, "sources": sources,
        "dropped_more": {"names": names_more, "entity_relations": entity_more,
            "relation_matches": relation_more},
        "counts": {"entity_chunks": len(sources["entity"]), "relation_chunks": len(sources["relation"]),
            "chunks": len(unique)},
        "settings": {key: setting(settings, key) for key in DEFAULTS},
        "timings": timings}
