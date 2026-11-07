"""图检索用的两个向量集合：名字向量、关系向量。

- 名字向量：每个版本里「同一实体的同一个名字」一行，文字是「名字（类型）+ 这份文档里的描述」。
  算在名字上而不是合并后的实体上：实体跨文档共用，把各文档的描述合在一起算向量，私有文档的描述就会影响匹配；
  按名字算，每行都属于一个版本，检索时按版本 id 过滤就等于按权限过滤。
- 关系向量：每条关系一行，文字是「起点 → 终点（分类）：描述」。
- 两个集合都只存 id、版本 id、文档版本 id 和向量（名字集合多存实体 id 和名字），其余信息检索后回 MySQL 查。
- 集合名跟着分片集合走（分片集合名里带 embedding 模型和维度），换了 embedding 模型就是新集合，旧向量不会被误用。
"""

from pymilvus import DataType, MilvusClient

from .store import filter_literal

NAME_FIELDS = ["id", "version_id", "document_id", "entity_id", "name"]
RELATION_FIELDS = ["id", "version_id", "document_id"]


class GraphVectorStore:
    def __init__(self, client, base_collection, dimension=None):
        self.client = client
        self.base = base_collection
        self.names = base_collection + "_gnames"
        self.relations = base_collection + "_grels"
        self.dimension = dimension
        self._ready = set()

    # 集合是否已经建好；检索、删除时集合不存在就当作没有数据，不报错。
    def exists(self, collection):
        if collection in self._ready:
            return True
        if self.client.has_collection(collection, timeout=10):
            self._ready.add(collection)
            return True
        return False

    # 写入前确保两个集合都存在。
    def ensure(self):
        if self.dimension is None:
            raise ValueError("没有向量维度，不能创建图检索向量集合")
        for collection, extra in ((self.names, True), (self.relations, False)):
            if self.exists(collection):
                continue
            schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=False)
            schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=64)
            schema.add_field("version_id", DataType.VARCHAR, max_length=64)
            schema.add_field("document_id", DataType.VARCHAR, max_length=64)
            if extra:
                schema.add_field("entity_id", DataType.VARCHAR, max_length=64)
                # VARCHAR 按字节算，中文每字 3 字节；名字表里最长 200 字。
                schema.add_field("name", DataType.VARCHAR, max_length=1024)
            schema.add_field("vector", DataType.FLOAT_VECTOR, dim=self.dimension)
            index_params = self.client.prepare_index_params()
            index_params.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")
            self.client.create_collection(collection_name=collection, schema=schema,
                index_params=index_params, consistency_level="Strong", timeout=10)
            self._ready.add(collection)

    def upsert_names(self, rows):
        for start in range(0, len(rows), 200):
            self.client.upsert(collection_name=self.names, data=rows[start:start + 200], timeout=30)

    def upsert_relations(self, rows):
        for start in range(0, len(rows), 200):
            self.client.upsert(collection_name=self.relations, data=rows[start:start + 200], timeout=30)

    @staticmethod
    def version_filter(version_ids):
        return "version_id in [" + ", ".join(filter_literal(item) for item in version_ids) + "]"

    # 删掉某些版本的向量（版本被清理、重新计算前）。
    def delete_versions(self, version_ids):
        if not version_ids:
            return
        for collection in (self.names, self.relations):
            if self.exists(collection):
                self.client.delete(collection_name=collection,
                    filter=self.version_filter(version_ids), timeout=10)

    # 删掉一个文档版本的全部图向量（文档删除、被新版本取代时）。
    def delete_document(self, document_id):
        for collection in (self.names, self.relations):
            if self.exists(collection):
                self.client.delete(collection_name=collection,
                    filter="document_id == " + filter_literal(document_id), timeout=10)

    # version_ids 由业务层按权限和生效版本算好；空范围绝不能退化成全库检索。
    def search_names(self, vector, version_ids, limit):
        return self._search(self.names, NAME_FIELDS, vector, version_ids, limit)

    # ids 不为空时只在这些关系里算相似度（给找到的实体的关系按和问题的相似度排序）。
    def search_relations(self, vector, version_ids, limit, ids=None):
        return self._search(self.relations, RELATION_FIELDS, vector, version_ids, limit, ids)

    def _search(self, collection, fields, vector, version_ids, limit, ids=None):
        if not version_ids or not self.exists(collection) or ids == []:
            return []
        expression = self.version_filter(version_ids)
        if ids:
            expression += " and id in [" + ", ".join(filter_literal(item) for item in ids) + "]"
        result = self.client.search(collection_name=collection, data=[vector], anns_field="vector",
            filter=expression, limit=limit, output_fields=fields,
            search_params={"metric_type": "COSINE"}, timeout=10)
        hits = []
        for hit in result[0]:
            entity = hit["entity"]
            item = {field: entity.get(field) for field in fields}
            item["id"] = item.get("id") or hit.get("id")
            item["score"] = float(hit["distance"])
            hits.append(item)
        return hits
