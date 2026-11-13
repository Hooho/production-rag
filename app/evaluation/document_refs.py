"""评测常用文档引用；正文、分片、索引和图谱仍属于知识库。"""

from sqlalchemy import select
from ..mysql.store import settings, document_heads, documents, document_chunks, chunks
from ..retrieval_policy import selected_scope

KEY = "eval_document_references"


def saved(engine):
    with engine.connect() as connection:
        return list(
            connection.execute(
                select(settings.c.value).where(settings.c.key == KEY)
            ).scalar()
            or []
        )


def save(engine, keys):
    from .dataset import now_text

    with engine.begin() as connection:
        row = connection.execute(
            select(settings.c.key).where(settings.c.key == KEY)
        ).first()
        values = dict(value=list(dict.fromkeys(keys)), updated=now_text())
        if row:
            connection.execute(
                settings.update().where(settings.c.key == KEY).values(**values)
            )
        else:
            connection.execute(settings.insert().values(key=KEY, **values))


def candidates(engine):
    from ..graph.retrieve import scope_versions

    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(
                    document_heads,
                    documents.c.filename,
                    documents.c.status,
                    documents.c.content_sha256,
                )
                .select_from(
                    document_heads.join(
                        documents,
                        documents.c.id == document_heads.c.current_document_id,
                    )
                )
                .where(
                    document_heads.c.listed.is_(True), document_heads.c.owner != "eval"
                )
                .order_by(document_heads.c.title)
            )
            .mappings()
            .all()
        )
    result = []
    for row in rows:
        doc = {
            "document_id": row["current_document_id"],
            "title": row["title"],
            "version": row["current_version"],
            "owner": row["owner"],
            "source": "shared",
            "groups": [],
        }
        graph = scope_versions(engine, {"documents": [doc]})
        result.append(
            {
                "id": row["doc_key"],
                **doc,
                "filename": row["filename"],
                "sha256": row["content_sha256"] or "",
                "missing": not str(row["status"]).startswith("ready:"),
                "graph_ready": bool(graph),
                "graph_versions": [g["version_id"] for g in graph],
                "status": "imported",
                "chunks": int(str(row["status"]).split(":", 1)[1])
                if str(row["status"]).startswith("ready:")
                else 0,
                "char_count": 0,
                "created_by": row["owner"],
                "created": "",
            }
        )
    return result


def entries(engine):
    by_id = {item["id"]: item for item in candidates(engine)}
    return [
        by_id[key]
        if key in by_id
        else {
            "id": key,
            "title": "已删除的文档",
            "missing": True,
            "sha256": "",
            "filename": "",
            "char_count": 0,
            "created_by": "",
            "created": "",
            "status": "not_imported",
            "chunks": 0,
            "graph_ready": False,
        }
        for key in saved(engine)
    ]


def scope(engine):
    frozen = selected_scope()
    if frozen is not None:
        return frozen
    from ..tools.search import title_limit

    titles = title_limit("eval")
    docs = [
        item
        for item in entries(engine)
        if not item["missing"] and (titles is None or item["title"] in titles)
    ]
    return {
        "documents": docs,
        "versions": {item["document_id"]: item["version"] for item in docs},
    }


def rows(engine):
    ids = list(scope(engine)["versions"])
    with engine.connect() as connection:
        return connection.execute(
            select(
                chunks.c.id,
                chunks.c.title,
                chunks.c.text,
                chunks.c.content,
                document_chunks.c.position,
                document_chunks.c.chunk_metadata,
            )
            .select_from(
                document_chunks.join(chunks, chunks.c.id == document_chunks.c.chunk_id)
            )
            .where(document_chunks.c.document_id.in_(ids))
            .order_by(chunks.c.title, document_chunks.c.position)
        ).all()
