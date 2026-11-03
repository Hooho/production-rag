import unicodedata
import uuid

from sqlalchemy import and_, delete, exists, select

from ..mysql.tables import (
    graph_aliases,
    graph_entities,
    graph_mentions,
    graph_merges,
    graph_relations,
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
def normalize(name, entity_type=None):
    text = unicodedata.normalize("NFKC", name or "")
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
        connection.execute(
            graph_entities.insert().values(
                id=entity["id"],
                space=space,
                name=entity["name"][:200],
                type=entity_type,
                merge_key=key,
                description=mention.get("description") or None,
                origin="extracted",
                created=timestamp,
                updated=timestamp,
            )
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


# 把一次建图的抽取结果写成名字、关系和合并记录，并归到全局实体。按分片顺序处理，结果是确定的。
# extractions：[{"id", "chunk_id", "document_id", "result"}]，只传成功（新抽取或复用）的。
def resolve_build(connection, space, build_id, extractions, created_by="system"):
    clear_build(connection, build_id)
    aliases = {
        row[0]: row[1]
        for row in connection.execute(
            select(graph_aliases.c.alias_key, graph_aliases.c.entity_id).where(
                graph_aliases.c.space == space
            )
        ).all()
    }
    cache = {"aliases": aliases, "entities": {}}
    methods = {}
    entity_ids = set()
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
                    },
                    "status": "applied",
                    "created_by": created_by,
                    "created": timestamp,
                }
            )
        if mention_rows:
            connection.execute(graph_mentions.insert(), mention_rows)
            connection.execute(graph_merges.insert(), merge_rows)
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
        if relation_rows:
            connection.execute(graph_relations.insert(), relation_rows)
            relation_count += len(relation_rows)
    remove_orphans(connection, space)
    return {
        "entity_count": len(entity_ids),
        "created_count": created_count,
        "relation_count": relation_count,
        "methods": methods,
    }
