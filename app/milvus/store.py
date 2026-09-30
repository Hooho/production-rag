import os

from pymilvus import DataType, Function, FunctionType, MilvusClient


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

    # 检查集合是否可用。
    def ready(self):
        self.client.get_collection_stats(self.collection, timeout=10)

    # 关闭 Milvus 客户端。
    def close(self):
        self.client.close()
