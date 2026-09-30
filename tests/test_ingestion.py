import sys
import types

from app.tools.ingestion import (element_stats, extract_sections, extract_sections_cached, extract_text, parse_metadata, partition_elements,
    sections_from_elements)
from app.tools.chunking import chunk_document, chunk_document_records, split_sections


def test_extract_text_reads_utf8_text(tmp_path):
    path = tmp_path / "policy.txt"
    path.write_text("退货政策：签收后 7 天内可申请。", encoding="utf-8")
    assert "7 天" in extract_text(path)


def test_extract_text_rejects_unknown_extension(tmp_path):
    path = tmp_path / "script.exe"
    path.write_bytes(b"not a document")
    try:
        extract_text(path)
    except ValueError as error:
        assert "只支持" in str(error)
    else:
        raise AssertionError("未知扩展名必须被拒绝")


def test_chunk_document_preserves_heading_path():
    content = "# 售后政策\n\n## 退货\n签收后 7 天内可以申请退货。\n\n## 换货\n商品存在质量问题时可以申请换货。"
    sections = split_sections(content, ".md")
    chunks = chunk_document(content, sections=sections, source_format=".md")
    assert len(sections) == 2
    assert "标题路径：售后政策 / 退货" in chunks[0]
    assert "标题路径：售后政策 / 换货" in chunks[1]


def test_chunk_document_splits_long_sentences_with_overlap():
    content = "# 说明\n\n" + "甲" * 1000 + "。" + "乙" * 1000 + "。"
    chunks = chunk_document(content, source_format=".md")
    assert len(chunks) >= 3
    assert all(len(chunk) <= 800 for chunk in chunks)


def test_pdf_wrapped_body_line_is_not_detected_as_heading():
    content = "为什么随着股价下跌，投资者仍旧要继续购入和增持呢？首先，投资者意识到这是一只优质股，\n"
    content += "虽然暂时下跌了30%，但是会止涨，此时趁着股价下跌增持，可以降低投资成本。"
    sections = split_sections(content, ".pdf")
    assert sections == [{"heading_path": [], "text": content}]


def test_unstructured_elements_preserve_title_path_and_body():
    elements = [
        {"type": "Title", "text": "投资逻辑", "metadata": {"category_depth": 1}},
        {"type": "NarrativeText", "text": "第一段正文。"},
        {"type": "Title", "text": "风险", "metadata": {"category_depth": 1}},
        {"type": "NarrativeText", "text": "第二段正文。"},
    ]
    sections = sections_from_elements(elements)
    assert [(section["heading_path"], section["text"]) for section in sections] == [
        (["投资逻辑"], "第一段正文。"), (["风险"], "第二段正文。"),
    ]


def test_chunk_records_keep_source_pages_and_element_types():
    sections = sections_from_elements([
        {"type": "Title", "text": "投资逻辑", "metadata": {"category_depth": 1}},
        {"type": "NarrativeText", "text": "第一页内容。", "metadata": {"page_number": 1}},
        {"type": "ListItem", "text": "第二页内容。", "metadata": {"page_number": 2}},
    ])
    records = chunk_document_records("第一页内容。\n\n第二页内容。", sections=sections, source_format=".pdf")
    assert len(records) == 1
    assert records[0]["content"] == "第一页内容。\n第二页内容。"
    assert records[0]["heading_path"] == ["投资逻辑"]
    assert records[0]["page_start"] == 1
    assert records[0]["page_end"] == 2
    assert records[0]["element_types"] == ["ListItem", "NarrativeText"]
    assert records[0]["element_indexes"] == [1, 2]
    assert records[0]["token_count"] is None


