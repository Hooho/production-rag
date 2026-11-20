"""图谱版本：每次写入图谱都存成一个版本，检索只用生效的版本。

- 名字、关系、合并记录三张表的 build_id 列存的是版本 id；一次建图的第一个版本 id 和建图 id 相同。
- 生效按 doc_key 算：同一份文档（不论哪个文档版本、哪次建图）只有一个版本生效。
  graph_builds.active 跟着生效版本走，标出生效版本所在的那次建图。
- 每份文档（document_id）保留最近 KEEP 个版本，生效版本永远保留。
"""

import uuid

from sqlalchemy import delete, func, select, update

from ..mysql.tables import (
    graph_builds,
    graph_merges,
    graph_mentions,
    graph_relations,
    graph_versions,
)
from . import resolve
from .schemas import now

KEEP = 5


def get(connection, version_id):
    row = (
        connection.execute(
            select(graph_versions).where(graph_versions.c.id == version_id)
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


def listing(connection, document_id):
    rows = (
        connection.execute(
            select(graph_versions)
            .where(graph_versions.c.document_id == document_id)
            .order_by(graph_versions.c.number.desc())
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


# 写入前先登记一个版本，返回 {"id", "number"}；名字和关系用这个 id 写入。
def create(connection, build, origin, summary, created_by):
    taken = connection.execute(
        select(graph_versions.c.id).where(graph_versions.c.id == build["id"])
    ).first()
    version_id = str(uuid.uuid4()) if taken else build["id"]
    number = (
        connection.execute(
            select(func.max(graph_versions.c.number)).where(
                graph_versions.c.document_id == build["document_id"]
            )
        ).scalar()
        or 0
    ) + 1
    connection.execute(
        graph_versions.insert().values(
            id=version_id,
            build_id=build["id"],
            space=build["space"],
            document_id=build["document_id"],
            doc_key=build["doc_key"],
            number=number,
            active=False,
            origin=origin,
            summary=summary,
            created_by=created_by,
            created=now(),
        )
    )
    return {"id": version_id, "number": number}


# 设为生效：同一份文档的其他版本、其他建图都取消生效；建图记录上的实体数、关系数换成这个版本的。
def activate(connection, version_id):
    version = get(connection, version_id)
    if version is None:
        return None
    connection.execute(
        update(graph_versions)
        .where(
            graph_versions.c.space == version["space"],
            graph_versions.c.doc_key == version["doc_key"],
        )
        .values(active=False)
    )
    connection.execute(
        update(graph_versions)
        .where(graph_versions.c.id == version_id)
        .values(active=True)
    )
    connection.execute(
        update(graph_builds)
        .where(
            graph_builds.c.space == version["space"],
            graph_builds.c.doc_key == version["doc_key"],
            graph_builds.c.id != version["build_id"],
        )
        .values(active=False)
    )
    summary = version["summary"] or {}
    values = {"active": True, "updated": now()}
    for key in ("entity_count", "relation_count"):
        if key in summary:
            values[key] = summary[key]
    connection.execute(
        update(graph_builds)
        .where(graph_builds.c.id == version["build_id"])
        .values(**values)
    )
    return {**version, "active": True}


def remove(connection, version_ids):
    if not version_ids:
        return
    for table in (graph_relations, graph_mentions, graph_merges):
        connection.execute(delete(table).where(table.c.build_id.in_(version_ids)))
    connection.execute(
        delete(graph_versions).where(graph_versions.c.id.in_(version_ids))
    )


# 只保留最近 keep 个版本（生效版本永远保留），删掉其余版本的名字、关系、合并记录，再清理没人用的实体。
def prune(connection, document_id, keep=KEEP):
    rows = listing(connection, document_id)
    removed = [
        row["id"]
        for index, row in enumerate(rows)
        if index >= keep and not row["active"]
    ]
    remove(connection, removed)
    for space in {row["space"] for row in rows if row["id"] in removed}:
        resolve.remove_orphans(connection, space)
    return removed


# 文档页签要显示的版本：指定了就用指定的（必须是这份文档的）；否则用这次建图里生效的版本，没有就用最新的。
def display(connection, build, version_id=None):
    if build is None:
        return None
    if version_id:
        version = get(connection, version_id)
        return (
            version
            if version and version["document_id"] == build["document_id"]
            else None
        )
    rows = (
        connection.execute(
            select(graph_versions)
            .where(graph_versions.c.build_id == build["id"])
            .order_by(graph_versions.c.active.desc(), graph_versions.c.number.desc())
        )
        .mappings()
        .all()
    )
    return dict(rows[0]) if rows else None


# 读名字、关系时用的 id：有版本就用版本 id；还没写入过的（正在建图）退回建图 id。
def read_id(connection, build, version_id=None):
    version = display(connection, build, version_id)
    return version["id"] if version else build["id"]
