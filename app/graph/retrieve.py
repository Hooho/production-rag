from ..retrieval_policy import selected_graph_versions

import json
import logging
import re
import time

from langchain_core.messages import HumanMessage, SystemMessage
from sqlalchemy import literal, or_, select

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
from .resolve import normalize
from .schemas import ONLINE_SPACE
from .vectors import ensure_keyword_versions, name_vector_texts, vector_store
from .relation_retrieval import hybrid_ranking, select_candidates, rerank_candidates

logger = logging.getLogger(__name__)

PROMPT_ID = "graph_keywords"
# 默认参数；系统设置里可以改（runtime_config 的 graph_* 项）。
DEFAULTS = {
    "graph_name_min_score": 0.5,
    "graph_name_top_k": 10,
    "graph_entity_top_k": 6,
    "graph_entity_min_score": 0.5,
    "graph_entity_relation_limit": 100,
    "graph_entity_relation_quota": 5,
    "graph_global_relation_quota": 10,
    "graph_relation_rerank_candidates": 100,
    "graph_relation_return_limit": 30,
    "graph_relation_rerank_min_score": 0.0,
    "graph_relation_min_score": 0.5,
    "graph_relation_top_k": 100,
}
MAX_ENTITIES = 8
MAX_THEMES = 5
KEYWORD_LENGTH = 50
KEYWORD_MAX_TOKENS = 1000
KEYWORD_TIMEOUT = 30
# 字面匹配：每个关键词最多取多少个名字；被包含的一方至少几个字（单字「段」会把一堆名字都算进来）。
LITERAL_LIMIT = 30
LITERAL_MIN_LENGTH = 2


def setting(settings, key):
    value = (settings or {}).get(key)
    return DEFAULTS[key] if value is None else value


# 图检索范围：可检索文档（已按权限、当前版本算好）里有生效图谱的版本。
def scope_versions(engine, scope, space=ONLINE_SPACE):
    documents = {
        item["document_id"]: item for item in (scope or {}).get("documents") or []
    }
    if not documents:
        return []
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    graph_versions.c.id,
                    graph_versions.c.document_id,
                    graph_versions.c.number,
                ).where(
                    graph_versions.c.space == space,
                    graph_versions.c.id.in_(selected_graph_versions())
                    if selected_graph_versions() is not None
                    else graph_versions.c.active.is_(True),
                    graph_versions.c.document_id.in_(list(documents)),
                )
            )
            .mappings()
            .all()
        )
    result = [
        {
            "version_id": row["id"],
            "document_id": row["document_id"],
            "number": row["number"],
            "title": documents[row["document_id"]].get("title"),
            "document_version": documents[row["document_id"]].get("version"),
        }
        for row in rows
    ]
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
    return clean_keywords(value.get("entities"), MAX_ENTITIES), clean_keywords(
        value.get("themes"), MAX_THEMES
    )


# ① 提关键词。返回 {"source", "entities", "themes", ...}；source 是 agent / model / fallback。
# question_source 是这次按哪个问题提的（固定流程的独立问题、Agent 的检索词…），调用方最清楚，诊断里记下来。
# question 是这次图检索用的问题，关系打分用的也是它，所以三种来源都记下来（页面要说明分数是「问题 × 关系」）。
def keywords(models, question, entities=None, themes=None, question_source=None):
    started = time.monotonic()
    given_entities = clean_keywords(entities, MAX_ENTITIES)
    if given_entities:
        return {
            "source": "agent",
            "entities": given_entities,
            "themes": [],
            "question": question,
            "question_source": question_source,
            "duration_ms": 0,
        }
    result = {
        "source": "model",
        "entities": [],
        "themes": [],
        "question": question,
        "question_source": question_source,
        "prompt_tag": prompts.tag(PROMPT_ID),
    }
    chat_model = getattr(models, "chat_model", None)
    if chat_model is None or getattr(models, "mode", "openai") != "openai":
        result.update(
            source="fallback",
            reason="没有可用的实体提取模型，仅执行全局关系检索",
        )
    else:
        messages = [
            {"role": "system", "content": prompts.compose(PROMPT_ID)},
            {
                "role": "user",
                "content": json.dumps({"question": question}, ensure_ascii=False),
            },
        ]
        result["prompt"] = messages
        try:
            response = chat_model.bind(
                max_tokens=KEYWORD_MAX_TOKENS,
                timeout=KEYWORD_TIMEOUT,
                **model_options(getattr(models, "llm_model", None)),
            ).invoke(
                [
                    SystemMessage(content=messages[0]["content"]),
                    HumanMessage(content=messages[1]["content"]),
                ]
            )
            content = response.content if isinstance(response.content, str) else ""
            usage = getattr(response, "usage_metadata", None) or {}
            result.update(
                raw_output=content,
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
                model=getattr(models, "llm_model", None),
            )
            result["entities"], _ = parse_keywords(strip_think(content))
            result["themes"] = []
        except Exception as error:
            logger.warning("graph_keywords_failed error=%s", error)
            result.update(error=str(error)[:500])
        if not result["entities"] and not result["themes"]:
            result["reason"] = (
                "实体提取失败，" if result.get("error") else "没有提取到实体，"
            ) + "仅执行全局关系检索"
    if not result["entities"] and not result["themes"]:
        result["fallback"] = True
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


