from sqlalchemy import false, func, select
from sqlalchemy.orm import aliased

from ..mysql.tables import (
    chunks,
    document_heads,
    documents,
    graph_builds,
    graph_chunk_extractions,
    graph_entities,
    graph_mentions,
    graph_merges,
    graph_relations,
    graph_schemas,
    users,
)
from .build import build_view
from .schemas import ONLINE_SPACE

NETWORK_LIMIT = 50
METHOD_LABELS = {
    "new": "新建实体",
    "exact": "名字相同",
    "normalized": "规范化后相同",
    "canonical": "模型标准名",
    "alias": "别名表",
}


# 这个文档版本最近的一次建图：优先用生效（active）的，没有就用最新的一次（正在建、失败的也能看到进度和原因）。
def latest_build(connection, document_id, space=ONLINE_SPACE):
    rows = (
        connection.execute(
            select(graph_builds)
            .where(
                graph_builds.c.document_id == document_id, graph_builds.c.space == space
            )
            .order_by(graph_builds.c.created.desc())
        )
        .mappings()
        .all()
    )
    if not rows:
        return None
    newest = rows[0]
    if newest["status"] in ("queued", "running"):
        return dict(newest)
    for row in rows:
        if row["active"]:
            return dict(row)
    return dict(newest)


def schema_name(connection, schema_id):
    row = connection.execute(
        select(graph_schemas.c.name, graph_schemas.c.version).where(
            graph_schemas.c.id == schema_id
        )
    ).first()
    return f"{row[0]} v{row[1]}" if row else schema_id


def build_summary(connection, build):
    if build is None:
        return None
    value = build_view(build)
    value["schema_name"] = schema_name(connection, build["schema_id"])
    return value


