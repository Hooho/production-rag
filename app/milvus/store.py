import os
import json
import re

from pymilvus import DataType, Function, FunctionType, MilvusClient


SEARCH_FIELDS = ["title", "text", "document_id", "chunk_key", "page_start", "heading", "position"]

# Milvus 过滤条件里只允许出现字母、数字、汉字和 _ . : -。
# 过滤条件是拼出来的字符串表达式（owner == "alice" and document_id in [...]），和拼 SQL 一样：
# 值里如果带引号或括号，就能改写表达式本身，例如 owner 为 x" or owner != "x 时会读到所有人的文档。
# 这些值目前都来自服务端（配置的用户名、MySQL 里的版本 id 和 chunk_key），这里再校验一次，
# 以后值的来源变了（比如用户名改成注册时自己填）也不会变成注入口。
SAFE_FILTER_VALUE = re.compile(r"^[\w.:-]{1,128}$")


# 把一个值转成 Milvus 过滤表达式里的字符串字面量；含其他字符时直接拒绝，而不是尝试转义。
def filter_literal(value):
    if not isinstance(value, str) or not SAFE_FILTER_VALUE.match(value):
        raise ValueError(f"Milvus 过滤条件包含不允许的值：{value!r}")
    # 不转成 \u 转义：Milvus 表达式直接支持 UTF-8 字符串，校验后的值里也没有需要转义的引号和反斜杠。
    return json.dumps(value, ensure_ascii=False)