# 字面匹配：名字或标准名（模型给的，例如「阿段」的标准名是「段永平」）规范化后和关键词相同算 exact；
# 关键词包含名字（关键词「段永平先生」、名字「段永平」）算 contains。反过来名字包含关键词的不算：
# 「段永平的投资风格」包含「段永平」，但它是一个概念，不是这个人，交给向量判断。先用 LIKE 粗筛，再按规范化结果判断。
def literal_names(connection, keyword, version_ids):
    key = normalize(keyword)
    raw = keyword.strip()
    if not key or not raw or not version_ids:
        return []
    name, canonical = graph_mentions.c.name, graph_mentions.c.canonical
    rows = (
        connection.execute(
            select(
                graph_mentions.c.build_id,
                graph_mentions.c.entity_id,
                graph_mentions.c.document_id,
                name,
                canonical,
            )
            .distinct()
            .where(
                graph_mentions.c.build_id.in_(version_ids),
                or_(literal(raw).contains(name), literal(raw).contains(canonical)),
            )
        )
        .mappings()
        .all()
    )
    hits = {}
    for row in rows:
        best = None
        for text in (row["name"], row["canonical"]):
            value = normalize(text)
            if value == key:
                best = "exact"
                break
            if value and value in key and len(value) >= LITERAL_MIN_LENGTH:
                best = best or "contains"
        if best is None:
            continue
        item_key = (row["build_id"], row["entity_id"], row["name"])
        previous = hits.get(item_key)
        if previous is None or (best == "exact" and previous["match"] != "exact"):
            hits[item_key] = {
                "name": row["name"],
                "entity_id": row["entity_id"],
                "version_id": row["build_id"],
                "document_id": row["document_id"],
                "score": 1.0,
                "match": best,
            }
    ordered = sorted(
        hits.values(),
        key=lambda item: (item["match"] != "exact", len(item["name"]), item["name"]),
    )
    return ordered[:LITERAL_LIMIT]


def relation_details(connection, relation_ids):
    if not relation_ids:
        return {}
    source = graph_mentions.alias("source")
    target = graph_mentions.alias("target")
    source_entity = graph_entities.alias("source_entity")
    target_entity = graph_entities.alias("target_entity")
    rows = (
        connection.execute(
            select(
                graph_relations.c.id,
                graph_relations.c.build_id,
                graph_relations.c.document_id,
                graph_relations.c.chunk_id,
                graph_relations.c.category,
                graph_relations.c.description,
                graph_relations.c.evidence,
                source.c.name.label("source"),
                source.c.entity_id.label("source_entity_id"),
                source_entity.c.name.label("source_entity"),
                source_entity.c.type.label("source_type"),
                target.c.name.label("target"),
                target.c.entity_id.label("target_entity_id"),
                target_entity.c.name.label("target_entity"),
                target_entity.c.type.label("target_type"),
            )
            .select_from(
                graph_relations.join(
                    source, source.c.id == graph_relations.c.source_mention_id
                )
                .join(target, target.c.id == graph_relations.c.target_mention_id)
                .outerjoin(source_entity, source_entity.c.id == source.c.entity_id)
                .outerjoin(target_entity, target_entity.c.id == target.c.entity_id)
            )
            .where(
                graph_relations.c.id.in_(list(relation_ids)),
                graph_relations.c.status == "active",
            )
        )
        .mappings()
        .all()
    )
    return {row["id"]: dict(row) for row in rows}