# 关系连同起点、终点的名字和实体一起读出来。builds 是要用的建图记录 id 列表。
def relation_rows(connection, build_ids, entity_id=None):
    if not build_ids:
        return []
    source = aliased(graph_mentions)
    target = aliased(graph_mentions)
    source_entity = aliased(graph_entities)
    target_entity = aliased(graph_entities)
    query = (
        select(
            graph_relations.c.id,
            graph_relations.c.build_id,
            graph_relations.c.document_id,
            graph_relations.c.chunk_id,
            graph_relations.c.category,
            graph_relations.c.description,
            graph_relations.c.evidence,
            graph_relations.c.origin,
            source.c.name.label("source_name"),
            target.c.name.label("target_name"),
            source_entity.c.id.label("source_id"),
            source_entity.c.name.label("source_entity"),
            source_entity.c.type.label("source_type"),
            target_entity.c.id.label("target_id"),
            target_entity.c.name.label("target_entity"),
            target_entity.c.type.label("target_type"),
            graph_chunk_extractions.c.position,
        )
        .select_from(
            graph_relations.join(
                source, source.c.id == graph_relations.c.source_mention_id
            )
            .join(target, target.c.id == graph_relations.c.target_mention_id)
            .join(source_entity, source_entity.c.id == source.c.entity_id)
            .join(target_entity, target_entity.c.id == target.c.entity_id)
            .join(
                graph_chunk_extractions,
                graph_chunk_extractions.c.id == graph_relations.c.extraction_id,
            )
        )
        .where(
            graph_relations.c.build_id.in_(build_ids),
            graph_relations.c.status == "active",
        )
    )
    if entity_id:
        query = query.where(
            (source_entity.c.id == entity_id) | (target_entity.c.id == entity_id)
        )
    rows = (
        connection.execute(query.order_by(graph_chunk_extractions.c.position))
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


# 一组建图里的实体：每个实体有几个名字、出现在几个分片、有几条关系。
def entity_rows(connection, build_ids):
    if not build_ids:
        return []
    rows = (
        connection.execute(
            select(
                graph_entities.c.id,
                graph_entities.c.name,
                graph_entities.c.type,
                func.max(graph_mentions.c.description).label("description"),
                func.count(graph_mentions.c.id).label("mention_count"),
                func.count(func.distinct(graph_mentions.c.name)).label("name_count"),
                func.count(func.distinct(graph_mentions.c.chunk_id)).label(
                    "chunk_count"
                ),
                func.count(func.distinct(graph_mentions.c.document_id)).label(
                    "document_count"
                ),
            )
            .select_from(
                graph_mentions.join(
                    graph_entities, graph_entities.c.id == graph_mentions.c.entity_id
                )
            )
            .where(graph_mentions.c.build_id.in_(build_ids))
            .group_by(
                graph_entities.c.id,
                graph_entities.c.name,
                graph_entities.c.type,
            )
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


def degrees(relations):
    value = {}
    for row in relations:
        for key in (row["source_id"], row["target_id"]):
            value[key] = value.get(key, 0) + 1
    return value


def entity_list(entities, relations):
    count = degrees(relations)
    result = []
    for row in entities:
        result.append({**row, "relation_count": count.get(row["id"], 0)})
    result.sort(
        key=lambda item: (-item["relation_count"], -item["mention_count"], item["name"])
    )
    return result


# 画图用的点和边。默认只取关系最多的 limit 个实体；focus 是点击展开的实体，它的邻居都加进来。
# 两个实体之间的多条关系合成一条边，记下条数、分类和前几条描述。
def network(
    entities,
    relations,
    limit=NETWORK_LIMIT,
    focus=None,
    entity_type=None,
    category=None,
):
    items = entity_list(entities, relations)
    if entity_type:
        items = [item for item in items if item["type"] == entity_type]
    if category:
        relations = [row for row in relations if row["category"] == category]
    allowed = {item["id"] for item in items}
    relations = [
        row
        for row in relations
        if row["source_id"] in allowed and row["target_id"] in allowed
    ]
    count = degrees(relations)
    ranked = sorted(
        items,
        key=lambda item: (
            -count.get(item["id"], 0),
            -item["mention_count"],
            item["name"],
        ),
    )
    chosen = {item["id"] for item in ranked[:limit]}
    for item_id in focus or []:
        if item_id in allowed:
            chosen.add(item_id)
            for row in relations:
                if row["source_id"] == item_id:
                    chosen.add(row["target_id"])
                elif row["target_id"] == item_id:
                    chosen.add(row["source_id"])
    edges = {}
    for row in relations:
        if row["source_id"] not in chosen or row["target_id"] not in chosen:
            continue
        key = (row["source_id"], row["target_id"])
        edge = edges.setdefault(
            key,
            {
                "id": f"{key[0]}>{key[1]}",
                "source": key[0],
                "target": key[1],
                "count": 0,
                "categories": [],
                "descriptions": [],
            },
        )
        edge["count"] += 1
        if row["category"] not in edge["categories"]:
            edge["categories"].append(row["category"])
        if row["description"] and len(edge["descriptions"]) < 3:
            edge["descriptions"].append(row["description"])
    nodes = [
        {
            "id": item["id"],
            "name": item["name"],
            "type": item["type"],
            "relation_count": count.get(item["id"], 0),
            "mention_count": item["mention_count"],
            "focus": item["id"] in (focus or []),
            "hidden_neighbors": 0,
        }
        for item in ranked
        if item["id"] in chosen
    ]
    shown = {node["id"] for node in nodes}
    for node in nodes:
        neighbors = set()
        for row in relations:
            if row["source_id"] == node["id"]:
                neighbors.add(row["target_id"])
            elif row["target_id"] == node["id"]:
                neighbors.add(row["source_id"])
        node["hidden_neighbors"] = len(neighbors - shown)
    return {
        "nodes": nodes,
        "edges": list(edges.values()),
        "total_entities": len(items),
        "total_relations": len(relations),
        "limit": limit,
    }


def page_slice(items, page, page_size):
    total = len(items)
    start = (page - 1) * page_size
    return {
        "items": items[start : start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def match(text, query):
    return query.lower() in (text or "").lower()


# 文档详情「实体关系」页签：这个版本最近一次建图的概览、图、实体表、关系表、合并记录。
def document_graph(
    engine,
    document_id,
    view="network",
    page=1,
    page_size=50,
    q=None,
    entity_type=None,
    category=None,
    focus=None,
):
    with engine.connect() as connection:
        build = latest_build(connection, document_id)
        history = [
            build_summary(connection, row)
            for row in connection.execute(
                select(graph_builds)
                .where(graph_builds.c.document_id == document_id)
                .order_by(graph_builds.c.created.desc())
                .limit(20)
            )
            .mappings()
            .all()
        ]
        summary = build_summary(connection, build)
        if build is None:
            return {"build": None, "history": history}
        status_counts = dict(
            connection.execute(
                select(graph_chunk_extractions.c.status, func.count())
                .where(graph_chunk_extractions.c.build_id == build["id"])
                .group_by(graph_chunk_extractions.c.status)
            ).all()
        )
        empty = connection.execute(
            select(func.count())
            .select_from(graph_chunk_extractions)
            .where(
                graph_chunk_extractions.c.build_id == build["id"],
                graph_chunk_extractions.c.status.in_(("extracted", "reused")),
                ~graph_chunk_extractions.c.id.in_(
                    select(graph_mentions.c.extraction_id).where(
                        graph_mentions.c.build_id == build["id"]
                    )
                ),
            )
        ).scalar_one()
        entities = entity_rows(connection, [build["id"]])
        relations = relation_rows(connection, [build["id"]])
        merges = merge_rows(connection, build["id"]) if view == "merges" else None
    type_counts = {}
    for row in entities:
        type_counts[row["type"]] = type_counts.get(row["type"], 0) + 1
    category_counts = {}
    for row in relations:
        category_counts[row["category"]] = category_counts.get(row["category"], 0) + 1
    result = {
        "build": summary,
        "history": history,
        "stats": {
            "entity_count": len(entities),
            "relation_count": len(relations),
            "type_counts": type_counts,
            "category_counts": category_counts,
            "status_counts": {
                "extracted": status_counts.get("extracted", 0),
                "reused": status_counts.get("reused", 0),
                "failed": status_counts.get("failed", 0),
                "empty": empty,
                "pending": max(0, summary["total"] - sum(status_counts.values())),
            },
        },
    }
    if view == "network":
        result["network"] = network(
            entities, relations, focus=focus, entity_type=entity_type, category=category
        )
    elif view == "entities":
        items = entity_list(entities, relations)
        if entity_type:
            items = [item for item in items if item["type"] == entity_type]
        if q:
            items = [item for item in items if match(item["name"], q)]
        result["entities"] = page_slice(items, page, page_size)
    elif view == "relations":
        items = relations
        if category:
            items = [row for row in items if row["category"] == category]
        if q:
            items = [
                row
                for row in items
                if any(
                    match(row[key], q)
                    for key in (
                        "source_entity",
                        "target_entity",
                        "source_name",
                        "target_name",
                        "description",
                    )
                )
            ]
        result["relations"] = page_slice(items, page, page_size)
    elif view == "merges":
        items = merges
        if q:
            items = [
                row
                for row in items
                if match(row["name"], q) or match(row["entity_name"], q)
            ]
        result["merges"] = page_slice(items, page, page_size)
    return result


# 合并记录：同一个名字归到同一个实体、用同一种方法的合成一行，列出出现在第几片。
def merge_rows(connection, build_id):
    rows = (
        connection.execute(
            select(
                graph_mentions.c.name,
                graph_merges.c.detail.label("merge_detail"),
                graph_mentions.c.canonical,
                graph_mentions.c.type,
                graph_mentions.c.resolve_method,
                graph_entities.c.id.label("entity_id"),
                graph_entities.c.name.label("entity_name"),
                graph_chunk_extractions.c.position,
                graph_mentions.c.chunk_id,
            )
            .select_from(
                graph_mentions.join(
                    graph_entities, graph_entities.c.id == graph_mentions.c.entity_id
                )
                .outerjoin(
                    graph_merges, graph_merges.c.mention_id == graph_mentions.c.id
                )
                .join(
                    graph_chunk_extractions,
                    graph_chunk_extractions.c.id == graph_mentions.c.extraction_id,
                )
            )
            .where(graph_mentions.c.build_id == build_id)
            .order_by(graph_chunk_extractions.c.position)
        )
        .mappings()
        .all()
    )
    grouped = {}
    for row in rows:
        scope = (row["merge_detail"] or {}).get("scope", "unknown")
        key = (row["name"], row["entity_id"], row["resolve_method"], scope)
        item = grouped.setdefault(
            key,
            {
                "scope": scope,
                "scope_label": {
                    "new": "新建实体",
                    "document": "文档内合并",
                    "global": "跨文档合并",
                    "unknown": "历史未记录",
                }.get(scope, "历史未记录"),
                "name": row["name"],
                "canonical": row["canonical"],
                "type": row["type"],
                "entity_id": row["entity_id"],
                "entity_name": row["entity_name"],
                "method": row["resolve_method"],
                "method_label": METHOD_LABELS.get(
                    row["resolve_method"], row["resolve_method"]
                ),
                "positions": [],
                "chunk_ids": [],
            },
        )
        item["positions"].append(row["position"])
        item["chunk_ids"].append(row["chunk_id"])
    order = {"canonical": 0, "alias": 1, "normalized": 2, "exact": 3, "new": 4}
    return sorted(
        grouped.values(),
        key=lambda item: (
            order.get(item["method"], 9),
            item["entity_name"],
            item["name"],
        ),
    )


# 每个分片的抽取情况，分块列表用：抽出的名字归到了哪个实体、关系、状态、提示词和原始输出。
def chunk_graph(engine, document_id, chunk_ids):
    with engine.connect() as connection:
        build = latest_build(connection, document_id)
        if build is None:
            return None, {}
        rows = (
            connection.execute(
                select(graph_chunk_extractions).where(
                    graph_chunk_extractions.c.build_id == build["id"],
                    graph_chunk_extractions.c.chunk_id.in_(chunk_ids),
                )
            )
            .mappings()
            .all()
        )
        mention_rows = (
            connection.execute(
                select(
                    graph_mentions.c.chunk_id,
                    graph_mentions.c.name,
                    graph_mentions.c.canonical,
                    graph_mentions.c.type,
                    graph_mentions.c.resolve_method,
                    graph_entities.c.id.label("entity_id"),
                    graph_entities.c.name.label("entity_name"),
                )
                .select_from(
                    graph_mentions.join(
                        graph_entities,
                        graph_entities.c.id == graph_mentions.c.entity_id,
                    )
                )
                .where(
                    graph_mentions.c.build_id == build["id"],
                    graph_mentions.c.chunk_id.in_(chunk_ids),
                )
            )
            .mappings()
            .all()
        )
        schema = schema_name(connection, build["schema_id"])
    mentions = {}
    for row in mention_rows:
        mentions.setdefault(row["chunk_id"], []).append(
            {
                **dict(row),
                "method_label": METHOD_LABELS.get(
                    row["resolve_method"], row["resolve_method"]
                ),
            }
        )
    result = {}
    for row in rows:
        names = {item["name"]: item for item in mentions.get(row["chunk_id"], [])}
        relations = []
        for item in (row["result"] or {}).get("relations") or []:
            relations.append(
                {
                    **item,
                    "source_entity": (names.get(item["source"]) or {}).get(
                        "entity_name"
                    ),
                    "target_entity": (names.get(item["target"]) or {}).get(
                        "entity_name"
                    ),
                }
            )
        entities = (row["result"] or {}).get("entities") or []
        result[row["chunk_id"]] = {
            "status": row["status"],
            "empty": row["status"] != "failed" and not entities,
            "error": row["error"],
            "reused_from": row["reused_from"],
            "input_tokens": row["input_tokens"],
            "output_tokens": row["output_tokens"],
            "duration_ms": row["duration_ms"],
            "prompt": row["prompt"],
            "raw_output": row["raw_output"],
            "mentions": [
                {
                    **names.get(item["name"], {}),
                    "name": item["name"],
                    "canonical": item.get("canonical"),
                    "type": item["type"],
                    "type_fixed_from": item.get("type_fixed_from"),
                    "description": item.get("description"),
                }
                for item in entities
            ],
            "relations": relations,
            "dropped": (row["result"] or {}).get("dropped") or [],
        }
    return {
        "build_id": build["id"],
        "status": build["status"],
        "schema_name": schema,
        "provider": build["provider"],
        "model": build["model"],
        "prompt_tag": build["prompt_tag"],
    }, result


# 分块列表按抽取状态筛选：返回符合条件的分片 id，以及各状态的数量。
def chunk_status_filter(engine, document_id, status):
    with engine.connect() as connection:
        build = latest_build(connection, document_id)
        if build is None:
            return None, None
        rows = connection.execute(
            select(
                graph_chunk_extractions.c.chunk_id,
                graph_chunk_extractions.c.status,
                graph_chunk_extractions.c.id,
            ).where(graph_chunk_extractions.c.build_id == build["id"])
        ).all()
        with_mentions = set(
            connection.execute(
                select(graph_mentions.c.extraction_id).where(
                    graph_mentions.c.build_id == build["id"]
                )
            )
            .scalars()
            .all()
        )
    groups = {"extracted": set(), "reused": set(), "failed": set(), "empty": set()}
    for chunk_id, value, extraction_id in rows:
        groups[value].add(chunk_id)
        if value != "failed" and extraction_id not in with_mentions:
            groups["empty"].add(chunk_id)
    counts = {key: len(value) for key, value in groups.items()}
    return (groups.get(status) if status else None), counts


# 全局可见的建图：每份文档当前版本上生效的那一次（下架的也算，管理员要能维护）。
def visible_builds(connection, space=ONLINE_SPACE, document_id=None):
    query = (
        select(graph_builds.c.id, graph_builds.c.document_id, document_heads.c.title)
        .select_from(
            graph_builds.join(
                document_heads,
                document_heads.c.current_document_id == graph_builds.c.document_id,
            )
        )
        .where(graph_builds.c.space == space, graph_builds.c.active.is_(True))
    )
    if document_id:
        query = query.where(graph_builds.c.document_id == document_id)
    return [dict(row._mapping) for row in connection.execute(query).all()]


# 全局「知识图谱」的总图：所有文档当前版本的图合在一起。
def overview(
    engine,
    document_id=None,
    entity_type=None,
    category=None,
    focus=None,
    q=None,
    limit=NETWORK_LIMIT,
):
    with engine.connect() as connection:
        builds = visible_builds(connection, document_id=document_id)
        build_ids = [row["id"] for row in builds]
        entities = entity_rows(connection, build_ids)
        relations = relation_rows(connection, build_ids)
    focus = list(focus or [])
    if q:
        hits = [row["id"] for row in entities if match(row["name"], q)]
        focus.extend(hits[:5])
    return {
        "documents": [
            {"document_id": row["document_id"], "title": row["title"]} for row in builds
        ],
        "network": network(
            entities,
            relations,
            limit=limit,
            focus=focus,
            entity_type=entity_type,
            category=category,
        ),
        "type_counts": count_by(entities, "type"),
        "category_counts": count_by(relations, "category"),
        "matches": [
            {"id": row["id"], "name": row["name"], "type": row["type"]}
            for row in entities
            if q and match(row["name"], q)
        ][:20],
    }


def count_by(rows, key):
    value = {}
    for row in rows:
        value[row[key]] = value.get(row[key], 0) + 1
    return value


# 实体详情：所有名字（各自出自哪片、怎么合并的）、出现在哪些文档、全部关系。document_id 给了就只看这份文档。
def entity_detail(engine, entity_id, document_id=None):
    with engine.connect() as connection:
        entity = (
            connection.execute(
                select(graph_entities).where(graph_entities.c.id == entity_id)
            )
            .mappings()
            .first()
        )
        if entity is None:
            return None
        if document_id:
            build = latest_build(connection, document_id)
            builds = (
                [{"id": build["id"], "document_id": document_id, "title": None}]
                if build
                else []
            )
        else:
            builds = visible_builds(connection)
        build_ids = [row["id"] for row in builds]
        titles = {
            row[0]: row[1]
            for row in connection.execute(
                select(documents.c.id, documents.c.title).where(
                    documents.c.id.in_([row["document_id"] for row in builds])
                )
            ).all()
        }
        mention_rows = (
            connection.execute(
                select(
                    graph_mentions.c.name,
                    graph_mentions.c.resolve_method,
                    graph_mentions.c.document_id,
                    graph_mentions.c.chunk_id,
                    graph_mentions.c.description,
                    graph_chunk_extractions.c.position,
                )
                .select_from(
                    graph_mentions.join(
                        graph_chunk_extractions,
                        graph_chunk_extractions.c.id == graph_mentions.c.extraction_id,
                    )
                )
                .where(
                    graph_mentions.c.entity_id == entity_id,
                    graph_mentions.c.build_id.in_(build_ids) if build_ids else false(),
                )
                .order_by(graph_chunk_extractions.c.position)
            )
            .mappings()
            .all()
        )
        if not mention_rows:
            return None
        # 全局实体描述可能来自私有文档；详情只采用当前可见出处的描述。
        entity = dict(entity)
        entity["description"] = next(
            (row["description"] for row in mention_rows if row["description"]), None
        )
        relations = relation_rows(connection, build_ids, entity_id=entity_id)
    names = {}
    documents_value = {}
    for row in mention_rows:
        item = names.setdefault(
            (row["name"], row["resolve_method"]),
            {
                "name": row["name"],
                "method": row["resolve_method"],
                "method_label": METHOD_LABELS.get(
                    row["resolve_method"], row["resolve_method"]
                ),
                "count": 0,
                "positions": [],
                "chunk_ids": [],
                "descriptions": [],
            },
        )
        item["count"] += 1
        item["positions"].append(row["position"])
        item["chunk_ids"].append(row["chunk_id"])
        if (
            row["description"]
            and row["description"] not in item["descriptions"]
            and len(item["descriptions"]) < 3
        ):
            item["descriptions"].append(row["description"])
        doc = documents_value.setdefault(
            row["document_id"],
            {
                "document_id": row["document_id"],
                "title": titles.get(row["document_id"]),
                "mention_count": 0,
                "relation_count": 0,
            },
        )
        doc["mention_count"] += 1
    for row in relations:
        row["direction"] = "out" if row["source_id"] == entity_id else "in"
        row["document_title"] = titles.get(row["document_id"])
        doc = documents_value.setdefault(
            row["document_id"],
            {
                "document_id": row["document_id"],
                "title": titles.get(row["document_id"]),
                "mention_count": 0,
                "relation_count": 0,
            },
        )
        doc["relation_count"] += 1
    return {
        "entity": dict(entity),
        "names": sorted(names.values(), key=lambda item: -item["count"]),
        "documents": sorted(
            documents_value.values(),
            key=lambda item: -(item["mention_count"] + item["relation_count"]),
        ),
        "relations": relations,
    }


# 建图任务：每份文档（当前版本）的建图状态。outdated：最近生效的图是给旧版本建的，当前版本还没建。
def tasks(engine, space=ONLINE_SPACE):
    with engine.connect() as connection:
        heads = (
            connection.execute(
                select(
                    document_heads.c.doc_key,
                    document_heads.c.title,
                    document_heads.c.owner,
                    document_heads.c.current_document_id,
                    document_heads.c.current_version,
                    document_heads.c.listed,
                    documents.c.status,
                    documents.c.document_metadata,
                )
                .select_from(
                    document_heads.join(
                        documents,
                        documents.c.id == document_heads.c.current_document_id,
                    )
                )
                .order_by(document_heads.c.title)
            )
            .mappings()
            .all()
        )
        builds = (
            connection.execute(
                select(graph_builds)
                .where(graph_builds.c.space == space)
                .order_by(graph_builds.c.created.desc())
            )
            .mappings()
            .all()
        )
        schemas = {
            row[0]: f"{row[1]} v{row[2]}"
            for row in connection.execute(
                select(
                    graph_schemas.c.id, graph_schemas.c.name, graph_schemas.c.version
                )
            ).all()
        }
        registered = set(connection.execute(select(users.c.username)).scalars().all())
    by_key = {}
    for row in builds:
        by_key.setdefault(row["doc_key"], []).append(dict(row))
    result = []
    for head in heads:
        # 评测账号导入的语料不是注册用户的文档，不在这里列出。
        if head["owner"] not in registered:
            continue
        items = by_key.get(head["doc_key"], [])
        current = [
            row for row in items if row["document_id"] == head["current_document_id"]
        ]
        latest = current[0] if current else None
        older = next(
            (
                row
                for row in items
                if row["active"] and row["document_id"] != head["current_document_id"]
            ),
            None,
        )
        if latest is not None:
            state = latest["status"]
        elif older is not None:
            state = "outdated"
        else:
            state = "none"
        shown = latest or older
        settings = (head["document_metadata"] or {}).get("graph") or {}
        result.append(
            {
                "doc_key": head["doc_key"],
                "document_id": head["current_document_id"],
                "title": head["title"],
                "owner": head["owner"],
                "version": head["current_version"],
                "listed": head["listed"],
                "processed": head["status"].startswith(
                    ("ready:", "staged:", "review:", "flagged:")
                ),
                "auto": bool(settings.get("enabled")),
                "state": state,
                "build": {
                    **build_view(shown),
                    "schema_name": schemas.get(shown["schema_id"], shown["schema_id"]),
                }
                if shown
                else None,
            }
        )
    return result


def edge_relations(engine, source_id, target_id, document_id=None, category=None):
    with engine.connect() as connection:
        if document_id:
            build = latest_build(connection, document_id)
            build_ids = [build["id"]] if build else []
        else:
            build_ids = [row["id"] for row in visible_builds(connection)]
        rows = [
            row
            for row in relation_rows(connection, build_ids, entity_id=source_id)
            if row["source_id"] == source_id
            and row["target_id"] == target_id
            and (not category or row["category"] == category)
        ]
        if not rows:
            return []
        texts = {
            row["id"]: row["content"] or row["text"] or ""
            for row in connection.execute(
                select(chunks.c.id, chunks.c.content, chunks.c.text).where(
                    chunks.c.id.in_({row["chunk_id"] for row in rows})
                )
            ).mappings()
        }
        titles = dict(
            connection.execute(
                select(documents.c.id, documents.c.title).where(
                    documents.c.id.in_({row["document_id"] for row in rows})
                )
            ).all()
        )
    return [
        {
            **row,
            "chunk_content": texts.get(row["chunk_id"], ""),
            "document_title": titles.get(row["document_id"]),
        }
        for row in rows
    ]
