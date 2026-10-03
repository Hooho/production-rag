from datetime import datetime, timezone
import hashlib
from uuid import uuid4

from sqlalchemy import select

from app.models import Models
from app.mysql.store import chunks, document_chunks, document_heads, documents
from app.storage import Storage


BATCH_SIZE = 32


# 旧版 POST /documents 导入的文本没有文档记录，分片不属于任何文档。版本管理后检索只看当前版本，
# 这些分片会检索不到，因此按 (用户, 标题) 为它们补建一份文档和当前版本指针。
def adopt_orphan_chunks(store):
    now = datetime.now(timezone.utc).isoformat()
    with store.engine.begin() as connection:
        rows = connection.execute(select(chunks).where(chunks.c.id.not_in(
            select(document_chunks.c.chunk_id)))).mappings().all()
        groups = {}
        for row in rows:
            groups.setdefault((row["owner"], row["title"]), []).append(row)
        for (owner, title), items in groups.items():
            document_id = str(uuid4())
            connection.execute(documents.insert().values(id=document_id, owner=owner, title=title,
                filename=f"{title}.txt", path="", status=f"ready:{len(items)}", error=None,
                document_metadata={}, created=now, updated=now, doc_key=document_id, version=1))
            for position, item in enumerate(items):
                connection.execute(document_chunks.insert().values(document_id=document_id,
                    chunk_id=item["id"], position=position, chunk_metadata={}))
            connection.execute(document_heads.insert().values(doc_key=document_id, owner=owner,
                title=title, current_document_id=document_id, current_version=1, updated=now))
    return len(groups)


# MySQL 保存分片原文，Milvus 只是可重建的索引。集合结构变化后，把各文档当前版本的分片写入新集合；
# 已被取代或失败的版本不参与检索，不需要迁移。旧分片没有 chunk_key 的在这里补算。
def main():
    models = Models()
    store = Storage(models)
    try:
        adopted = adopt_orphan_chunks(store)
        print(f"为 {adopted} 组无文档记录的旧分片补建了文档")
        with store.engine.connect() as connection:
            rows = connection.execute(select(chunks.c.id, chunks.c.owner, chunks.c.title, chunks.c.text,
                chunks.c.chunk_key, document_chunks.c.document_id, document_chunks.c.position,
                document_chunks.c.chunk_metadata, documents.c.doc_key).select_from(
                    document_heads.join(document_chunks,
                        document_chunks.c.document_id == document_heads.c.current_document_id).join(
                    chunks, chunks.c.id == document_chunks.c.chunk_id).join(
                    documents, documents.c.id == document_chunks.c.document_id))).mappings().all()
        items = []
        for row in rows:
            item = dict(row)
            if not item["chunk_key"]:
                doc_key = item["doc_key"] or item["document_id"]
                item["chunk_key"] = hashlib.sha256(f"{doc_key}\n{item['text']}".encode()).hexdigest()
            items.append(item)
        for start in range(0, len(items), BATCH_SIZE):
            batch = items[start:start + BATCH_SIZE]
            texts = []
            for item in batch:
                texts.append(item["text"])
            vectors = models.embed(texts)
            data = []
            for item, vector in zip(batch, vectors):
                item["vector"] = vector
                item["position"] = item["position"] or 0
                data.append(store.vector_row(item, item["document_id"], item["chunk_metadata"]))
            store.milvus.upsert(data, timeout=30)
            with store.engine.begin() as connection:
                for item in batch:
                    connection.execute(chunks.update().where(chunks.c.id == item["id"]).values(
                        chunk_key=item["chunk_key"]))
            print(f"已写入 {start + len(batch)} / {len(items)}")
        print(f"完成：集合 {store.collection} 共写入 {len(items)} 个分片")
    finally:
        store.close()


if __name__ == "__main__":
    main()
