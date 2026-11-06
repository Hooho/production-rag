import unicodedata
import uuid

from sqlalchemy import and_, delete, exists, or_, select

from ..mysql.tables import (
    graph_aliases,
    documents,
    graph_entities,
    graph_mentions,
    graph_merges,
    graph_relations,
    graph_versions,
)
from .schemas import now

ORGANIZATION_TYPE = "组织"
# 组织名常见的后缀，按长度从长到短去掉一个：「苹果公司」→「苹果」。只去后缀，名字本身不改。
ORGANIZATION_SUFFIXES = sorted(
    [
        "股份有限公司",
        "有限责任公司",
        "有限公司",
        "集团公司",
        "集团",
        "公司",
        "inc.",
        "inc",
        "ltd.",
        "ltd",
        "co.,ltd.",
        "co.,ltd",
        "corporation",
        "corp.",
        "corp",
    ],
    key=len,
    reverse=True,
)
QUOTES = "《》「」『』“”‘’\"'〈〉【】"
KEY_LENGTH = 255


# 规范化：全角转半角、去空格、英文小写、去掉两边的书名号和引号；组织再去掉一个常见后缀。
# 规则和 schemas.MATCHING_RULES 里给页面看的说明一致。
# PDF 解析出的原文里常有「部首补充」区的字（⻛险的 ⻛ 是 U+2EDB，不是常用的 风 U+98CE），
# 看起来一样，NFKC 却不转换（康熙部首区 ⼀ 等 NFKC 会转）。MySQL 默认比较规则又把它们当成同一个字，
# 程序和数据库判断不一致会导致合并键「重复」写入失败。规范化时统一转成常用字。
RADICALS = str.maketrans(
    {
        "\u2e9f": "母",
        "\u2ea0": "民",
        "\u2ea9": "王",
        "\u2eae": "竹",
        "\u2ec1": "虎",
        "\u2ec4": "西",
        "\u2ec5": "见",
        "\u2ec6": "角",
        "\u2ec8": "讠",
        "\u2ec9": "贝",
        "\u2ecb": "车",
        "\u2ed1": "長",
        "\u2ed3": "长",
        "\u2ed4": "门",
        "\u2ed8": "青",
        "\u2ed9": "韦",
        "\u2eda": "页",
        "\u2edb": "风",
        "\u2edc": "飞",
        "\u2edd": "食",
        "\u2ee2": "马",
        "\u2ee3": "骨",
        "\u2ee4": "鬼",
        "\u2ee5": "鱼",
        "\u2ee6": "鸟",
        "\u2ee7": "卤",
        "\u2ee8": "麦",
        "\u2ee9": "黄",
        "\u2eec": "齐",
        "\u2eee": "齿",
        "\u2ef0": "龙",
        "\u2ef3": "龟",
    }
)


def fold(text):
    """NFKC 再把部首补充区的字转成常用字。"""
    return unicodedata.normalize("NFKC", text or "").translate(RADICALS)


def normalize(name, entity_type=None):
    text = fold(name)
    text = "".join(text.split()).lower().strip(QUOTES)
    if entity_type == ORGANIZATION_TYPE:
        for suffix in ORGANIZATION_SUFFIXES:
            if text.endswith(suffix) and len(text) > len(suffix):
                text = text[: -len(suffix)]
                break
    return text


def merge_key(entity_type, name):
    return f"{entity_type}|{normalize(name, entity_type)}"[:KEY_LENGTH]


