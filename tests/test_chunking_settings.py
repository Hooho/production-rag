import pytest

from app import runtime_config
from app.ingestion.chunking import chunk_document_records


def test_chunk_size_and_overlap_follow_arguments():
    text = "\n".join(f"第{index}句话写一些内容，让段落足够长。" for index in range(200))
    small = chunk_document_records(text, chunk_size=300, chunk_overlap=0)
    large = chunk_document_records(text, chunk_size=1200, chunk_overlap=0)
    assert len(small) > len(large)
    assert max(len(record["content"]) for record in small) <= 300
    assert all(record["effective_overlap"] == 0 for record in small)


def test_chunk_settings_come_from_runtime(runtime):
    runtime(chunk_size=400)
    runtime(chunk_overlap=40)
    runtime_config.clear_cache()
    text = "\n".join(f"第{index}句话写一些内容，让段落足够长。" for index in range(200))
    records = chunk_document_records(text)
    assert max(len(record["content"]) for record in records) <= 400
    assert any(record["effective_overlap"] > 0 for record in records)


def test_overlap_limited_to_third_of_size():
    values = runtime_config.snapshot()
    values.update(chunk_size=300, chunk_overlap=101)
    with pytest.raises(ValueError):
        runtime_config.check_relations(values)
    values["chunk_overlap"] = 100
    runtime_config.check_relations(values)
