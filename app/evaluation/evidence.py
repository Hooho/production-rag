# 证据原文所在的分片：题目只标注证据原文，不存分片 id——语料重新导入、调了分片长度或开关上下文检索后，
# 分片 id 全会变，存下来的 id 会指错。所以在页面展开时现查：到评测语料当前的分片里找包含这句话的分片。
# 评测语料还没导入过（没跑过评测）时，按当前分片规则把语料文件临时切一遍，这时没有 token 数和截断位置。
# 本地向量模型能给出截断位置时，标出分片里哪一段没参与向量计算，截断专项可以直接看出证据有没有落在被截掉的部分。
import unicodedata

from sqlalchemy import select

from ..ingestion.chunking import chunk_document_records
from ..mysql.store import chunks, document_chunks, document_heads
from .dataset import corpus_files, normalize
from .retrieval import EVAL_OWNER


# 规范化后的文字（去空白、NFKC）中每个字符对应原文的下标，用来把规范化后的匹配位置换回原文位置。
def normalized_index(text):
    folded = []
    positions = []
    for index, character in enumerate(text):
        for piece in unicodedata.normalize("NFKC", character):
            if piece.isspace():
                continue
            folded.append(piece)
            positions.append(index)
    return "".join(folded), positions


# 证据在原文里的起止位置（忽略空白和全半角差异）；找不到返回 None。
def find_in(text, evidence):
    folded, positions = normalized_index(text)
    target = normalize(evidence)
    start = folded.find(target) if target else -1
    if start < 0:
        return None
    end = start + len(target) - 1
    return positions[start], positions[end] + 1


# 评测语料当前的全部分片：(分片 id, 标题, 送去算向量的文字, 正文, 元数据)。
def stored_chunks(store):
    joined = document_heads.join(document_chunks,
        document_chunks.c.document_id == document_heads.c.current_document_id).join(
        chunks, chunks.c.id == document_chunks.c.chunk_id)
    with store.engine.connect() as connection:
        rows = connection.execute(select(chunks.c.id, chunks.c.title, chunks.c.text, chunks.c.content,
            document_chunks.c.position, document_chunks.c.chunk_metadata).select_from(joined).where(
                document_heads.c.owner == EVAL_OWNER).order_by(chunks.c.title, document_chunks.c.position)).all()
    return [{"chunk_id": row[0], "title": row[1], "text": row[2], "content": row[3] or row[2],
        "position": row[4], "metadata": row[5] or {}} for row in rows]


def file_chunks():
    result = []
    for path in corpus_files():
        for position, record in enumerate(chunk_document_records(path.read_text(encoding="utf-8"))):
            result.append({"chunk_id": None, "title": path.stem, "text": record["embedding_text"],
                "content": record["content"], "position": position, "metadata": record})
    return result


def locate_evidence(store, models, texts):
    pool = stored_chunks(store)
    imported = bool(pool)
    if not imported:
        pool = file_chunks()
    items = []
    found = []
    for text in texts:
        matches = []
        for chunk in pool:
            span = find_in(chunk["content"], text)
            if span is None:
                continue
            metadata = chunk["metadata"]
            # 正文前面送去算向量的部分：标题路径，开了上下文检索时还有模型补的上下文说明。
            prefix = chunk["text"][:-len(chunk["content"])] if chunk["text"].endswith(chunk["content"]) else ""
            entry = {"chunk_id": chunk["chunk_id"], "title": chunk["title"], "position": chunk["position"],
                "heading": " / ".join(metadata.get("heading_path") or []) or None, "content": chunk["content"],
                "prefix": prefix.strip() or None, "match": list(span), "chars": len(chunk["content"]),
                "token_count": metadata.get("token_count"), "truncated": metadata.get("truncated"), "cut": None}
            matches.append(entry)
            found.append((entry, chunk["text"], len(prefix)))
        items.append({"text": text, "chunks": matches})
    # 截断位置换算到正文里：cut 落在前缀里，说明正文整段都没参与向量计算（记为 0）。
    cuts = models.truncation_cuts([text for _, text, _ in found]) if imported and found else None
    for (entry, _, prefix_length), cut in zip(found, cuts or []):
        entry["token_count"] = cut["tokens"]
        entry["max_tokens"] = cut["max_tokens"]
        entry["truncated"] = cut["cut"] is not None
        entry["cut"] = None if cut["cut"] is None else max(0, cut["cut"] - prefix_length)
    return {"imported": imported, "cuts_available": cuts is not None, "items": items}
