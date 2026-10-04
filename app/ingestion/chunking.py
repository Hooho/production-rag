"""文档分块与分片元数据生成，供入库和评测使用。"""

import re


from .. import runtime_config

# 代码默认值；实际切分用设置页「RAG 配置 → 分片」里的值（没改过时跟随 .env 的 CHUNK_SIZE、CHUNK_OVERLAP）。
CHUNK_SIZE = 800
CHUNK_OVERLAP = 120


# 当前的分片大小和重叠：(大小, 重叠)，单位是字符。一份文档切分前取一次，整份文档用同一组值。
def chunk_settings():
    return runtime_config.value("chunk_size"), runtime_config.value("chunk_overlap")
HEADING_ENDINGS = "。！？；，、：.!?;,：,、)]}）》”’"


# 统一换行和空白，保留段落边界供后续切分。
def normalize_text(content):
    text = content.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n")
    lines = []
    for line in text.split("\n"):
        lines.append(re.sub(r"[ \t]+", " ", line).strip())
    return "\n".join(lines).strip()


# 识别 Markdown、编号章节和常见中文章节标题。
def detect_heading(lines, index, source_format=None):
    line = lines[index].strip()
    if not line:
        return None
    markdown = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
    if markdown:
        return len(markdown.group(1)), markdown.group(2).strip()
    if index + 1 < len(lines) and re.fullmatch(r"={3,}|-{3,}", lines[index + 1]):
        level = 1 if lines[index + 1].startswith("=") else 2
        return level, line
    numbered = re.match(r"^((?:\d+\.)+|\d+[、.)]|第[一二三四五六七八九十百千万\d]+[章节条]|[一二三四五六七八九十百千万]+、)\s*(.+)$", line)
    if numbered and len(line) <= 100 and not line.endswith(tuple(HEADING_ENDINGS)):
        marker = numbered.group(1)
        level = marker.count(".") or 1
        if marker.startswith("第"):
            level = 1
        return min(level, 6), numbered.group(2).strip()
    if source_format == ".pdf" and len(line) <= 60 and not line.endswith(tuple(HEADING_ENDINGS)):
        if index + 1 < len(lines) and len(lines[index + 1]) > len(line):
            return 1, line
    return None


# 按标题建立章节路径；没有标题的文本保留为一个根章节。
def split_sections(content, source_format=None):
    text = normalize_text(content)
    if not text:
        return []
    lines = text.split("\n")
    sections = []
    path = []
    body = []

    def flush():
        section_text = "\n".join(body).strip()
        if section_text:
            sections.append({"heading_path": list(path), "text": section_text})
        body.clear()

    index = 0
    while index < len(lines):
        heading = detect_heading(lines, index, source_format)
        if heading:
            flush()
            level, title = heading
            path[:] = path[:level - 1]
            path.append(title)
            if index + 1 < len(lines) and re.fullmatch(r"={3,}|-{3,}", lines[index + 1]):
                index += 1
        else:
            body.append(lines[index])
        index += 1
    flush()
    if not sections:
        return [{"heading_path": [], "text": text}]
    return sections


# 按段落和句子形成语义单元，尽量不从句子中间切断。
def split_units(text):
    paragraphs = re.split(r"\n\s*\n", text)
    units = []
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        sentences = re.split(r"(?<=[。！？；.!?;])\s+", paragraph)
        for sentence in sentences:
            sentence = sentence.strip()
            if sentence:
                units.append(sentence)
    return units


# 把一个章节切成有固定上限和重叠上下文的分片。
def split_section(text, chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP):
    units = split_units(text)
    chunks = []
    current = ""
    for unit in units:
        if len(unit) > chunk_size:
            if current:
                chunks.append(current.strip())
                current = ""
            for start in range(0, len(unit), chunk_size - chunk_overlap):
                chunks.append(unit[start:start + chunk_size].strip())
            continue
        candidate = unit if not current else current + "\n" + unit
        if current and len(candidate) > chunk_size:
            chunks.append(current.strip())
            overlap = current[-chunk_overlap:].strip()
            if overlap and len(overlap) + len(unit) + 1 <= chunk_size:
                current = overlap + "\n" + unit
            else:
                current = unit
        else:
            current = candidate
    if current.strip():
        chunks.append(current.strip())
    return chunks