# 每个名字归到哪个实体、用的什么方法：
#   alias      别名表里有这个名字（第 3 期才能维护别名表）
#   canonical  模型给的标准名和原名不同（例如原名「阿段」、标准名「段永平」），按标准名合并
#   new        这个名字第一次出现，新建了实体
#   exact      和已有实体的标准名完全相同
#   normalized 规范化之后相同（例如「苹果公司」和「苹果」）
def resolve_mention(connection, space, mention, cache):
    entity_type = mention["type"]
    name_key = merge_key(entity_type, mention["name"])
    alias_key = name_key
    if alias_key in cache["aliases"]:
        entity_id = cache["aliases"][alias_key]
        return entity_id, "alias", False, alias_key
    canonical_key = merge_key(entity_type, mention["canonical"])
    key = canonical_key
    entity = cache["entities"].get(key)
    if entity is None:
        entity = connection.execute(
            select(graph_entities.c.id, graph_entities.c.name).where(
                graph_entities.c.space == space, graph_entities.c.merge_key == key
            )
        ).first()
        if entity is not None:
            entity = {"id": entity[0], "name": entity[1]}
            cache["entities"][key] = entity
    created = False
    if entity is None:
        timestamp = now()
        entity = {
            "id": str(uuid.uuid4()),
            "name": mention["canonical"] or mention["name"],
        }
        cache["new_entities"].append(
            {
                "id": entity["id"],
                "space": space,
                "name": entity["name"][:200],
                "type": entity_type,
                "merge_key": key,
                "description": mention.get("description") or None,
                "origin": "extracted",
                "created": timestamp,
                "updated": timestamp,
            }
        )
        cache["entities"][key] = entity
        created = True
    if canonical_key != name_key:
        method = "canonical"
    elif created:
        method = "new"
    elif mention["name"] == entity["name"]:
        method = "exact"
    else:
        method = "normalized"
    return entity["id"], method, created, key


# 去掉一次建图写入的名字、关系和合并记录（重新合并或补跑失败分片之前调用）。实体留着，最后统一清理没人用的。
def clear_build(connection, build_id):
    for table in (graph_relations, graph_mentions, graph_merges):
        connection.execute(delete(table).where(table.c.build_id == build_id))


# 删掉空间里已经没有任何名字归属的实体（建图时生成的；手动建的保留）。
def remove_orphans(connection, space):
    used = exists().where(graph_mentions.c.entity_id == graph_entities.c.id)
    connection.execute(
        delete(graph_entities).where(
            and_(
                graph_entities.c.space == space,
                graph_entities.c.origin == "extracted",
                ~used,
            )
        )
    )