def relation_view(row, versions, score):
    version = versions.get(row["build_id"]) or {}
    return {
        "relation_id": row["id"],
        "source": row["source"],
        "source_entity_id": row["source_entity_id"],
        "source_entity": row["source_entity"],
        "source_type": row["source_type"],
        "target": row["target"],
        "target_entity_id": row["target_entity_id"],
        "target_entity": row["target_entity"],
        "target_type": row["target_type"],
        "category": row["category"],
        "description": row["description"],
        "evidence": row["evidence"],
        "chunk_id": row["chunk_id"],
        "document_id": row["document_id"],
        "title": version.get("title"),
        "version_id": row["build_id"],
        "version_number": version.get("number"),
        "score": round(float(score), 4) if score is not None else None,
    }


# 分片原文，组装成和向量、关键词检索一样的来源结构，交给 RRF。
def chunk_sources(engine, chunk_ids, document_versions):
    from ..storage import row_range

    if not chunk_ids:
        return {}
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    chunks.c.id,
                    chunks.c.title,
                    chunks.c.text,
                    chunks.c.chunk_key,
                    document_chunks.c.document_id,
                    document_chunks.c.position,
                    document_chunks.c.chunk_metadata,
                )
                .select_from(
                    document_chunks.join(
                        chunks, chunks.c.id == document_chunks.c.chunk_id
                    )
                )
                .where(
                    document_chunks.c.chunk_id.in_(list(chunk_ids)),
                    document_chunks.c.document_id.in_(list(document_versions)),
                )
            )
            .mappings()
            .all()
        )
    result = {}
    for row in rows:
        metadata_value = row["chunk_metadata"] or {}
        page_start = metadata_value.get("page_start")
        heading_path = metadata_value.get("heading_path") or []
        result[row["id"]] = {
            "id": row["id"],
            "title": row["title"],
            "text": row["text"],
            "document_id": row["document_id"],
            "chunk_key": row["chunk_key"],
            "position": row["position"],
            "version": document_versions.get(row["document_id"]),
            "page_start": page_start
            if page_start is not None and page_start >= 0
            else None,
            "heading": " · ".join(
                part
                for part in (" / ".join(heading_path), row_range(metadata_value))
                if part
            )
            or None,
        }
    return result


# 关系按出处分片去重；score 是统一关系排序名次的倒数，分片沿用其最高优先级关系。
def chunk_table(relations):
    by_chunk = {}
    for relation in relations:
        item = by_chunk.setdefault(
            relation["chunk_id"],
            {
                "chunk_id": relation["chunk_id"],
                "score": relation["score"] or 0,
                "relation_ids": [],
            },
        )
        item["score"] = max(item["score"], relation["score"] or 0)
        if relation["relation_id"] not in item["relation_ids"]:
            item["relation_ids"].append(relation["relation_id"])
    table = sorted(by_chunk.values(), key=lambda item: item["score"], reverse=True)
    for rank, item in enumerate(table, start=1):
        item["rank"] = rank
    return table


def empty(status, reason, scope=None, **extra):
    return {
        "status": status,
        "reason": reason,
        "scope": scope or [],
        "keywords": None,
        "name_matches": [],
        "entities": [],
        "entity_relations": [],
        "relation_matches": [],
        "tables": {"entity": [], "relation": []},
        "sources": {"entity": [], "relation": []},
        "dropped_more": {},
        "timings": {},
        **extra,
    }