def test_pdf_parser_retries_hi_res_without_table_model(monkeypatch, tmp_path):
    calls = []

    def fake_partition(**options):
        calls.append(options.copy())
        if len(calls) == 1:
            raise ImportError("Review the parameters to initialize a UnstructuredTableTransformerModel obj")
        return [{"type": "NarrativeText", "text": "正文"}]

    module = types.ModuleType("unstructured.partition.auto")
    module.partition = fake_partition
    monkeypatch.setitem(sys.modules, "unstructured.partition.auto", module)
    path = tmp_path / "fallback.pdf"
    path.write_bytes(b"pdf")

    assert partition_elements(path) == [{"type": "NarrativeText", "text": "正文"}]
    assert calls[0]["strategy"] == "hi_res"
    assert calls[0]["infer_table_structure"] is True
    assert calls[1]["strategy"] == "hi_res"
    assert calls[1]["infer_table_structure"] is False


def test_element_stats_counts_categories_dropped_and_languages():
    stats = element_stats([
        {"type": "Header", "text": "页眉"},
        {"type": "Title", "text": "投资逻辑", "metadata": {"languages": ["zho"]}},
        {"type": "Title", "text": "这其实是一句正文。"},
        {"type": "NarrativeText", "text": "正文。", "metadata": {"languages": ["zho", "eng"]}},
        {"type": "Image", "text": ""},
    ])
    assert stats["element_counts"] == {"Header": 1, "Title": 2, "NarrativeText": 1, "Image": 1}
    assert stats["dropped_counts"] == {"Header": 1, "title_as_body": 1, "empty": 1}
    assert stats["languages"] == ["zho", "eng"]


def test_parse_metadata_reports_quality_signals_for_markdown(tmp_path):
    path = tmp_path / "policy.md"
    path.write_text("没有任何标题的一段正文。", encoding="utf-8")
    sections, elements = extract_sections(path)
    result = parse_metadata(path, sections, elements)
    assert elements is None
    assert result["parser"] == "plain_text"
    assert result["char_count"] == len("没有任何标题的一段正文。")
    assert result["section_count"] == 1
    assert result["heading_detected"] is False
    assert result["page_count"] is None and result["empty_pages"] is None


def test_parse_metadata_finds_pages_without_text(monkeypatch, tmp_path):
    import app.tools.ingestion as ingestion

    monkeypatch.setattr(ingestion, "file_properties", lambda path: {"total_pages": 4, "doc_title": None,
        "doc_author": "作者乙", "doc_created": None, "doc_modified": None})
    sections = sections_from_elements([
        {"type": "Title", "text": "第一章", "metadata": {"category_depth": 1}},
        {"type": "NarrativeText", "text": "第一页。", "metadata": {"page_number": 1}},
        {"type": "NarrativeText", "text": "第三页。", "metadata": {"page_number": 3}},
    ])
    result = parse_metadata(tmp_path / "scan.pdf", sections, [])
    assert result["page_count"] == 4
    assert result["text_page_count"] == 2
    assert result["empty_pages"] == [2, 4]
    assert result["heading_detected"] is True
    assert result["author"] == "作者乙" and result["author_source"] == "file_properties"


# 同一 PDF 第二次处理直接读取解析缓存，不再调用 Unstructured；缓存里带着元素统计。
def test_parse_cache_skips_second_partition(monkeypatch, tmp_path):
    import app.tools.ingestion as ingestion

    calls = []

    def fake_partition(path):
        calls.append(path)
        return [{"type": "Title", "text": "第一章", "metadata": {"category_depth": 1}},
            {"type": "NarrativeText", "text": "正文。", "metadata": {"page_number": 1}}]

    monkeypatch.setattr(ingestion, "partition_elements", fake_partition)
    path = tmp_path / "book.pdf"
    path.write_bytes(b"pdf bytes")
    cache_dir = tmp_path / "cache"
    first = extract_sections_cached(path, cache_dir)
    second = extract_sections_cached(path, cache_dir)
    assert len(calls) == 1
    assert first[2] is False and second[2] is True
    assert second[0] == first[0]
    assert second[1]["element_counts"] == {"Title": 1, "NarrativeText": 1}
    # 文件内容变了就不能命中旧缓存。
    path.write_bytes(b"other pdf bytes")
    assert extract_sections_cached(path, cache_dir)[2] is False
    assert len(calls) == 2