# 只计算归属和待写入数据，不修改数据库；写入步骤统一事务提交。
# extractions：[{"id", "chunk_id", "document_id", "result"}]，只传成功（新抽取或复用）的。
def prepare_build(connection, space, build_id, extractions, created_by="system"):
    aliases = {
        row[0]: row[1]
        for row in connection.execute(
            select(graph_aliases.c.alias_key, graph_aliases.c.entity_id).where(
                graph_aliases.c.space == space
            )
        ).all()
    }
    cache = {"aliases": aliases, "entities": {}, "new_entities": []}
    mentions, merges, relations = [], [], []
    methods = {}
    entity_ids = set()
    scopes = {"new": 0, "document": 0, "global": 0}
    external_entities = {}
    document_ids = {row["document_id"] for row in extractions}
    doc_keys = set(
        connection.execute(
            select(documents.c.doc_key).where(documents.c.id.in_(document_ids))
        ).scalars()
    )
    doc_keys.discard(None)
    created_count = 0
    relation_count = 0
    timestamp = now()
    for extraction in extractions:
        result = extraction["result"] or {}
        by_name = {}
        mention_rows = []
        merge_rows = []
        for item in result.get("entities") or []:
            mention_id = str(uuid.uuid4())
            entity_id, method, created, key = resolve_mention(
                connection, space, item, cache
            )
            if created:
                scope = "new"
            elif entity_id in entity_ids:
                scope = "document"
            else:
                if entity_id not in external_entities:
                    external_entities[entity_id] = (
                        connection.execute(
                            select(graph_mentions.c.id)
                            .select_from(
                                graph_mentions.join(
                                    documents,
                                    documents.c.id == graph_mentions.c.document_id,
                                ).join(
                                    graph_versions,
                                    graph_versions.c.id == graph_mentions.c.build_id,
                                )
                            )
                            .where(
                                graph_mentions.c.entity_id == entity_id,
                                graph_versions.c.active.is_(True),
                                ~graph_mentions.c.document_id.in_(document_ids),
                                or_(
                                    documents.c.doc_key.is_(None),
                                    documents.c.doc_key.not_in(doc_keys),
                                )
                                if doc_keys
                                else True,
                            )
                            .limit(1)
                        ).first()
                        is not None
                    )
                scope = "global" if external_entities[entity_id] else "document"
            scopes[scope] += 1
            by_name[item["name"]] = mention_id
            entity_ids.add(entity_id)
            created_count += 1 if created else 0
            methods[method] = methods.get(method, 0) + 1
            mention_rows.append(
                {
                    "id": mention_id,
                    "build_id": build_id,
                    "extraction_id": extraction["id"],
                    "document_id": extraction["document_id"],
                    "chunk_id": extraction["chunk_id"],
                    "name": item["name"][:200],
                    "canonical": (item.get("canonical") or item["name"])[:200],
                    "type": item["type"],
                    "description": item.get("description") or None,
                    "entity_id": entity_id,
                    "resolve_method": method,
                    "origin": "extracted",
                }
            )
            merge_rows.append(
                {
                    "id": str(uuid.uuid4()),
                    "space": space,
                    "build_id": build_id,
                    "mention_id": mention_id,
                    "entity_id": entity_id,
                    "method": method,
                    "detail": {
                        "name": item["name"],
                        "canonical": item.get("canonical") or item["name"],
                        "type": item["type"],
                        "merge_key": key,
                        "entity_created": created,
                        "scope": scope,
                    },
                    "status": "applied",
                    "created_by": created_by,
                    "created": timestamp,
                }
            )
        mentions.extend(mention_rows)
        merges.extend(merge_rows)
        relation_rows = []
        for item in result.get("relations") or []:
            source = by_name.get(item["source"])
            target = by_name.get(item["target"])
            if source is None or target is None:
                continue
            relation_rows.append(
                {
                    "id": str(uuid.uuid4()),
                    "build_id": build_id,
                    "extraction_id": extraction["id"],
                    "document_id": extraction["document_id"],
                    "chunk_id": extraction["chunk_id"],
                    "source_mention_id": source,
                    "target_mention_id": target,
                    "category": item["category"],
                    "description": item.get("description") or None,
                    "evidence": item.get("evidence") or None,
                    "origin": "extracted",
                    "status": "active",
                }
            )
        relations.extend(relation_rows)
        relation_count += len(relation_rows)
    return {
        "entities": cache["new_entities"],
        "mentions": mentions,
        "merges": merges,
        "relations": relations,
        "summary": {
            "entity_count": len(entity_ids),
            "created_count": created_count,
            "mention_count": len(mentions),
            "relation_count": relation_count,
            "methods": methods,
            "scope_counts": scopes,
        },
    }


# build_id 是要写入的版本 id（见 versions.py）：名字、关系、合并记录都记在这个版本下；实体是空间里共用的。
def write_build(connection, space, build_id, plan):
    clear_build(connection, build_id)
    for table, key in (
        (graph_entities, "entities"),
        (graph_mentions, "mentions"),
        (graph_merges, "merges"),
        (graph_relations, "relations"),
    ):
        rows = (
            plan[key]
            if table is graph_entities
            else [{**row, "build_id": build_id} for row in plan[key]]
        )
        for start in range(0, len(rows), 500):
            connection.execute(table.insert(), rows[start : start + 500])
    remove_orphans(connection, space)
    return plan["summary"]


def resolve_build(connection, space, build_id, extractions, created_by="system"):
    plan = prepare_build(connection, space, build_id, extractions, created_by)
    return write_build(connection, space, build_id, plan)
