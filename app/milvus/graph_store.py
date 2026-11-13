"""图检索用的两个向量集合：名字向量、关系向量。

- 名字向量：每个版本里「同一实体的同一个名字」一行，文字是「名字（类型）+ 这份文档里的描述」。
  算在名字上而不是合并后的实体上：实体跨文档共用，把各文档的描述合在一起算向量，私有文档的描述就会影响匹配；
  按名字算，每行都属于一个版本，检索时按版本 id 过滤就等于按权限过滤。
- 关系向量：每条关系一行，文字是「起点 → 终点（分类）：描述」。
- 两个集合都只存 id、版本 id、文档版本 id 和向量（名字集合多存实体 id 和名字），其余信息检索后回 MySQL 查。
- 集合名跟着分片集合走（分片集合名里带 embedding 模型和维度），换了 embedding 模型就是新集合，旧向量不会被误用。
"""

from pymilvus import DataType, Function, FunctionType, MilvusClient

from .store import filter_literal

NAME_FIELDS = ["id", "version_id", "document_id", "entity_id", "name"]
# 加载集合（把向量和索引读进内存）可能很慢：刚建的集合、机器负载高时 10 秒常常不够。
# 建集合时分三步（建集合 → 建索引 → 加载），只有加载用这个长超时。
LOAD_TIMEOUT = 120
RELATION_FIELDS = ["id", "version_id", "document_id"]