# 图检索主流程。scope 是这次检索的权限范围（Storage.readable_scope 的结果）；
# entities / themes 是调用方给的关键词（Agent），不给就提取。返回诊断，sources 里是两张排名表的来源。
def retrieve(
    store,
    models,
    question,
    scope,
    settings=None,
    entities=None,
    themes=None,
    question_source=None,
):
    started = time.monotonic()
    timings = {}
    graph_scope = scope_versions(store.engine, scope)
    if not graph_scope:
        return empty("skipped", "范围内没有建了图的文档", [])
    versions = {item["version_id"]: item for item in graph_scope}
    version_ids = list(versions)
    document_versions = {
        item["document_id"]: item["document_version"] for item in graph_scope
    }
    target = vector_store(store, models)

    words = keywords(models, question, entities, themes, question_source)
    timings["keywords_ms"] = words["duration_ms"]

    step = time.monotonic()
    texts = [question] + words["entities"]
    vectors = models.embed(texts)
    question_vector = vectors[0]
    entity_vectors = vectors[1 : 1 + len(words["entities"])]

    timings["embed_ms"] = round((time.monotonic() - step) * 1000)

    # ② 找实体：字面匹配 + 名字向量，同一个名字字面命中了就不再用向量那条；每个关键词只留前几个实体。
    step = time.monotonic()
    name_min = setting(settings, "graph_name_min_score")
    entity_top = int(setting(settings, "graph_entity_top_k"))
    name_matches = []
    with store.engine.connect() as connection:
        literal_hits = {
            keyword: literal_names(connection, keyword, version_ids)
            for keyword in words["entities"]
        }
    for keyword, vector in zip(words["entities"], entity_vectors):
        matches = []
        seen = set()
        for hit in literal_hits[keyword]:
            seen.add((hit["version_id"], hit["entity_id"], hit["name"]))
            matches.append({**hit, "kept": True, "reason": None})
        for hit in target.search_names(
            vector, version_ids, int(setting(settings, "graph_name_top_k"))
        ):
            if (hit["version_id"], hit["entity_id"], hit["name"]) in seen:
                continue
            kept = hit["score"] >= name_min
            matches.append(
                {
                    "name": hit["name"],
                    "entity_id": hit["entity_id"],
                    "version_id": hit["version_id"],
                    "document_id": hit["document_id"],
                    "score": hit["score"],
                    "match": "vector",
                    "kept": kept,
                    "reason": None if kept else f"相似度低于 {name_min}",
                }
            )
        # 实体排序：有字面命中（完全相同在前）的排最前，其余按留下的名字里最高的相似度。
        rank = {}
        for match in matches:
            if not match["kept"]:
                continue
            order = (
                0
                if match["match"] == "exact"
                else 1
                if match["match"] == "contains"
                else 2,
                -match["score"],
            )
            if match["entity_id"] not in rank or order < rank[match["entity_id"]]:
                rank[match["entity_id"]] = order
        allowed = {
            entity_id
            for entity_id, _ in sorted(rank.items(), key=lambda item: item[1])[
                :entity_top
            ]
        }
        for match in matches:
            if match["kept"] and match["entity_id"] not in allowed:
                match.update(kept=False, reason=f"超过每个关键词 {entity_top} 个实体")
            name_matches.append(
                {
                    "keyword": keyword,
                    **match,
                    "title": (versions.get(match["version_id"]) or {}).get("title"),
                    "version_number": (versions.get(match["version_id"]) or {}).get(
                        "number"
                    ),
                    "score": round(match["score"], 4),
                }
            )
    entity_ids = []
    for match in name_matches:
        if match["kept"] and match["entity_id"] not in entity_ids:
            entity_ids.append(match["entity_id"])
    with store.engine.connect() as connection:
        entity_rows = {
            row["id"]: dict(row)
            for row in connection.execute(
                select(
                    graph_entities.c.id, graph_entities.c.name, graph_entities.c.type
                ).where(
                    graph_entities.c.id.in_(
                        {match["entity_id"] for match in name_matches} or {""}
                    )
                )
            )
            .mappings()
            .all()
        }
    # 名字向量是用哪段文字算的（名字＋描述）：诊断里显示出来，能看到向量到底算的是什么。
    vector_texts = name_vector_texts(store.engine, name_matches)
    for match in name_matches:
        entity = entity_rows.get(match["entity_id"]) or {}
        match.update(entity_name=entity.get("name"), entity_type=entity.get("type"))
        match["vector_text"] = vector_texts.get(
            (match["version_id"], match["entity_id"], match["name"])
        )
    found = []
    for entity_id in entity_ids:
        entity = entity_rows.get(entity_id) or {}
        found.append(
            {
                "entity_id": entity_id,
                "name": entity.get("name"),
                "type": entity.get("type"),
                "names": sorted(
                    {
                        match["name"]
                        for match in name_matches
                        if match["kept"] and match["entity_id"] == entity_id
                    }
                ),
                "score": max(
                    match["score"]
                    for match in name_matches
                    if match["kept"] and match["entity_id"] == entity_id
                ),
            }
        )
    timings["entities_ms"] = round((time.monotonic() - step) * 1000)

    # ③ 实体的关系（一跳）
    step = time.monotonic()
    per_entity = int(setting(settings, "graph_entity_relation_limit"))
    entity_min = setting(settings, "graph_entity_min_score")
    entity_relations = []
    with store.engine.connect() as connection:
        linked = {}
        if entity_ids:
            source = graph_mentions.alias("source")
            target_mention = graph_mentions.alias("target")
            rows = (
                connection.execute(
                    select(
                        graph_relations.c.id,
                        source.c.entity_id.label("source_entity_id"),
                        target_mention.c.entity_id.label("target_entity_id"),
                    )
                    .select_from(
                        graph_relations.join(
                            source, source.c.id == graph_relations.c.source_mention_id
                        ).join(
                            target_mention,
                            target_mention.c.id == graph_relations.c.target_mention_id,
                        )
                    )
                    .where(
                        graph_relations.c.build_id.in_(version_ids),
                        graph_relations.c.status == "active",
                        or_(
                            source.c.entity_id.in_(entity_ids),
                            target_mention.c.entity_id.in_(entity_ids),
                        ),
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                for entity_id in (row["source_entity_id"], row["target_entity_id"]):
                    if entity_id in entity_ids:
                        linked.setdefault(entity_id, [])
                        if row["id"] not in linked[entity_id]:
                            linked[entity_id].append(row["id"])
    # 两路都用完整问题：实体内按 ID 限定范围，全局按可见生效版本限定范围。
    ensure_keyword_versions(store, models, version_ids)
    groups = {}
    rrf_k = int((settings or {}).get("rrf_k", 60))

    def search_group(ids, limit, minimum):
        dense = target.search_relations(question_vector, version_ids, limit, ids=ids)
        lexical = target.search_relation_keywords(question, version_ids, limit, ids=ids)
        return hybrid_ranking(dense, lexical, minimum, rrf_k)

    for entity_id in entity_ids:
        groups[entity_id] = search_group(
            linked.get(entity_id, []), per_entity, entity_min
        )
    groups["global"] = search_group(
        None,
        int(setting(settings, "graph_relation_top_k")),
        setting(settings, "graph_relation_min_score"),
    )
    # 索引候选必须回查活动关系，避免过期索引占用名额。
    with store.engine.connect() as connection:
        details = relation_details(
            connection, {row["relation_id"] for rows in groups.values() for row in rows}
        )
    details = {key: row for key, row in details.items() if row["build_id"] in versions}
    for group in groups:
        groups[group] = [row for row in groups[group] if row["relation_id"] in details]
    candidates = select_candidates(
        groups,
        int(setting(settings, "graph_relation_rerank_candidates")),
        int(setting(settings, "graph_entity_relation_quota")),
        int(setting(settings, "graph_global_relation_quota")),
        rrf_k,
    )
    timings["entity_relations_ms"] = round((time.monotonic() - step) * 1000)
    step = time.monotonic()
    rerank_error = rerank_candidates(
        models,
        question,
        candidates,
        details,
        int(setting(settings, "graph_relation_return_limit")),
        setting(settings, "graph_relation_rerank_min_score"),
    )
    timings["relation_rerank_ms"] = round((time.monotonic() - step) * 1000)
    final_by_id = {item["relation_id"]: item for item in candidates}

    def view_candidate(row):
        final = final_by_id[row["relation_id"]]
        # 分片排名采用关系统一重排后的名次；失败时采用融合名次。
        score = 1 / (final.get("rerank_rank") or final["fusion_rank"])
        return {
            **relation_view(details[row["relation_id"]], versions, score),
            **row,
            **final,
            "score": score,
        }

    entity_relations = [
        {
            **view_candidate(row),
            "entity_id": group,
            "entity_name": (entity_rows.get(group) or {}).get("name"),
        }
        for group, rows in groups.items()
        if group != "global"
        for row in rows
    ]
    entity_kept_ids = {item["relation_id"] for item in entity_relations if item["kept"]}
    relation_matches = [
        {
            **view_candidate(row),
            "keyword": question,
            "also_entity": row["relation_id"] in entity_kept_ids,
        }
        for row in groups["global"]
    ]
    relation_candidates = [view_candidate(item) for item in candidates]
    # 合并列表沿用一个最佳路径的检索名次，并保留各来源的完整排名。
    for item in relation_candidates:
        for method in ("vector", "keyword"):
            matches = [
                row for row in item["retrieval_ranks"] if method + "_rank" in row
            ]
            if matches:
                best = min(matches, key=lambda row: row[method + "_rank"])
                item[method + "_rank"] = best[method + "_rank"]
                item[method + "_score"] = best[method + "_score"]
    timings["relations_ms"] = timings["relation_rerank_ms"]

    # ⑤ 取分片
    step = time.monotonic()
    # 统一重排留下的关系只生成一张分片排名表，不因召回路径重复贡献 RRF。
    tables = {
        "entity": [],
        "relation": [],
        "unified": chunk_table([item for item in relation_candidates if item["kept"]]),
    }
    sources_by_id = chunk_sources(
        store.engine,
        {item["chunk_id"] for table in tables.values() for item in table},
        document_versions,
    )
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
            item.update(
                kept=True,
                rank=rank,
                title=source["title"],
                text=source["text"],
                version=source["version"],
                heading=source["heading"],
            )
            rows.append(
                {**source, "score": item["score"], "relation_ids": item["relation_ids"]}
            )
        sources[name] = rows
    timings["chunks_ms"] = round((time.monotonic() - step) * 1000)

    unique = {item["id"] for rows in sources.values() for item in rows}
    candidate_counts = {
        "total": len(relation_candidates),
        "in_pool": sum(item["in_pool"] for item in relation_candidates),
        "kept": sum(item["kept"] for item in relation_candidates),
    }
    # 所有候选及其原文按分片去重保存，步骤详情可查看完整候选，不截掉进池前淘汰的记录。
    candidate_sources = chunk_sources(
        store.engine,
        {item["chunk_id"] for item in relation_candidates},
        document_versions,
    )
    candidate_chunks = [
        {
            "chunk_id": key,
            "title": row["title"],
            "text": row["text"],
            "heading": row.get("heading"),
            "version": row.get("version"),
        }
        for key, row in candidate_sources.items()
    ]
    timings["total_ms"] = round((time.monotonic() - started) * 1000)
    return {
        "status": "ok",
        "pipeline": "hybrid_relations_v2",
        "relation_candidates": relation_candidates,
        "relation_candidate_counts": candidate_counts,
        "candidate_chunks": candidate_chunks,
        "relation_rerank_error": rerank_error,
        "reason": None,
        "scope": graph_scope,
        "keywords": words,
        "name_matches": name_matches,
        "entities": found,
        "entity_relations": entity_relations,
        "relation_matches": relation_matches,
        "tables": tables,
        "sources": sources,
        "dropped_more": {
            "relation_candidates": 0,
            "names": 0,
            "entity_relations": 0,
            "relation_matches": 0,
        },
        "counts": {
            "entity_chunks": len(sources["entity"]),
            "relation_chunks": len(sources["relation"]),
            "chunks": len(unique),
        },
        "settings": {key: setting(settings, key) for key in DEFAULTS},
        "timings": timings,
    }
