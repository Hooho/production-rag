from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from app.graph import resolve
from app.mysql.tables import (
    graph_aliases,
    graph_entities,
    graph_mentions,
    graph_merges,
    graph_relations,
    metadata,
)


def engine():
    value = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    metadata.create_all(value)
    return value


def entity(name, entity_type, canonical=None, description=""):
    return {
        "name": name,
        "canonical": canonical or name,
        "type": entity_type,
        "description": description,
    }


def extraction(extraction_id, chunk_id, entities, relations=(), document_id="doc-a"):
    return {
        "id": extraction_id,
        "chunk_id": chunk_id,
        "document_id": document_id,
        "result": {"entities": entities, "relations": list(relations)},
    }


def mentions(connection):
    rows = connection.execute(
        select(
            graph_mentions.c.name,
            graph_entities.c.name,
            graph_mentions.c.resolve_method,
        )
        .join(graph_entities, graph_entities.c.id == graph_mentions.c.entity_id)
        .order_by(graph_mentions.c.chunk_id, graph_mentions.c.name)
    ).all()
    return [tuple(row) for row in rows]


# 规范化：全角半角、空格、大小写、两边的书名号引号；组织再去掉一个常见后缀，名字太短时不去。
def test_normalize():
    assert resolve.normalize("Ａｐｐｌｅ  Inc.", "组织") == "apple"
    assert resolve.normalize("苹果公司", "组织") == "苹果"
    assert resolve.normalize("苹果股份有限公司", "组织") == "苹果"
    assert resolve.normalize("公司", "组织") == "公司"
    assert resolve.normalize("《穷查理宝典》", "作品") == "穷查理宝典"
    assert resolve.normalize("苹果公司", "产品") == "苹果公司"


# 第 1 期的合并规则：模型给的标准名、规范化后相同、名字相同才合并；类型不同不合并；模型没认出来的别名单独成实体。
def test_rules_merge_example():
    db = engine()
    items = [
        extraction(
            "e12",
            "c12",
            [entity("段永平", "人物"), entity("步步高", "组织")],
            [
                {
                    "source": "段永平",
                    "target": "步步高",
                    "category": "创办",
                    "description": "段永平创办步步高",
                }
            ],
        ),
        extraction(
            "e37",
            "c37",
            [entity("阿段", "人物", "段永平"), entity("苹果公司", "组织")],
            [
                {
                    "source": "阿段",
                    "target": "苹果公司",
                    "category": "投资",
                    "description": "买入苹果",
                }
            ],
        ),
        extraction(
            "e80", "c80", [entity("大道", "人物"), entity("Apple", "组织", "苹果")]
        ),
        extraction("e95", "c95", [entity("苹果", "产品")]),
    ]
    with db.begin() as connection:
        summary = resolve.resolve_build(connection, "online", "b1", items)
        assert mentions(connection) == [
            ("步步高", "步步高", "new"),
            ("段永平", "段永平", "new"),
            ("苹果公司", "苹果公司", "new"),
            ("阿段", "段永平", "canonical"),
            ("Apple", "苹果公司", "canonical"),
            ("大道", "大道", "new"),
            ("苹果", "苹果", "new"),
        ]
        names = sorted(
            connection.execute(
                select(graph_entities.c.name, graph_entities.c.type)
            ).all()
        )
        assert names == [
            ("大道", "人物"),
            ("步步高", "组织"),
            ("段永平", "人物"),
            ("苹果", "产品"),
            ("苹果公司", "组织"),
        ]
        # 关系的起点、终点存的是名字，不是实体。
        source = connection.execute(
            select(graph_mentions.c.name)
            .join(
                graph_relations,
                graph_relations.c.source_mention_id == graph_mentions.c.id,
            )
            .where(graph_relations.c.chunk_id == "c37")
        ).scalar_one()
        assert source == "阿段"
        assert (
            connection.execute(select(graph_merges.c.method))
            .scalars()
            .all()
            .count("canonical")
            == 2
        )
    assert (
        summary["entity_count"] == 5
        and summary["created_count"] == 5
        and summary["relation_count"] == 2
    )
    assert summary["methods"] == {"new": 5, "canonical": 2}


# 跨文档：另一份文档里同样的名字（或规范化后相同）挂到已有实体上，不新建。
def test_cross_document_merge():
    db = engine()
    with db.begin() as connection:
        resolve.resolve_build(
            connection,
            "online",
            "b1",
            [extraction("e1", "a1", [entity("苹果公司", "组织")])],
        )
        summary = resolve.resolve_build(
            connection,
            "online",
            "b2",
            [
                extraction(
                    "e2",
                    "b1",
                    [entity("苹果公司", "组织"), entity("苹果", "组织")],
                    document_id="doc-b",
                )
            ],
        )
        assert summary["created_count"] == 0
        methods = (
            connection.execute(
                select(graph_mentions.c.resolve_method)
                .where(graph_mentions.c.build_id == "b2")
                .order_by(graph_mentions.c.name)
            )
            .scalars()
            .all()
        )
        assert sorted(methods) == ["exact", "normalized"]
        # 别的空间（评测）不受影响，各建各的。
        other = resolve.resolve_build(
            connection,
            "eval-1",
            "b3",
            [extraction("e3", "c1", [entity("苹果公司", "组织")])],
        )
        assert other["created_count"] == 1


# 别名表里有的名字直接归到对应实体，优先于模型的标准名。
def test_alias_table_wins():
    db = engine()
    with db.begin() as connection:
        resolve.resolve_build(
            connection,
            "online",
            "b1",
            [extraction("e1", "c1", [entity("段永平", "人物")])],
        )
        entity_id = connection.execute(select(graph_entities.c.id)).scalar_one()
        connection.execute(
            graph_aliases.insert().values(
                id="a1",
                space="online",
                alias="大道",
                alias_key=resolve.merge_key("人物", "大道"),
                entity_id=entity_id,
                source="manual",
                created_by="admin",
                created="t",
            )
        )
        resolve.resolve_build(
            connection,
            "online",
            "b2",
            [extraction("e2", "c2", [entity("大道", "人物")])],
        )
        assert ("大道", "段永平", "alias") in mentions(connection)


# 重新合并同一次建图：先清掉这次写过的名字和关系，没人用的实体也删掉，不会重复。
def test_rebuild_is_idempotent_and_removes_orphans():
    db = engine()
    with db.begin() as connection:
        resolve.resolve_build(
            connection,
            "online",
            "b1",
            [
                extraction(
                    "e1", "c1", [entity("段永平", "人物"), entity("老段", "人物")]
                )
            ],
        )
        resolve.resolve_build(
            connection,
            "online",
            "b1",
            [extraction("e1", "c1", [entity("段永平", "人物")])],
        )
        assert connection.execute(select(graph_entities.c.name)).scalars().all() == [
            "段永平"
        ]
        assert len(connection.execute(select(graph_mentions.c.id)).all()) == 1
        assert len(connection.execute(select(graph_merges.c.id)).all()) == 1