class GraphVectorStore:
    def __init__(self, client, base_collection, dimension=None):
        self.client = client
        self.base = base_collection
        self.names = base_collection + "_gnames"
        self.relations = base_collection + "_grels"
        self.keyword_relations = base_collection + "_greltext"
        self.dimension = dimension
        self._ready = set()
        self._loaded = set()

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
            schema = MilvusClient.create_schema(
                auto_id=False, enable_dynamic_field=False
            )
            schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=64)
            schema.add_field("version_id", DataType.VARCHAR, max_length=64)
            schema.add_field("document_id", DataType.VARCHAR, max_length=64)
            if extra:
                schema.add_field("entity_id", DataType.VARCHAR, max_length=64)
                # VARCHAR 按字节算，中文每字 3 字节；名字表里最长 200 字。
                schema.add_field("name", DataType.VARCHAR, max_length=1024)
            schema.add_field("vector", DataType.FLOAT_VECTOR, dim=self.dimension)
            index_params = self.client.prepare_index_params()
            index_params.add_index(
                field_name="vector", index_type="AUTOINDEX", metric_type="COSINE"
            )
            # 不把 index_params 交给 create_collection：那样会在同一个 10 秒超时里建索引、加载并等加载完，
            # 加载慢一点就报 wait for loading collection timeout（集合其实已经建好了）。
            self.client.create_collection(
                collection_name=collection,
                schema=schema,
                consistency_level="Strong",
                timeout=10,
            )
            self.client.create_index(
                collection_name=collection, index_params=index_params, timeout=30
            )
            self._ready.add(collection)
        for collection in (self.names, self.relations):
            self.load(collection)

    def ensure_keywords(self):
        collection = self.keyword_relations
        if not self.exists(collection):
            schema = MilvusClient.create_schema(
                auto_id=False, enable_dynamic_field=False
            )
            for field in RELATION_FIELDS:
                schema.add_field(
                    field,
                    DataType.VARCHAR,
                    max_length=64,
                    **({"is_primary": True} if field == "id" else {}),
                )
            schema.add_field(
                "text",
                DataType.VARCHAR,
                max_length=65535,
                enable_analyzer=True,
                analyzer_params={"tokenizer": "jieba", "filter": ["cnalphanumonly"]},
            )
            schema.add_field("sparse", DataType.SPARSE_FLOAT_VECTOR)
            schema.add_function(
                Function(
                    name="relation_bm25",
                    function_type=FunctionType.BM25,
                    input_field_names=["text"],
                    output_field_names=["sparse"],
                )
            )
            self.client.create_collection(
                collection_name=collection,
                schema=schema,
                consistency_level="Strong",
                timeout=10,
            )
            params = self.client.prepare_index_params()
            params.add_index(
                field_name="sparse",
                index_type="SPARSE_INVERTED_INDEX",
                metric_type="BM25",
            )
            self.client.create_index(
                collection_name=collection, index_params=params, timeout=30
            )
            self._ready.add(collection)
        self.load(collection)

    def upsert_relation_keywords(self, rows):
        self.ensure_keywords()
        for start in range(0, len(rows), 200):
            self.client.upsert(
                collection_name=self.keyword_relations,
                data=rows[start : start + 200],
                timeout=30,
            )

    def search_relation_keywords(self, query, version_ids, limit, ids=None):
        return self._search(
            self.keyword_relations,
            RELATION_FIELDS,
            query,
            version_ids,
            limit,
            ids,
            keyword=True,
        )

    # 确保集合已加载：删除（按条件）和检索都要求集合在内存里。以前建集合时加载超时的集合也在这里补上。
    def load(self, collection):
        if collection in self._loaded:
            return
        state = self.client.get_load_state(collection_name=collection, timeout=10).get(
            "state"
        )
        if getattr(state, "name", str(state)) != "Loaded":
            self.client.load_collection(
                collection_name=collection, timeout=LOAD_TIMEOUT
            )
        self._loaded.add(collection)

    def upsert_names(self, rows):
        for start in range(0, len(rows), 200):
            self.client.upsert(
                collection_name=self.names, data=rows[start : start + 200], timeout=30
            )

    def upsert_relations(self, rows):
        for start in range(0, len(rows), 200):
            self.client.upsert(
                collection_name=self.relations,
                data=rows[start : start + 200],
                timeout=30,
            )

    @staticmethod
    def version_filter(version_ids):
        return (
            "version_id in ["
            + ", ".join(filter_literal(item) for item in version_ids)
            + "]"
        )

    # 删掉某些版本的向量（版本被清理、重新计算前）。
    def delete_versions(self, version_ids):
        if not version_ids:
            return
        for collection in (self.names, self.relations, self.keyword_relations):
            if self.exists(collection):
                self.load(collection)
                self.client.delete(
                    collection_name=collection,
                    filter=self.version_filter(version_ids),
                    timeout=10,
                )

    # 删掉一个文档版本的全部图向量（文档删除、被新版本取代时）。
    def delete_document(self, document_id):
        for collection in (self.names, self.relations, self.keyword_relations):
            if self.exists(collection):
                self.load(collection)
                self.client.delete(
                    collection_name=collection,
                    filter="document_id == " + filter_literal(document_id),
                    timeout=10,
                )

    # version_ids 由业务层按权限和生效版本算好；空范围绝不能退化成全库检索。
    # ids 不为空时只在这些名字里算相似度（给字面命中的名字取分数）。
    def search_names(self, vector, version_ids, limit, ids=None):
        return self._search(self.names, NAME_FIELDS, vector, version_ids, limit, ids)

    # ids 不为空时只在这些关系里算相似度（给找到的实体的关系按和问题的相似度排序）。
    def search_relations(self, vector, version_ids, limit, ids=None):
        return self._search(
            self.relations, RELATION_FIELDS, vector, version_ids, limit, ids
        )

    def _search(
        self, collection, fields, vector, version_ids, limit, ids=None, keyword=False
    ):
        if not version_ids or not self.exists(collection) or ids == []:
            return []
        self.load(collection)
        expression = self.version_filter(version_ids)
        if ids:
            expression += (
                " and id in [" + ", ".join(filter_literal(item) for item in ids) + "]"
            )
        result = self.client.search(
            collection_name=collection,
            data=[vector],
            anns_field="sparse" if keyword else "vector",
            filter=expression,
            limit=limit,
            output_fields=fields,
            search_params={"metric_type": "BM25" if keyword else "COSINE"},
            timeout=10,
        )
        hits = []
        for hit in result[0]:
            entity = hit["entity"]
            item = {field: entity.get(field) for field in fields}
            item["id"] = item.get("id") or hit.get("id")
            item["score"] = (
                abs(float(hit["distance"])) if keyword else float(hit["distance"])
            )
            hits.append(item)
        return hits