class MilvusStore:
    """负责向量集合的创建、写入和检索。"""

    def __init__(self, models):
        self.client = MilvusClient(uri=os.getenv("MILVUS_URI", "http://localhost:19530"), timeout=10)
        self.collection = models.collection
        if not self.client.has_collection(self.collection, timeout=10):
            self.create_collection(models.dimension)

    # 同一集合同时保存稠密向量和 BM25 稀疏向量；稀疏向量由 Milvus 在写入时根据 text 自动生成。
    def create_collection(self, dimension):
        schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=False)
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=64)
        schema.add_field("owner", DataType.VARCHAR, max_length=64)
        schema.add_field("title", DataType.VARCHAR, max_length=1024)
        # VARCHAR 长度按字节计算，中文每字 3 字节，因此正文直接使用上限。
        # jieba 负责中文分词，cnalphanumonly 去掉标点等非中文、字母、数字的词元。
        schema.add_field("text", DataType.VARCHAR, max_length=65535, enable_analyzer=True,
            analyzer_params={"tokenizer": "jieba", "filter": ["cnalphanumonly"]})
        schema.add_field("position", DataType.INT64)
        # 分片所属的文档版本。检索时只放行各文档当前版本的 document_id，
        # 新版本处理中或旧版本尚未清理时都不会被检索到，正确性不依赖旧向量是否删除成功。
        schema.add_field("document_id", DataType.VARCHAR, max_length=64)
        # 跨版本稳定的内容标识，与 MySQL chunks.chunk_key 一致。
        schema.add_field("chunk_key", DataType.VARCHAR, max_length=64)
        # 页码和标题路径随来源一起返回，引用可以定位到原文位置；没有页码的格式记为 -1。
        schema.add_field("page_start", DataType.INT64)
        schema.add_field("heading", DataType.VARCHAR, max_length=2048)
        schema.add_field("vector", DataType.FLOAT_VECTOR, dim=dimension)
        schema.add_field("sparse", DataType.SPARSE_FLOAT_VECTOR)
        schema.add_function(Function(name="text_bm25", function_type=FunctionType.BM25,
            input_field_names=["text"], output_field_names=["sparse"]))
        index_params = self.client.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")
        index_params.add_index(field_name="sparse", index_type="SPARSE_INVERTED_INDEX",
            metric_type="BM25")
        self.client.create_collection(collection_name=self.collection, schema=schema,
            index_params=index_params, consistency_level="Strong", timeout=10)

    def upsert(self, rows, timeout=10):
        return self.client.upsert(collection_name=self.collection, data=rows, timeout=timeout)

    def delete_document(self, document_id):
        return self.client.delete(collection_name=self.collection,
            filter="document_id == " + filter_literal(document_id), timeout=10)

    def query_chunks(self, document_id, chunk_keys):
        rows = []
        # 控制过滤表达式和单次查询的大小。
        for start in range(0, len(chunk_keys), 500):
            keys = [filter_literal(key) for key in chunk_keys[start:start + 500]]
            rows.extend(self.client.query(collection_name=self.collection,
                filter="document_id == " + filter_literal(document_id) + " and chunk_key in [" + ", ".join(keys) + "]",
                output_fields=["id", "chunk_key", "vector", "text"], timeout=10))
        return rows

    # 一个版本在 Milvus 里实际有多少行，导入时「写入校验」用它确认分片都写进去了。集合是 Strong 一致性，写完马上能查到。
    def count_document(self, document_id):
        result = self.client.query(collection_name=self.collection,
            filter="document_id == " + filter_literal(document_id), output_fields=["count(*)"], timeout=10)
        return int(result[0]["count(*)"]) if result else 0

    def document_counts(self):
        counts = {}
        iterator = self.client.query_iterator(collection_name=self.collection, batch_size=1000,
            filter='id != ""', output_fields=["document_id"])
        try:
            while True:
                batch = iterator.next()
                if not batch:
                    break
                for row in batch:
                    document_id = row["document_id"]
                    counts[document_id] = counts.get(document_id, 0) + 1
        finally:
            iterator.close()
        return counts

    # versions 由业务层完成权限校验；空范围绝不能退化成全库检索。
    def search(self, vector, versions, limit=12):
        if not versions:
            return []
        result = self.client.search(collection_name=self.collection, data=[vector],
            anns_field="vector", filter=self.search_filter(versions), limit=limit,
            output_fields=SEARCH_FIELDS, timeout=10)
        return self.hits_to_sources(result[0], "dense", versions)

    def search_keyword(self, query, versions, limit=30):
        if not versions:
            return []
        result = self.client.search(collection_name=self.collection, data=[query],
            anns_field="sparse", filter=self.search_filter(versions), limit=limit,
            output_fields=SEARCH_FIELDS, search_params={"metric_type": "BM25"}, timeout=10)
        sources = self.hits_to_sources(result[0], "keyword", versions)
        # 兼容 Milvus Lite 返回的负数距离。
        for item in sources:
            item["score"] = abs(item["score"])
        return sources

    # 以前只按 owner 过滤，同一文档的新旧版本会同时被检索；后来只放行 document_heads 指向的当前版本。
    # 加了文档权限后不再按 owner 过滤：别人共享和公开的文档 owner 不是当前用户。
    # 权限完全由版本 id 列表决定，列表来自 MySQL 的权限查询（current_versions），模型和客户端都改不了它。
    # 文档数量很大时可改用 Milvus 分区键或定期同步的"可见范围"字段。
    @staticmethod
    def search_filter(versions):
        values = []
        for version in versions:
            values.append(filter_literal(version))
        return "document_id in [" + ", ".join(values) + "]"

    # 把 Milvus 命中结果转换为统一的来源结构。
    # 同时带出版本号、页码和标题路径，供引用定位和检索诊断展示。
    @staticmethod
    def hits_to_sources(hits, method, versions):
        sources = []
        for hit in hits:
            entity = hit["entity"]
            page_start = entity.get("page_start")
            sources.append({"id": entity.get("id", hit.get("id")), "title": entity["title"],
                "text": entity["text"], "score": float(hit["distance"]), "method": method,
                "document_id": entity.get("document_id"), "chunk_key": entity.get("chunk_key"),
                "position": entity.get("position"),
                "version": versions.get(entity.get("document_id")),
                "page_start": page_start if page_start is not None and page_start >= 0 else None,
                "heading": entity.get("heading") or None})
        return sources

    # 检查集合是否可用。
    def ready(self):
        self.client.get_collection_stats(self.collection, timeout=10)

    # 关闭 Milvus 客户端。
    def close(self):
        self.client.close()
