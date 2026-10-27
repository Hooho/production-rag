import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import Column, Integer, JSON, MetaData, String, Table, create_engine

from app.evaluation import evidence


class ChunkOriginalTest(unittest.TestCase):
    def test_exact_chunk_and_eval_scope(self):
        metadata = MetaData()
        chunks = Table("chunks", metadata, Column("id", String, primary_key=True),
            Column("title", String), Column("content", String), Column("text", String))
        documents = Table("documents", metadata, Column("id", String, primary_key=True), Column("owner", String))
        links = Table("document_chunks", metadata, Column("document_id", String),
            Column("chunk_id", String), Column("position", Integer), Column("chunk_metadata", JSON))
        engine = create_engine("sqlite://")
        metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(documents.insert(), [{"id": "eval", "owner": evidence.EVAL_OWNER}, {"id": "private", "owner": "someone"}])
            connection.execute(chunks.insert(), [
                {"id": "eval:68", "title": "书", "content": "第69片正文", "text": "标题路径：书\n第69片正文"},
                {"id": "eval:69", "title": "书", "content": "相邻第70片正文", "text": "相邻第70片正文"},
                {"id": "private:0", "title": "私有", "content": "不能展示", "text": "不能展示"},
            ])
            connection.execute(links.insert(), [
                {"document_id": "eval", "chunk_id": "eval:68", "position": 68, "chunk_metadata": {"heading_path": ["章节"]}},
                {"document_id": "eval", "chunk_id": "eval:69", "position": 69, "chunk_metadata": {}},
                {"document_id": "private", "chunk_id": "private:0", "position": 0, "chunk_metadata": {}},
            ])
        with patch.multiple(evidence, chunks=chunks, document_chunks=links, documents=documents):
            store = SimpleNamespace(engine=engine)
            result = evidence.load_chunk(store, "eval:68")
            self.assertEqual(result["content"], "第69片正文")
            self.assertEqual(result["heading"], "章节")
            self.assertEqual(result["position"], 68)
            self.assertIsNone(evidence.load_chunk(store, "missing"))
            self.assertIsNone(evidence.load_chunk(store, "private:0"))
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
