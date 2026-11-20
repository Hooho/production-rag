import unittest
from types import MethodType, SimpleNamespace
from unittest.mock import patch

from sqlalchemy import Column, Integer, JSON, MetaData, String, Table, create_engine

from app import storage


class ReadableChunkTest(unittest.TestCase):
    # 分片原文按文档的可见范围给：读得到文档才给正文，读不到或者分片不存在都不给。
    def setUp(self):
        metadata = MetaData()
        self.chunks = Table(
            "chunks",
            metadata,
            Column("id", String, primary_key=True),
            Column("title", String),
            Column("content", String),
            Column("text", String),
        )
        self.links = Table(
            "document_chunks",
            metadata,
            Column("document_id", String),
            Column("chunk_id", String),
            Column("position", Integer),
            Column("chunk_metadata", JSON),
        )
        self.engine = create_engine("sqlite://")
        metadata.create_all(self.engine)
        with self.engine.begin() as connection:
            connection.execute(
                self.chunks.insert(),
                [
                    {
                        "id": "doc:0",
                        "title": "书",
                        "content": "第一片正文",
                        "text": "说明\n第一片正文",
                    },
                    {
                        "id": "doc:1",
                        "title": "书",
                        "content": None,
                        "text": "标题路径：第一章\n第二片正文",
                    },
                    {
                        "id": "other:0",
                        "title": "别人的书",
                        "content": "不能看",
                        "text": "不能看",
                    },
                ],
            )
            connection.execute(
                self.links.insert(),
                [
                    {
                        "document_id": "doc",
                        "chunk_id": "doc:0",
                        "position": 0,
                        "chunk_metadata": {"heading_path": ["章节"]},
                    },
                    {
                        "document_id": "doc",
                        "chunk_id": "doc:1",
                        "position": 1,
                        "chunk_metadata": {},
                    },
                    {
                        "document_id": "other",
                        "chunk_id": "other:0",
                        "position": 0,
                        "chunk_metadata": {},
                    },
                ],
            )
        self.store = SimpleNamespace(
            engine=self.engine,
            readable_document=lambda username, document_id: (
                {"owner": username}
                if username == "alice" and document_id == "doc"
                else None
            ),
        )
        # 批量读取要调同一个方法，替身存储上把它接回去。
        self.store.readable_chunks = MethodType(
            storage.Storage.readable_chunks, self.store
        )

    def tearDown(self):
        self.engine.dispose()

    def test_readable_chunk_follows_document_permission(self):
        with patch.multiple(storage, chunks=self.chunks, document_chunks=self.links):
            result = storage.Storage.readable_chunk(self.store, "alice", "doc:0")
            self.assertEqual(result["content"], "第一片正文")
            self.assertEqual(result["heading"], "章节")
            # 读不到文档权限、分片不存在都不给原文。
            self.assertIsNone(
                storage.Storage.readable_chunk(self.store, "bob", "doc:0")
            )
            self.assertIsNone(
                storage.Storage.readable_chunk(self.store, "alice", "missing")
            )

    def test_readable_chunks_skips_unreadable(self):
        with patch.multiple(storage, chunks=self.chunks, document_chunks=self.links):
            items = storage.Storage.readable_chunks(
                self.store, "alice", ["doc:0", "doc:1", "other:0", "missing"]
            )
            self.assertEqual([item["chunk_id"] for item in items], ["doc:0", "doc:1"])

    def test_chunk_body_falls_back_to_text(self):
        # 有 content 就是这一片自己的原文。
        self.assertEqual(storage.chunk_body("正文", "说明\n正文", {}), "正文")
        # 没有 content 时从送去检索的文字里去掉上下文说明和标题路径。
        self.assertEqual(
            storage.chunk_body(
                None, "说明\n标题路径：第一章\n正文", {"context": "说明"}
            ),
            "正文",
        )
        self.assertEqual(storage.chunk_body(None, "标题路径：第一章\n正文", {}), "正文")


if __name__ == "__main__":
    unittest.main()
