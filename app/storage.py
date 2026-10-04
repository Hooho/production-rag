from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import logging
import math

from sqlalchemy import and_, delete, func, or_, select, text

from . import runtime_config
from .milvus.store import MilvusStore
from .mysql.store import (MySQLStore, chunks, document_chunks, document_heads, document_permissions, document_shares,
    document_steps, documents, metadata, orders, runs, sessions, settings, user_group_members, user_groups, users)
from .redis.store import RedisStore
from .models import CHUNK_CONTEXT_PROMPT_VERSION
from .ingestion.chunking import chunk_document_records, chunk_settings
from .ingestion.parser import OCR_LANGUAGES


logger = logging.getLogger("production-rag")
# Contextual Retrieval 每次请求带给模型的文档长度上限。整本书一次放不进上下文窗口，
# 长文档按这个长度分段，每个分片只带它所在的那一段；同一段的请求前缀相同，模型服务端的缓存仍能命中。
CONTEXT_DOCUMENT_CHARS = 20000
# 为分片生成上下文时的并发请求数。一本书上百个分片逐个请求要好几分钟，少量并发即可明显缩短导入时间。
CONTEXT_WORKERS = 4
# 分片上下文说明在 Redis 里的缓存时间。以前任何一步失败重试、worker 重启或重新上传，
# 都要把几百个分片的上下文重新交给大模型生成（一本书十几分钟，还要重复付费）；缓存后只生成缓存里没有的。
CONTEXT_CACHE_SECONDS = 7 * 24 * 3600

