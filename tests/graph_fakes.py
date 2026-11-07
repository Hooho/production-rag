"""图检索测试共用的替身：内存里的 Milvus 客户端，只实现图向量集合用到的几个方法。"""

import json


class FakeGraphClient:
    def __init__(self):
        self.collections = {}
        self.searches = []

    def has_collection(self, name, timeout=None):
        return name in self.collections

    def prepare_index_params(self):
        class Params:
            def add_index(self, **kwargs):
                pass

        return Params()

    def create_collection(self, collection_name, schema, consistency_level, timeout):
        self.collections[collection_name] = {}
        self.indexed = getattr(self, "indexed", set())
        self.loaded = getattr(self, "loaded", set())

    def create_index(self, collection_name, index_params, timeout):
        self.indexed.add(collection_name)

    # 和真的 Milvus 一样：没建索引不能加载；没加载不能按条件删除、不能检索。
    def get_load_state(self, collection_name, timeout=None):
        return {"state": "Loaded" if collection_name in self.loaded else "NotLoad"}

    def load_collection(self, collection_name, timeout=None):
        assert collection_name in self.indexed, "没建索引不能加载"
        self.load_calls = getattr(self, "load_calls", []) + [(collection_name, timeout)]
        self.loaded.add(collection_name)

    def require_loaded(self, collection_name):
        assert collection_name in getattr(self, "loaded", set()), (
            f"集合没加载：{collection_name}"
        )

    def upsert(self, collection_name, data, timeout):
        for row in data:
            self.collections[collection_name][row["id"]] = row

    @classmethod
    def matches(cls, row, expression):
        if " and id in " in expression:
            head, ids = expression.split(" and id in ", 1)
            return cls.matches(row, head) and row["id"] in json.loads(ids)
        if expression.startswith("version_id in "):
            return row["version_id"] in json.loads(expression[len("version_id in ") :])
        if expression.startswith("document_id == "):
            return row["document_id"] == json.loads(
                expression[len("document_id == ") :]
            )
        raise AssertionError(expression)

    def delete(self, collection_name, filter, timeout):
        self.require_loaded(collection_name)
        rows = self.collections[collection_name]
        for key in [key for key, row in rows.items() if self.matches(row, filter)]:
            del rows[key]

    def search(
        self,
        collection_name,
        data,
        anns_field,
        filter,
        limit,
        output_fields,
        search_params,
        timeout,
    ):
        self.require_loaded(collection_name)
        self.searches.append(
            {"collection": collection_name, "filter": filter, "limit": limit}
        )
        hits = []
        for row in self.collections.get(collection_name, {}).values():
            if not self.matches(row, filter):
                continue
            norm_a = sum(a * a for a in data[0]) ** 0.5 or 1
            norm_b = sum(b * b for b in row["vector"]) ** 0.5 or 1
            score = sum(a * b for a, b in zip(data[0], row["vector"])) / norm_a / norm_b
            hits.append(
                {
                    "id": row["id"],
                    "distance": score,
                    "entity": {field: row.get(field) for field in output_fields},
                }
            )
        hits.sort(key=lambda hit: hit["distance"], reverse=True)
        return [hits[:limit]]

    def rows(self, collection_name):
        return list(self.collections.get(collection_name, {}).values())
