"""Milvus 适配层契约测试，不连接真实数据库。"""

import unittest
from unittest.mock import Mock

from app.milvus.store import MilvusStore


class MilvusStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = MilvusStore.__new__(MilvusStore)
        self.store.collection = "test_chunks"
        self.store.client = Mock()

    def test_empty_scope_does_not_search(self):
        self.assertEqual(self.store.search([0.1], {}), [])
        self.assertEqual(self.store.search_keyword("退货", {}), [])
        self.store.client.search.assert_not_called()

    def test_search_preserves_scope_and_source_metadata(self):
        self.store.client.search.return_value = [[{"id": "v1:0", "distance": 0.8,
            "entity": {"title": "售后", "text": "七天退货", "document_id": "v1",
                "position": 0, "page_start": -1, "heading": ""}}]]
        sources = self.store.search([0.1, 0.2], {"v1": 2}, limit=5)
        params = self.store.client.search.call_args.kwargs
        self.assertEqual(params["filter"], 'document_id in ["v1"]')
        self.assertEqual(params["data"], [[0.1, 0.2]])
        self.assertEqual(params["anns_field"], "vector")
        self.assertEqual(params["limit"], 5)
        self.assertEqual(sources[0]["version"], 2)
        self.assertEqual(sources[0]["id"], "v1:0")
        self.assertIsNone(sources[0]["page_start"])
        self.assertIsNone(sources[0]["heading"])

    def test_bm25_uses_text_and_normalizes_lite_distance(self):
        self.store.client.search.return_value = [[{"id": "v1:0", "distance": -2.5,
            "entity": {"title": "售后", "text": "七天退货", "document_id": "v1"}}]]
        sources = self.store.search_keyword("退货", {"v1": 1})
        params = self.store.client.search.call_args.kwargs
        self.assertEqual(params["data"], ["退货"])
        self.assertEqual(params["anns_field"], "sparse")
        self.assertEqual(params["search_params"], {"metric_type": "BM25"})
        self.assertEqual(sources[0]["score"], 2.5)

    def test_chunk_queries_are_batched_and_validate_ids(self):
        self.store.client.query.return_value = []
        self.store.query_chunks("v1", [f"key-{i}" for i in range(501)])
        self.assertEqual(self.store.client.query.call_count, 2)
        self.assertIn('"key-500"', self.store.client.query.call_args.kwargs["filter"])
        with self.assertRaises(ValueError):
            self.store.delete_document('v1" or id != "')
        self.store.client.delete.assert_not_called()

    def test_iterator_is_closed_on_success_and_failure(self):
        iterator = self.store.client.query_iterator.return_value
        iterator.next.side_effect = [[{"document_id": "v1"}, {"document_id": "v1"}], []]
        self.assertEqual(self.store.document_counts(), {"v1": 2})
        iterator.close.assert_called_once()
        iterator.reset_mock()
        iterator.next.side_effect = RuntimeError("查询失败")
        with self.assertRaises(RuntimeError):
            self.store.document_counts()
        iterator.close.assert_called_once()

    def test_write_and_delete_target_the_configured_collection(self):
        rows = [{"id": "v1:0"}]
        self.store.upsert(rows, timeout=30)
        self.store.client.upsert.assert_called_once_with(
            collection_name="test_chunks", data=rows, timeout=30)
        self.store.delete_document("v1")
        self.store.client.delete.assert_called_once_with(
            collection_name="test_chunks", filter='document_id == "v1"', timeout=10)