# 把 chunk 当前内容关联回实际来源元素，保留重叠片段涉及的来源。
def chunk_sources(items, tail_length=None):
    text = "\n".join(item["text"] for item in items)
    start = max(0, len(text) - tail_length) if tail_length is not None else 0
    sources = []
    offset = 0
    for item in items:
        end = offset + len(item["text"])
        if end > start:
            for source in item["sources"]:
                if source not in sources:
                    sources.append(source)
        offset = end + 1
    return text[start:].strip(), sources


# 将每个章节切成带页码、元素类别和来源位置的结构化分块。
def chunk_document_records(content, sections=None, source_format=None, chunk_size=None, chunk_overlap=None):
    if chunk_size is None or chunk_overlap is None:
        chunk_size, chunk_overlap = chunk_settings()
    selected = sections or split_sections(content, source_format)
    chunks = []
    for section in selected:
        path = section.get("heading_path", [])
        prefix = " / ".join(path)
        body_limit = max(200, chunk_size - len(prefix) - 7) if prefix else chunk_size
        overlap_size = min(chunk_overlap, body_limit // 3)
        source_parts = section.get("parts") or [{"text": section["text"]}]
        units = []
        for part in source_parts:
            source = {"page_number": part.get("page_number"),
                "element_type": part.get("element_type"),
                "element_index": part.get("element_index"),
                "author": part.get("author")}
            for unit in split_units(part["text"]):
                units.append({"text": unit, "sources": [source]})

        # 生成单个 chunk 记录并汇总其来源范围。
        def append_chunk(items, overlap_count=0):
            body, sources = chunk_sources(items)
            if not body:
                return
            pages = []
            element_types = []
            element_indexes = []
            authors = []
            for source in sources:
                page_number = source.get("page_number")
                if isinstance(page_number, int) and page_number > 0 and page_number not in pages:
                    pages.append(page_number)
                element_type = source.get("element_type")
                if element_type and element_type not in element_types:
                    element_types.append(element_type)
                element_index = source.get("element_index")
                if isinstance(element_index, int) and element_index not in element_indexes:
                    element_indexes.append(element_index)
                author = source.get("author")
                if author and author not in authors:
                    authors.append(author)
            embedding_text = f"标题路径：{prefix}\n{body}" if prefix else body
            chunks.append({"content": body, "embedding_text": embedding_text,
                "heading_path": list(path), "section_title": path[-1] if path else None,
                "page_start": min(pages) if pages else None,
                "page_end": max(pages) if pages else None,
                "element_types": sorted(element_types), "element_indexes": sorted(element_indexes),
                "author": authors[0] if len(authors) == 1 else None,
                "author_source": "unstructured_metadata" if len(authors) == 1 else None,
                "char_count": len(body), "token_count": None,
                "effective_chunk_size": body_limit, "effective_overlap": overlap_count})

        current = []
        current_overlap = 0
        for unit in units:
            unit_text = unit["text"]
            if len(unit_text) > body_limit:
                if current:
                    append_chunk(current, current_overlap)
                    current = []
                    current_overlap = 0
                step = body_limit - overlap_size
                for start in range(0, len(unit_text), step):
                    current = [{"text": unit_text[start:start + body_limit], "sources": unit["sources"]}]
                    append_chunk(current, min(overlap_size, start))
                    current = []
                continue
            candidate = unit_text if not current else chunk_sources(current)[0] + "\n" + unit_text
            if current and len(candidate) > body_limit:
                append_chunk(current, current_overlap)
                overlap, overlap_sources = chunk_sources(current, overlap_size)
                overlap_item = {"text": overlap, "sources": overlap_sources}
                if overlap and len(overlap) + len(unit_text) + 1 <= body_limit:
                    current = [overlap_item, unit]
                    current_overlap = len(overlap)
                else:
                    current = [unit]
                    current_overlap = 0
            else:
                current.append(unit)
        if current:
            append_chunk(current, current_overlap)
    return chunks


# 生成带标题路径的检索文本；保留字符串接口供现有调用方使用。
def chunk_document(content, sections=None, source_format=None):
    records = chunk_document_records(content, sections=sections, source_format=source_format)
    return [record["embedding_text"] for record in records]