class Storage:
    """组合 MySQL、Redis 和 Milvus，供 API 注入单一运行时容器。"""

    def __init__(self, models):
        self.mysql = MySQLStore()
        self.redis = RedisStore()
        self.milvus = MilvusStore(models)
        self.engine = self.mysql.engine
        # 设置页保存的系统参数从这个库读取（api、worker 和各个脚本都经过这里）。
        runtime_config.bind(self.engine)
        self.cache = self.redis.client
        self.collection = self.milvus.collection

    # 把一个文档版本切分、向量化并写入 Milvus 和 MySQL。写入后该版本对检索仍不可见，
    # 要等 activate_version 把 document_heads 指向它；处理失败时旧版本继续服务。
    def ingest(self, owner, title, content, models, document_id, doc_key, on_stage=None,
               sections=None, source_format=None):
        # 分片大小和重叠在切分前取一次，记进文档和分片的元数据：设置页改了以后，已导入的文档保持原来的切法。
        chunk_size, chunk_overlap = chunk_settings()
        records = chunk_document_records(content, sections=sections, source_format=source_format,
            chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        pieces = []
        for record in records:
            pieces.append(record["embedding_text"])
        contextual = getattr(models, "contextual", False)
        # 记录这个版本是否带了上下文说明：开关变化后，旧版本的向量不能复用，相同内容也要重新导入。
        self.mysql.update_document_metadata(document_id, {
            "chunking_strategy": "heading_paragraph_sentence",
            "chunk_size": chunk_size, "overlap": chunk_overlap,
            "embedding_model": models.embedding_model,
            "embedding_dimension": models.dimension,
            "contextual_retrieval": contextual,
        })
        if on_stage:
            on_stage("chunking", "completed", "文本已按标题、段落和句子边界切分", {
                "chunk_count": len(pieces), "chunk_size": chunk_size,
                "overlap": chunk_overlap, "strategy": "heading_paragraph_sentence"})
        # 增量 embedding：以前每个新版本都把全部分片重新送去 embedding，改一段也要全量重算。
        # 现在先按 chunk_key 找出和当前版本文字相同的分片，复用它们的向量，只计算新增或改过的分片。
        # chunk_key 仍按不含上下文说明的文字计算：模型每次写的说明可能措辞不同，算进去就再也复用不上了。
        keys = []
        for piece in pieces:
            keys.append(hashlib.sha256(f"{doc_key}\n{piece}".encode()).hexdigest())
        reusable = self.reusable_vectors(doc_key, document_id, keys, models)
        # texts 是实际写入 Milvus text 字段、参与向量和 BM25 的文字：开启 Contextual Retrieval 时为"上下文说明 + 分片"。
        # 复用的分片直接沿用上一版本的文字，其中已经带着当时生成的说明，不用再调用模型。
        texts = list(pieces)
        missing_indexes = []
        for index, key in enumerate(keys):
            if key in reusable:
                texts[index] = reusable[key]["text"]
            else:
                missing_indexes.append(index)
        contexts = {}
        cached_indexes = set()
        if contextual and missing_indexes:
            contexts, cached_count, failed = self.chunk_contexts(models, document_id, content, pieces,
                missing_indexes, on_stage, cached_out=cached_indexes)
            self.mysql.update_document_metadata(document_id, {
                "context_generated": len(contexts), "context_cached": cached_count, "context_failed": failed})
            for index, context in contexts.items():
                texts[index] = f"{context}\n{pieces[index]}"
        missing = []
        for index in missing_indexes:
            missing.append(texts[index])
        if on_stage:
            on_stage("embedding", "running", "正在调用本地向量模型", {
                "input_count": len(missing), "reused_count": len(pieces) - len(missing)})
        computed = models.embed(missing) if missing else []
        embeddings = []
        next_computed = 0
        for key in keys:
            if key in reusable:
                embeddings.append(reusable[key]["vector"])
            else:
                embeddings.append(computed[next_computed])
                next_computed += 1
        # 按实际送进向量模型的文字（标题路径 + 上下文说明 + 分片）统计 token 数。
        # 以前只记字符数，而 bge-small-zh 只读前 512 个 token，800 字的中文分片加上前缀很容易超限被静默截断。
        token_counts, max_tokens = models.token_counts(texts) if hasattr(models, "token_counts") else (None, None)
        truncated_count = 0
        if token_counts:
            for count in token_counts:
                if count > max_tokens:
                    truncated_count += 1
        self.mysql.update_document_metadata(document_id, {
            "reused_vectors": len(pieces) - len(missing), "embedded_vectors": len(missing),
            "max_embedding_tokens": max_tokens,
            "max_chunk_tokens": max(token_counts) if token_counts else None,
            "truncated_chunks": truncated_count if token_counts else None})
        if on_stage:
            on_stage("embedding", "completed",
                f"分片已转换为向量：复用上一版本 {len(pieces) - len(missing)} 个，新计算 {len(missing)} 个", {
                "vector_count": len(embeddings), "dimension": models.dimension,
                "model": models.embedding_model, "reused_count": len(pieces) - len(missing),
                "embedded_count": len(missing)})
        rows = []
        for index, (record, piece, vector) in enumerate(zip(records, texts, embeddings)):
            # 以前主键是 sha256(用户:标题:全文:序号)：全文参与计算，改一个字所有分片 ID 都变，
            # 而且没有文档标识时只能靠全文区分"同名不同内容"。现在有了版本 id，主键直接用"版本 id:序号"，
            # 每个版本各写各的行，不会覆盖旧版本，也不会因为新版本分片更少而残留旧分片。
            chunk_id = f"{document_id}:{index}"
            chunk_key = keys[index]
            chunk_metadata = dict(record)
            chunk_metadata.pop("content")
            chunk_metadata.pop("embedding_text")
            chunk_metadata.update({"chunking_strategy": "heading_paragraph_sentence",
                "chunk_size": chunk_size, "overlap": chunk_overlap})
            # 记录真实 token 数和是否超过模型上限；拿不到分词结果时保持为空，不猜测。
            if token_counts:
                chunk_metadata["token_count"] = token_counts[index]
                chunk_metadata["truncated"] = token_counts[index] > max_tokens
            # 单独保存上下文说明，知识库页面和排查检索问题时可以直接看到模型为这个分片补了什么。
            if piece != pieces[index] and piece.endswith(pieces[index]):
                chunk_metadata["context"] = piece[:-len(pieces[index])].strip()
            # 每个分片记下向量和上下文说明从哪来，分块列表据此标出"复用 / 新计算"：
            # 以前只有整份文档"复用 X 个，新计算 Y 个"，看不出具体是哪些分片。
            if chunk_key in reusable:
                chunk_metadata["vector_source"] = "reused"
                chunk_metadata["reused_from"] = reusable[chunk_key].get("id")
            else:
                chunk_metadata["vector_source"] = "computed"
            if contextual:
                if chunk_key in reusable:
                    chunk_metadata["context_source"] = "reused" if chunk_metadata.get("context") else "failed"
                elif index in contexts:
                    chunk_metadata["context_source"] = "cached" if index in cached_indexes else "generated"
                else:
                    chunk_metadata["context_source"] = "failed"
            rows.append({"id": chunk_id, "chunk_key": chunk_key,
                "owner": owner, "title": title, "text": piece, "content": record["content"],
                "position": index, "vector": vector, "chunk_metadata": chunk_metadata})
        if on_stage:
            on_stage("indexing", "running", "正在写入 Milvus 向量与全文索引和 MySQL 分片", {
                "chunk_count": len(rows)})
        vector_rows = []
        for row in rows:
            vector_rows.append(self.vector_row(row, document_id, row["chunk_metadata"]))
        if vector_rows:
            self.milvus.upsert(vector_rows)
        with self.engine.begin() as connection:
            for row in rows:
                connection.execute(chunks.insert().values(id=row["id"], owner=row["owner"],
                    title=row["title"], text=row["text"], content=row["content"], chunk_key=row["chunk_key"]))
                connection.execute(document_chunks.insert().values(
                    document_id=document_id, chunk_id=row["id"], position=row["position"],
                    chunk_metadata=row["chunk_metadata"]))
        if on_stage:
            on_stage("indexing", "completed", "向量、全文索引和分片均已写入", {
                "milvus_count": len(rows), "keyword_count": len(rows)})
        return len(rows)

    # 为需要新计算的分片生成上下文说明，返回 {分片序号: 说明}。
    # 单个分片生成失败只跳过这一片（沿用不带说明的文字），不让整份文档导入失败；失败数量记录到文档元数据。
    # cached_out 传入集合时，把命中缓存的分片序号放进去，入库时据此给每个分片记上下文说明的来源。
    def chunk_contexts(self, models, document_id, content, pieces, indexes, on_stage=None, cached_out=None):
        if on_stage:
            on_stage("context", "running", f"正在为 {len(indexes)} 个分片生成上下文说明", {
                "input_count": len(indexes), "model": getattr(models, "llm_model", None)})
        block_count = max(1, math.ceil(len(content) / CONTEXT_DOCUMENT_CHARS))

        # 按分片在文档中的先后位置估算它落在哪一段，只把那一段交给模型。
        # 先查缓存：键由提示词版本、模型、所在原文段落和分片文字共同决定，任何一项变了都不会误用旧说明。
        # 生成失败的不写缓存，下次仍会重新生成。缓存读写失败只当作未命中，不影响导入。
        def generate(index):
            block = min(block_count - 1, index * block_count // len(pieces))
            document = content[block * CONTEXT_DOCUMENT_CHARS:(block + 1) * CONTEXT_DOCUMENT_CHARS]
            identity = json.dumps([CHUNK_CONTEXT_PROMPT_VERSION, getattr(models, "llm_model", None),
                document, pieces[index]], ensure_ascii=False)
            key = "chunk-context:" + hashlib.sha256(identity.encode()).hexdigest()
            try:
                cached = self.cache.get(key)
            except Exception:
                cached = None
            if cached:
                return index, cached, True
            try:
                context = models.chunk_context(document, pieces[index])
            except Exception:
                logger.exception("chunk_context_failed document_id=%s index=%s", document_id, index)
                return index, None, False
            if context:
                try:
                    self.cache.set(key, context, ex=CONTEXT_CACHE_SECONDS)
                except Exception:
                    logger.warning("chunk_context_cache_write_failed document_id=%s index=%s", document_id, index)
            return index, context, False

        contexts = {}
        failed = 0
        cached_count = 0
        with ThreadPoolExecutor(max_workers=CONTEXT_WORKERS) as executor:
            for index, context, from_cache in executor.map(generate, indexes):
                if context:
                    contexts[index] = context
                    if from_cache:
                        cached_count += 1
                        if cached_out is not None:
                            cached_out.add(index)
                else:
                    failed += 1
        if on_stage:
            on_stage("context", "completed",
                f"已为 {len(contexts)} 个分片生成上下文说明（其中 {cached_count} 个来自缓存），失败 {failed} 个", {
                "generated_count": len(contexts), "cached_count": cached_count, "failed_count": failed,
                "document_blocks": block_count})
        return contexts, cached_count, failed

    # 为一个已完成版本里缺少上下文说明的分片（当初生成失败的）补生成说明，重算这些分片的向量并原地更新。
    # 以前生成失败的分片只能一直用不带说明的文字，想补上只能整份文档重新导入；现在只处理这几个分片。
    # content 必须和导入时的全文一致，分片才能分到同一段原文；
    # 返回 (需要补的数量, 补成功的数量, 仍失败的数量, 现在带说明的分片总数)。
    def retry_failed_contexts(self, models, document_id, content):
        with self.engine.connect() as connection:
            rows = connection.execute(select(chunks.c.id, chunks.c.owner, chunks.c.title, chunks.c.text,
                chunks.c.chunk_key, document_chunks.c.position, document_chunks.c.chunk_metadata).select_from(
                document_chunks.join(chunks, chunks.c.id == document_chunks.c.chunk_id)).where(
                document_chunks.c.document_id == document_id).order_by(document_chunks.c.position)).mappings().all()
        pieces = []
        missing = []
        for index, row in enumerate(rows):
            context = (row["chunk_metadata"] or {}).get("context")
            # 早期版本把推理模型的思考过程（<think>…）当成说明写了进去，按缺少说明处理，重新生成。
            if context and "<think" in context:
                if row["text"].startswith(context + "\n"):
                    row = {**row, "text": row["text"][len(context) + 1:]}
                context = None
            # 已有说明的分片，text 是"说明\n分片"，去掉说明得到原始分片文字，用来计算所在原文段落。
            if context and row["text"].startswith(context + "\n"):
                pieces.append(row["text"][len(context) + 1:])
            else:
                pieces.append(row["text"])
            if not context:
                missing.append(index)
        if not missing:
            return 0, 0, 0, len(rows)
        cached_indexes = set()
        contexts, _, failed = self.chunk_contexts(models, document_id, content, pieces, missing,
            cached_out=cached_indexes)
        if contexts:
            indexes = sorted(contexts)
            texts = []
            for index in indexes:
                texts.append(f"{contexts[index]}\n{pieces[index]}")
            vectors = models.embed(texts)
            token_counts, max_tokens = models.token_counts(texts) if hasattr(models, "token_counts") else (None, None)
            vector_rows = []
            updates = []
            for offset, index in enumerate(indexes):
                row = rows[index]
                chunk_metadata = dict(row["chunk_metadata"] or {})
                chunk_metadata["context"] = contexts[index]
                chunk_metadata["context_source"] = "cached" if index in cached_indexes else "generated"
                if token_counts:
                    chunk_metadata["token_count"] = token_counts[offset]
                    chunk_metadata["truncated"] = token_counts[offset] > max_tokens
                vector_rows.append(self.vector_row({"id": row["id"], "owner": row["owner"], "title": row["title"],
                    "text": texts[offset], "position": row["position"], "vector": vectors[offset],
                    "chunk_key": row["chunk_key"]}, document_id, chunk_metadata))
                updates.append((row["id"], texts[offset], chunk_metadata))
            # 先写 Milvus 再写 MySQL：Milvus 失败时 MySQL 不变，分片仍显示为缺少说明，可以再次补全。
            self.milvus.upsert(vector_rows)
            with self.engine.begin() as connection:
                for chunk_id, text_value, chunk_metadata in updates:
                    connection.execute(chunks.update().where(chunks.c.id == chunk_id).values(text=text_value))
                    connection.execute(document_chunks.update().where(document_chunks.c.document_id == document_id,
                        document_chunks.c.chunk_id == chunk_id).values(chunk_metadata=chunk_metadata))
        # 补全之后这个版本就是带上下文说明的了；导入时没开开关的版本也一样，后续新版本才能复用它的向量。
        self.mysql.update_document_metadata(document_id, {
            "context_generated": len(rows) - failed, "context_failed": failed, "contextual_retrieval": True})
        return len(missing), len(contexts), failed, len(rows) - failed

    # 统计一个版本里缺少上下文说明的分片：没有说明，或早期把思考过程（<think>…）当成了说明。
    # 以前"补全"按钮只看导入时记下的失败数（context_failed），带思考过程的、或导入时没开 Contextual Retrieval 的
    # 都算不进去，页面上看到没有说明却没有办法补。
    def missing_context_count(self, document_id):
        with self.engine.connect() as connection:
            rows = connection.execute(select(document_chunks.c.chunk_metadata).where(
                document_chunks.c.document_id == document_id)).scalars().all()
        count = 0
        for metadata_value in rows:
            context = (metadata_value or {}).get("context")
            if not context or "<think" in context:
                count += 1
        return count

    # 从同一文档的当前版本中取出可复用的向量和文字，返回 {chunk_key: {"vector": 向量, "text": 文字}}。
    # 只复用当前版本：它的数据一定完整；旧版本激活新版本后就被删除了。
    # 向量必须一起取回，因为新版本要写成新的行（主键"新版本 id:序号"），写入时要带上向量值本身。
    def reusable_vectors(self, doc_key, document_id, keys, models):
        with self.engine.connect() as connection:
            current = connection.execute(select(documents.c.id, documents.c.document_metadata).select_from(
                document_heads.join(documents, documents.c.id == document_heads.c.current_document_id)).where(
                    document_heads.c.doc_key == doc_key)).first()
        # 第一版没有可复用的；对账重建当前版本时它自己的数据已被清掉，也不能复用。
        if current is None or current[0] == document_id:
            return {}
        # 不同模型的向量不在同一个空间，混在一起检索结果没有意义；模型或维度不同就全部重新计算。
        current_metadata = current[1] or {}
        if current_metadata.get("embedding_model") != models.embedding_model or \
                current_metadata.get("embedding_dimension") != models.dimension:
            return {}
        # 上一版本带不带上下文说明必须和这次一致，否则复用过来的向量和文字与开关状态不符。
        if bool(current_metadata.get("contextual_retrieval")) != getattr(models, "contextual", False):
            return {}
        unique_keys = []
        for key in keys:
            if key not in unique_keys:
                unique_keys.append(key)
        vectors = {}
        try:
            rows = self.milvus.query_chunks(current[0], unique_keys)
            for row in rows:
                # 带着思考过程的旧说明不复用，这个分片按新分片重新生成说明和向量。
                if "<think" in (row.get("text") or ""):
                    continue
                vector = []
                for value in row["vector"]:
                    vector.append(float(value))
                vectors[row["chunk_key"]] = {"vector": vector, "text": row["text"], "id": row.get("id")}
        except Exception:
            # 复用只是省时间，查不到就退回全量计算，不能因此让导入失败。
            logger.exception("reuse_vectors_failed document_id=%s", document_id)
            return {}
        return vectors

    # 组装写入 Milvus 的一行；导入和 reindex 迁移共用，保证字段一致。
    @staticmethod
    def vector_row(row, document_id, chunk_metadata):
        chunk_metadata = chunk_metadata or {}
        page_start = chunk_metadata.get("page_start")
        heading_path = chunk_metadata.get("heading_path") or []
        return {"id": row["id"], "owner": row["owner"], "title": row["title"], "text": row["text"],
            "position": row["position"], "vector": row["vector"], "document_id": document_id,
            "chunk_key": row["chunk_key"], "page_start": page_start if page_start is not None else -1,
            "heading": " / ".join(heading_path)}

    # 为上传分配 doc_key 和版本号。替换已有文档时沿用它的 doc_key，版本号为已有最大版本加 1；
    # 并发上传可能算出相同版本号，由 (doc_key, version) 唯一约束拒绝后一个。
    def next_version(self, owner, replace_document_id=None):
        if replace_document_id is None:
            return None, 1
        with self.engine.connect() as connection:
            row = connection.execute(select(documents.c.doc_key).where(
                documents.c.id == replace_document_id, documents.c.owner == owner)).first()
            if row is None:
                raise LookupError("要替换的文档不存在")
            doc_key = row[0] or replace_document_id
            latest = connection.execute(select(func.max(documents.c.version)).where(
                documents.c.doc_key == doc_key)).scalar_one()
        return doc_key, (latest or 0) + 1

    # 按内容 sha256 查找重复：指定了替换目标时只和它的当前版本比较，否则和该用户所有文档的当前版本比较。
    # 内容完全相同就不必再解析和向量化，返回已有的当前版本 id。
    # contextual 是当前 Contextual Retrieval 开关：替换同一文档（指定 doc_key）时，已有版本的开关状态不同就不算重复，
    # 否则打开开关后用同一份文件替换会被当成重复跳过，永远得不到带上下文说明的索引。
    # 不指定替换目标的新上传仍按内容去重，避免同一份文件变成两份文档。
    def find_duplicate(self, owner, content_sha256, doc_key=None, contextual=None):
        condition = and_(document_heads.c.owner == owner, documents.c.content_sha256 == content_sha256)
        if doc_key is not None:
            condition = and_(condition, document_heads.c.doc_key == doc_key)
        with self.engine.connect() as connection:
            rows = connection.execute(select(documents.c.id, documents.c.document_metadata).select_from(
                document_heads.join(documents, documents.c.id == document_heads.c.current_document_id)).where(
                    condition)).all()
        # 内容相同但上下文检索开关、分片大小或重叠和当前设置不同，不算重复：重新上传就按当前设置重新切分、
        # 重新算向量（评测语料也靠这个在下次评测时自动按新设置重新导入）。没记分片参数的老文档按 800 / 120 算。
        # PDF 的 OCR 语言和当前不同（以前没设置，按英文认）也不算重复，重新上传同一份扫描件就会按中文重新识别。
        chunk_size, chunk_overlap = chunk_settings()
        for document_id, document_metadata in rows:
            if doc_key is None or contextual is None:
                return document_id
            metadata = document_metadata or {}
            if (bool(metadata.get("contextual_retrieval")) == contextual
                    and metadata.get("chunk_size", 800) == chunk_size and metadata.get("overlap", 120) == chunk_overlap
                    and (metadata.get("parse_strategy") != "hi_res" or metadata.get("ocr_languages") == OCR_LANGUAGES)):
                return document_id
        return None

    # 把处理成功的版本设为当前版本并清理被取代的旧版本，返回 (是否成为当前版本, 被取代的版本 id)。
    # 只在新版本号更大时切换：连续上传 v2、v3 时若 v3 先完成，稍后完成的 v2 不会把指针切回旧内容。
    def activate_version(self, document_id, chunk_count):
        now = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as connection:
            row = connection.execute(select(documents).where(documents.c.id == document_id)).mappings().first()
            doc_key = row["doc_key"] or row["id"]
            version = row["version"] or 1
            head = connection.execute(select(document_heads).where(
                document_heads.c.doc_key == doc_key)).mappings().first()
            previous = None
            if head is not None and head["current_document_id"] == document_id:
                # 对账脚本发现当前版本数据不完整时，会把这个版本重新交给 worker 重建。
                # 它本来就是当前版本：按原来的"版本号更大才切换"判断会被当成过时版本，
                # 标记为 superseded 并删掉刚重建的数据；这里只更新状态，指针保持不变。
                connection.execute(documents.update().where(documents.c.id == document_id).values(
                    status=f"ready:{chunk_count}", error=None, updated=now))
                return True, None
            if head is None:
                connection.execute(document_heads.insert().values(doc_key=doc_key, owner=row["owner"],
                    title=row["title"], current_document_id=document_id, current_version=version, updated=now))
                activated = True
            else:
                # 条件更新由数据库原子判断版本先后，不需要额外加锁。
                result = connection.execute(document_heads.update().where(
                    document_heads.c.doc_key == doc_key, document_heads.c.current_version < version).values(
                        title=row["title"], current_document_id=document_id, current_version=version,
                        updated=now))
                activated = result.rowcount == 1
                if activated:
                    previous = head["current_document_id"]
                    connection.execute(documents.update().where(documents.c.id == previous).values(
                        status="superseded", updated=now))
            if activated:
                connection.execute(documents.update().where(documents.c.id == document_id).values(
                    status=f"ready:{chunk_count}", error=None, updated=now))
            else:
                connection.execute(documents.update().where(documents.c.id == document_id).values(
                    status="superseded", updated=now))
        # 指针已经提交，下面只是回收存储：检索只看当前版本，清理失败不影响正确性，
        # 因此只记录日志，不能让异常把已经切换成功的版本标记为失败。
        stale = document_id if not activated else previous
        if stale:
            try:
                self.remove_version_data(stale)
            except Exception:
                logger.exception("version_cleanup_failed document_id=%s", stale)
        return activated, previous

    # 删除一个版本在 Milvus 和 MySQL 中的分片，保留版本记录和原文件，便于查看历史。
    # Milvus 按 document_id 过滤删除，写了一半的失败版本也能清理干净。
    def remove_version_data(self, document_id):
        self.milvus.delete_document(document_id)
        with self.engine.begin() as connection:
            chunk_ids = connection.execute(select(document_chunks.c.chunk_id).where(
                document_chunks.c.document_id == document_id)).scalars().all()
            connection.execute(delete(document_chunks).where(document_chunks.c.document_id == document_id))
            if chunk_ids:
                connection.execute(delete(chunks).where(chunks.c.id.in_(chunk_ids)))
            # 以前只按 document_chunks 找要删的分片；document_chunks 的行丢了而 chunks 还在时，
            # 这些分片删不掉，重新处理这个版本写入同样的主键就会冲突。新分片主键都是"版本 id:序号"，按前缀再删一次。
            connection.execute(delete(chunks).where(chunks.c.id.like(f"{document_id}:%")))

    # 返回"这个用户能读哪些文档"的查询条件，doc_key 和 owner 是要过滤的表上的对应列。
    # 能读：自己上传的；公开的；共享给自己所在部门的。
    # 只有注册用户才能看到别人共享和公开的文档：评测用户 eval 不是注册用户，只能看到自己导入的语料，
    # 否则别人公开的文档会混进评测检索，评测分数就不可复现了。
    @staticmethod
    def readable_condition(connection, username, doc_key_column, owner_column):
        registered = connection.execute(select(users.c.username).where(users.c.username == username)).first()
        if registered is None:
            return owner_column == username
        public_keys = select(document_permissions.c.doc_key).where(document_permissions.c.visibility == "public")
        my_groups = select(user_group_members.c.group_id).where(user_group_members.c.username == username)
        shared_keys = select(document_shares.c.doc_key).join(document_permissions,
            document_permissions.c.doc_key == document_shares.c.doc_key).where(
                document_permissions.c.visibility == "shared", document_shares.c.group_id.in_(my_groups))
        return or_(owner_column == username, doc_key_column.in_(public_keys), doc_key_column.in_(shared_keys))

    # 返回这个用户可读的某个文档版本；没有权限或不存在都返回 None，接口统一回 404，不暴露别人文档是否存在。
    def readable_document(self, username, document_id):
        with self.engine.connect() as connection:
            condition = self.readable_condition(connection, username, documents.c.doc_key, documents.c.owner)
            return connection.execute(select(documents).where(
                documents.c.id == document_id, condition)).mappings().first()

    # 读取一份文档的可见范围和共享部门；没有记录的文档按 private 处理。
    def document_permission(self, doc_key):
        with self.engine.connect() as connection:
            visibility = connection.execute(select(document_permissions.c.visibility).where(
                document_permissions.c.doc_key == doc_key)).scalar_one_or_none()
            groups = connection.execute(select(document_shares.c.group_id).where(
                document_shares.c.doc_key == doc_key).order_by(document_shares.c.group_id)).scalars().all()
        return {"visibility": visibility or "private", "groups": list(groups)}

    # 覆盖写入文档的可见范围；只有 shared 才保存共享部门，其他范围清空部门列表。
    def set_document_permission(self, doc_key, visibility, groups):
        now = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as connection:
            connection.execute(delete(document_permissions).where(document_permissions.c.doc_key == doc_key))
            connection.execute(delete(document_shares).where(document_shares.c.doc_key == doc_key))
            connection.execute(document_permissions.insert().values(doc_key=doc_key, visibility=visibility, updated=now))
            if visibility != "shared":
                return
            for group_id in groups:
                connection.execute(document_shares.insert().values(doc_key=doc_key, group_id=group_id))

    # 返回当前用户可读文档的当前版本 {版本 id: 版本号}，检索据此过滤。
    # 以前只返回自己上传的文档；加了文档权限后，公开和共享给自己部门的文档也在其中。
    def current_versions(self, owner):
        with self.engine.connect() as connection:
            condition = self.readable_condition(connection, owner, document_heads.c.doc_key, document_heads.c.owner)
            rows = connection.execute(select(document_heads.c.current_document_id,
                document_heads.c.current_version).where(condition)).all()
        versions = {}
        for document_id, version in rows:
            versions[document_id] = version
        return versions

    # 这次提问可检索的范围：当前用户能读的每份文档的当前版本，并标明是自己上传、共享给我（经由哪些部门）还是公开。
    # 检索时用 versions 作为 Milvus 过滤条件；documents 写进检索诊断，页面据此显示"权限范围"。
    # 以前每个检索词、每种召回方式都各查一次 current_versions，一次提问重复查好几遍；现在每次提问只查一次。
    def readable_scope(self, owner):
        with self.engine.connect() as connection:
            condition = self.readable_condition(connection, owner, document_heads.c.doc_key, document_heads.c.owner)
            rows = connection.execute(select(document_heads.c.doc_key, document_heads.c.owner, document_heads.c.title,
                document_heads.c.current_document_id, document_heads.c.current_version).where(condition).order_by(
                    document_heads.c.title)).mappings().all()
            others = [row["doc_key"] for row in rows if row["owner"] != owner]
            public = set()
            shared_groups = {}
            if others:
                public = set(connection.execute(select(document_permissions.c.doc_key).where(
                    document_permissions.c.doc_key.in_(others),
                    document_permissions.c.visibility == "public")).scalars().all())
                my_groups = select(user_group_members.c.group_id).where(user_group_members.c.username == owner)
                for doc_key, name in connection.execute(select(document_shares.c.doc_key, user_groups.c.name).join(
                        user_groups, user_groups.c.id == document_shares.c.group_id).where(
                        document_shares.c.doc_key.in_(others), document_shares.c.group_id.in_(my_groups))).all():
                    shared_groups.setdefault(doc_key, []).append(name)
        versions = {}
        documents_in_scope = []
        for row in rows:
            versions[row["current_document_id"]] = row["current_version"]
            if row["owner"] == owner:
                source = "own"
            elif row["doc_key"] in public:
                source = "public"
            else:
                source = "shared"
            documents_in_scope.append({"document_id": row["current_document_id"], "title": row["title"],
                "version": row["current_version"], "source": source, "owner": row["owner"],
                "groups": shared_groups.get(row["doc_key"], [])})
        return {"versions": versions, "documents": documents_in_scope}

    # 返回当前用户某个文档的分块页面，解析标题路径和作者等可展示字段。
    # source 为 reused / computed 时只列出复用或新计算向量的分片；counts 返回两类各有多少，供筛选按钮显示。
    def list_document_chunks(self, owner, document_id, page, page_size, source=None):
        joined = document_chunks.join(chunks, document_chunks.c.chunk_id == chunks.c.id).join(
            documents, document_chunks.c.document_id == documents.c.id)
        base = and_(document_chunks.c.document_id == document_id, documents.c.owner == owner)
        vector_source = document_chunks.c.chunk_metadata["vector_source"].as_string()
        condition = and_(base, vector_source == source) if source in ("reused", "computed") else base
        with self.engine.connect() as connection:
            document = connection.execute(select(documents).where(
                documents.c.id == document_id, documents.c.owner == owner)).mappings().first()
            if not document:
                return None
            total = connection.execute(select(func.count()).select_from(joined).where(condition)).scalar_one()
            source_counts = {}
            for name in ("reused", "computed"):
                source_counts[name] = connection.execute(select(func.count()).select_from(joined).where(
                    and_(base, vector_source == name))).scalar_one()
            average_length = connection.execute(select(func.avg(func.length(
                func.coalesce(chunks.c.content, chunks.c.text)))).select_from(joined).where(condition)).scalar_one()
            rows = connection.execute(select(
                document_chunks.c.position, document_chunks.c.chunk_metadata,
                chunks.c.id, chunks.c.title, chunks.c.text, chunks.c.content
            ).select_from(joined).where(condition).order_by(
                document_chunks.c.position, chunks.c.id
            ).offset((page - 1) * page_size).limit(page_size)).mappings().all()
        result = []
        for offset, row in enumerate(rows):
            result.append(self.chunk_view(row, document, (page - 1) * page_size + offset + 1))
        total_pages = math.ceil(total / page_size) if total else 0
        return {"document_id": document_id,
            "document": {"document_id": document["id"], "title": document["title"],
                "filename": document["filename"], "uploaded_at": document["created"],
                "updated_at": document["updated"], "metadata": document["document_metadata"] or {}},
            "page": page, "page_size": page_size,
            "total": total, "total_pages": total_pages,
            "average_length": round(float(average_length)) if average_length is not None else 0,
            "source": source if source in ("reused", "computed") else None, "source_counts": source_counts,
            "chunks": result}

    # 组合实际保存的分块正文、来源范围和文档级解析 metadata。
    def chunk_view(self, row, document, position):
        raw_text = row["content"] or row["text"] or ""
        lines = raw_text.splitlines()
        content_lines = list(lines)
        metadata_value = row["chunk_metadata"] or {}
        heading_path = metadata_value.get("heading_path")
        if heading_path is None and content_lines and content_lines[0].startswith("标题路径："):
            heading_path = [item.strip() for item in content_lines.pop(0)[5:].split("/") if item.strip()]
        heading_path = heading_path or []
        content = row["content"] or "\n".join(content_lines).strip()
        document_metadata = document["document_metadata"] or {}
        section_title = metadata_value.get("section_title") or (heading_path[-1] if heading_path else None)
        return {"chunk_id": row["id"], "document_id": document["id"],
            "position": position, "document_title": document["title"],
            "title": section_title or document["title"], "section_title": section_title,
            "author": metadata_value.get("author"), "heading_path": heading_path,
            "content": content, "source": document["filename"],
            # Contextual Retrieval 为这个分片补写的上下文说明（拼在正文前面一起建索引），没有生成时为空。
            "context": metadata_value.get("context"),
            # 向量来源 reused / computed、复用自上一版本的哪个分片、上下文说明来源 reused / cached / generated / failed；
            # 早于这项记录的版本没有这些字段，为空。
            "vector_source": metadata_value.get("vector_source"),
            "reused_from": metadata_value.get("reused_from"),
            "context_source": metadata_value.get("context_source"),
            "char_count": metadata_value.get("char_count", len(content)),
            "token_count": metadata_value.get("token_count"),
            "truncated": metadata_value.get("truncated"),
            "page_start": metadata_value.get("page_start"),
            "page_end": metadata_value.get("page_end"),
            "element_types": metadata_value.get("element_types", []),
            "element_indexes": metadata_value.get("element_indexes", []),
            "author_source": metadata_value.get("author_source"),
            "chunking_strategy": metadata_value.get("chunking_strategy",
                document_metadata.get("chunking_strategy")),
            "chunk_size": metadata_value.get("chunk_size", document_metadata.get("chunk_size")),
            "overlap": metadata_value.get("overlap", document_metadata.get("overlap")),
            "effective_chunk_size": metadata_value.get("effective_chunk_size"),
            "effective_overlap": metadata_value.get("effective_overlap"),
            "parser": document_metadata.get("parser"),
            "parser_version": document_metadata.get("parser_version"),
            "parse_strategy": document_metadata.get("parse_strategy")}

    # 删除整份逻辑文档：所有版本的向量、分片、处理记录和 document_heads 指针，返回各版本的原文件路径。
    # 以前按单个上传删除并做跨文档引用检查；现在分片按版本独占，不再需要引用计数。
    def delete_document(self, owner, document_id):
        with self.engine.connect() as connection:
            row = connection.execute(select(documents.c.doc_key).where(
                documents.c.id == document_id, documents.c.owner == owner)).first()
            if row is None:
                return None
            doc_key = row[0] or document_id
            versions = connection.execute(select(documents.c.id, documents.c.path).where(
                documents.c.owner == owner,
                (documents.c.doc_key == doc_key) | (documents.c.id == doc_key))).all()
        paths = []
        for version_id, path in versions:
            self.remove_version_data(version_id)
            paths.append(path)
        with self.engine.begin() as connection:
            connection.execute(delete(document_heads).where(document_heads.c.doc_key == doc_key))
            connection.execute(delete(document_permissions).where(document_permissions.c.doc_key == doc_key))
            connection.execute(delete(document_shares).where(document_shares.c.doc_key == doc_key))
            for version_id, _ in versions:
                connection.execute(delete(document_steps).where(document_steps.c.document_id == version_id))
                connection.execute(delete(documents).where(documents.c.id == version_id))
        return paths

    # 在向量检索阶段过滤所属用户和当前版本，不能交给模型判断权限。
    # versions 由调用方传入时直接使用（一次提问只查一次权限范围），没传时自己查。
    def search(self, owner, question, models, limit=12, versions=None):
        versions = self.current_versions(owner) if versions is None else versions
        if not versions:
            return []
        return self.milvus.search(models.embed([question])[0], versions, limit=limit)

    # 权限和当前版本由业务层确定，BM25 的 SDK 参数由 MilvusStore 封装。
    def search_keyword(self, owner, query, limit=30, versions=None):
        versions = self.current_versions(owner) if versions is None else versions
        if not versions:
            return []
        return self.milvus.search_keyword(query, versions, limit=limit)

    # 父子分块用：取一个版本中序号在 [position - radius, position + radius] 内的分片正文和元数据，按序号排列。
    # 只按序号范围查询，不把整份文档读出来；是否属于同一小节由调用方按标题路径判断。
    def neighbor_chunks(self, document_id, position, radius):
        with self.engine.connect() as connection:
            rows = connection.execute(select(document_chunks.c.position, document_chunks.c.chunk_metadata,
                chunks.c.id, chunks.c.content, chunks.c.text).select_from(document_chunks.join(
                    chunks, chunks.c.id == document_chunks.c.chunk_id)).where(
                    document_chunks.c.document_id == document_id,
                    document_chunks.c.position >= position - radius,
                    document_chunks.c.position <= position + radius).order_by(
                    document_chunks.c.position)).mappings().all()
        result = []
        for row in rows:
            result.append(dict(row))
        return result

    # 检查真实依赖连接，不把配置存在当作服务可用。
    def ready(self):
        with self.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        self.cache.ping()
        self.milvus.ready()

    # 读取设置页保存的聊天模型配置；从未保存过时返回 None，继续使用 .env。
    def load_llm_settings(self):
        with self.engine.connect() as connection:
            row = connection.execute(select(settings.c.value, settings.c.updated).where(
                settings.c.key == "llm")).first()
        if row is None:
            return None
        value = dict(row[0])
        value["updated"] = row[1]
        return value

    # 保存聊天模型配置，已存在时覆盖。
    def save_llm_settings(self, value):
        now = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as connection:
            updated = connection.execute(settings.update().where(settings.c.key == "llm").values(
                value=value, updated=now)).rowcount
            if not updated:
                connection.execute(settings.insert().values(key="llm", value=value, updated=now))
        return now

    # 关闭所有持久化客户端。
    def close(self):
        self.mysql.close()
        self.redis.close()
        self.milvus.close()
