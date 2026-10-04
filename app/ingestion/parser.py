"""文档解析、章节提取和解析缓存，供后台入库流程使用。"""

import hashlib
import json
import logging
from pathlib import Path


ALLOWED_EXTENSIONS = {".txt", ".md", ".pdf", ".docx"}
TABLE_STRUCTURE_ENABLED = True
# 表格模型失败后整个进程都会关闭表格结构识别；以前只记录了开关结果，看不出是什么时候、因为什么关掉的。
TABLE_FALLBACK_REASON = None
SKIPPED_CATEGORIES = {"PageBreak", "Header", "Footer"}
# 解析缓存格式的版本号；改了章节结构、元素统计的字段或解析参数时加一，旧缓存就不会再被读到。
# 2：PDF 的 OCR 语言从默认的英文改成简体中文 + 英文。
PARSE_CACHE_VERSION = 2
# PDF 里没有文字层的部分（扫描件、嵌在页面里的图片）用 Tesseract 做 OCR，要告诉它认哪几种语言。
# 以前没传，Unstructured 默认按英文（eng）认，中文会被认成乱码或漏掉；镜像里装了中文字库 tesseract-ocr-chi-sim。
# 有文字层的 PDF 直接取文字，不受这个设置影响。
OCR_LANGUAGES = ["chi_sim", "eng"]
logger = logging.getLogger("production-rag-ingestion")


# 读取元素属性，同时兼容 Unstructured 元素对象和测试中的字典元素。
def element_value(element, name, default=None):
    if isinstance(element, dict):
        return element.get(name, default)
    return getattr(element, name, default)


# 读取 Unstructured 元素的元数据属性。
def metadata_value(metadata, name, default=None):
    if isinstance(metadata, dict):
        return metadata.get(name, default)
    return getattr(metadata, name, default)


# 取得元素类别，供标题、页眉页脚和正文分流。
def element_category(element):
    category = element_value(element, "category")
    if category:
        return str(category)
    element_type = element_value(element, "type")
    if element_type:
        return str(element_type)
    return element.__class__.__name__


# 取得元素正文；表格没有纯文本时保留 Unstructured 生成的 HTML 表格。
def element_text(element):
    value = element_value(element, "text", "")
    if value and str(value).strip():
        return str(value).strip()
    metadata = element_value(element, "metadata")
    html = metadata_value(metadata, "text_as_html", "")
    return str(html).strip() if html else ""


# 判断失败是否来自 Unstructured 的表格结构模型，而不是 PDF 本身损坏。
def is_table_model_error(error):
    current = error
    while current is not None:
        message = str(current)
        if "UnstructuredTableTransformerModel" in message or "table-transformer" in message:
            return True
        current = current.__cause__ or current.__context__
    return False


# 使用 Unstructured 本地解析 PDF 和 DOCX，PDF 固定使用 hi_res 版面策略。
def partition_elements(path):
    global TABLE_STRUCTURE_ENABLED, TABLE_FALLBACK_REASON

    suffix = Path(path).suffix.lower()
    try:
        from unstructured.partition.auto import partition
    except ImportError as error:
        raise RuntimeError("文档解析依赖未安装，请安装 unstructured[pdf,docx]") from error

    options = {"filename": str(path)}
    if suffix == ".pdf":
        options["strategy"] = "hi_res"
        options["include_page_breaks"] = True
        options["infer_table_structure"] = TABLE_STRUCTURE_ENABLED
        options["languages"] = list(OCR_LANGUAGES)
    try:
        return list(partition(**options))
    except Exception as error:
        if suffix != ".pdf" or not options.get("infer_table_structure") or not is_table_model_error(error):
            raise
        TABLE_STRUCTURE_ENABLED = False
        TABLE_FALLBACK_REASON = str(error)[:300]
        logger.warning("表格结构模型不可用，继续使用 hi_res 版面解析：%s", str(error)[:300])
        options["infer_table_structure"] = False
        return list(partition(**options))


# 把 Unstructured 元素转换为带标题路径的章节，保留标题和正文边界。
def sections_from_elements(elements):
    from .chunking import HEADING_ENDINGS

    sections = []
    path = []
    body = []

    def flush():
        section_text = "\n\n".join(part["text"] for part in body).strip()
        if section_text:
            sections.append({"heading_path": list(path), "text": section_text, "parts": list(body)})
        body.clear()

    for element_index, element in enumerate(elements):
        category = element_category(element)
        text = element_text(element)
        if not text or category in SKIPPED_CATEGORIES:
            continue
        if category in {"Title", "SectionHeader"} and not text.endswith(tuple(HEADING_ENDINGS)):
            flush()
            metadata = element_value(element, "metadata")
            depth = metadata_value(metadata, "category_depth", 1)
            try:
                depth = max(1, int(depth or 1))
            except (TypeError, ValueError):
                depth = 1
            path[:] = path[:depth - 1]
            path.append(text)
            continue
        metadata = element_value(element, "metadata")
        page_number = metadata_value(metadata, "page_number")
        try:
            page_number = int(page_number) if page_number is not None else None
        except (TypeError, ValueError):
            page_number = None
        author = metadata_value(metadata, "author") or metadata_value(metadata, "authors")
        if isinstance(author, (list, tuple)):
            author = ", ".join(str(item).strip() for item in author if str(item).strip())
        body.append({"text": text, "page_number": page_number,
            "element_type": category, "element_index": element_index,
            "author": str(author).strip() if author else None})
    flush()
    if not sections:
        text = "\n\n".join(element_text(element) for element in elements if element_text(element)).strip()
        if text:
            return [{"heading_path": [], "text": text}]
    return sections


# 统计解析出的元素：各类别数量、被丢弃的元素和语言。
# 以前这些信息在分章节时就丢了，扫描件、标题识别失败这类"解析坏了但导入成功"的文档无从发现。
def element_stats(elements):
    from .chunking import HEADING_ENDINGS

    counts = {}
    dropped = {}
    languages = []
    for element in elements:
        category = element_category(element)
        counts[category] = counts.get(category, 0) + 1
        text = element_text(element)
        if not text:
            dropped["empty"] = dropped.get("empty", 0) + 1
        elif category in SKIPPED_CATEGORIES:
            dropped[category] = dropped.get(category, 0) + 1
        elif category in {"Title", "SectionHeader"} and text.endswith(tuple(HEADING_ENDINGS)):
            # 以标点结尾的标题会被当成正文，单独计数，方便判断标题识别是否偏差。
            dropped["title_as_body"] = dropped.get("title_as_body", 0) + 1
        metadata = element_value(element, "metadata")
        for language in metadata_value(metadata, "languages") or []:
            if language not in languages:
                languages.append(language)
    return {"element_counts": counts, "dropped_counts": dropped, "languages": languages or None}


# 读取文件自带的属性：PDF 的真实页数和文档信息，DOCX 的核心属性。
# 以前 page_count 取正文元素的最大页码，末尾空白页、纯图片页和只有标题的页都算不进去；
# Unstructured 的 last_modified 取的是上传后落盘的时间，不是文档本身的修改时间，所以直接读文件属性。
def file_properties(path):
    suffix = Path(path).suffix.lower()
    result = {"total_pages": None, "doc_title": None, "doc_author": None,
        "doc_created": None, "doc_modified": None}
    try:
        if suffix == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            result["total_pages"] = len(reader.pages)
            info = reader.metadata
            if info:
                result["doc_title"] = info.title
                result["doc_author"] = info.author
                result["doc_created"] = info.creation_date.isoformat() if info.creation_date else None
                result["doc_modified"] = info.modification_date.isoformat() if info.modification_date else None
        elif suffix == ".docx":
            from docx import Document
            properties = Document(str(path)).core_properties
            result["doc_title"] = properties.title
            result["doc_author"] = properties.author
            result["doc_created"] = properties.created.isoformat() if properties.created else None
            result["doc_modified"] = properties.modified.isoformat() if properties.modified else None
    except Exception as error:
        # 文件属性只用于展示和排查，读取失败不能让导入失败。
        logger.warning("读取文件属性失败：%s", str(error)[:300])
    for key in ("doc_title", "doc_author"):
        value = result[key]
        result[key] = str(value).strip() if value and str(value).strip() else None
    return result


# 返回已安装的 Unstructured 版本；没有安装时为 None。
def unstructured_version():
    from importlib.metadata import PackageNotFoundError, version
    try:
        return version("unstructured")
    except PackageNotFoundError:
        return None


# 解析 PDF/DOCX 并缓存结果，返回 (章节, 元素统计, 是否命中缓存)。
# hi_res 解析一本书要好几分钟，以前任何一步失败重试、worker 重启都要从头再解析一遍；
# 现在按"文件内容 + 解析器版本 + 表格识别开关"缓存成 JSON，同一文件再次处理时直接读取。
# TXT/Markdown 解析只需几毫秒，不做缓存。缓存读写失败只当作未命中，不影响导入。
def extract_sections_cached(path, cache_dir):
    suffix = Path(path).suffix.lower()
    if suffix not in {".pdf", ".docx"}:
        sections, elements = extract_sections(path)
        return sections, (element_stats(elements) if elements is not None else None), False
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()

    # 表格识别开关可能在解析过程中因为模型失败被关掉，所以写缓存时要按解析后的开关重新计算键。
    def cache_file():
        identity = json.dumps([PARSE_CACHE_VERSION, digest, suffix, unstructured_version(), TABLE_STRUCTURE_ENABLED])
        return Path(cache_dir) / f"{hashlib.sha256(identity.encode()).hexdigest()}.json"

    target = cache_file()
    if target.exists():
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
            return data["sections"], data["stats"], True
        except (OSError, ValueError, KeyError) as error:
            logger.warning("解析缓存读取失败，重新解析：%s", str(error)[:300])
    sections, elements = extract_sections(path)
    stats = element_stats(elements)
    target = cache_file()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps({"sections": sections, "stats": stats}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
    except (OSError, TypeError, ValueError) as error:
        logger.warning("解析缓存写入失败：%s", str(error)[:300])
    return sections, stats, False


# 返回文档解析器、实际使用的版面解析配置和解析质量信号。
# stats 是已经算好的元素统计（来自解析缓存）；没有时再从 elements 现算。
def parse_metadata(path, sections, elements=None, stats=None):
    suffix = Path(path).suffix.lower()
    parser = "unstructured" if suffix in {".pdf", ".docx"} else "plain_text"
    parser_version = unstructured_version() if parser == "unstructured" else None
    pages = []
    authors = []
    heading_detected = False
    for section in sections:
        if section.get("heading_path"):
            heading_detected = True
        for part in section.get("parts", []):
            page_number = part.get("page_number")
            if isinstance(page_number, int) and page_number > 0 and page_number not in pages:
                pages.append(page_number)
            author = part.get("author")
            if author and author not in authors:
                authors.append(author)
    properties = file_properties(path)
    total_pages = properties.pop("total_pages")
    # 有真实页数时找出没有抽到任何正文的页，扫描件或纯图片页会在这里暴露出来。
    empty_pages = None
    if total_pages:
        empty_pages = []
        for page in range(1, total_pages + 1):
            if page not in pages:
                empty_pages.append(page)
    author = authors[0] if len(authors) == 1 else None
    author_source = "unstructured_metadata" if author else None
    if not author and properties["doc_author"]:
        author = properties["doc_author"]
        author_source = "file_properties"
    content = "\n\n".join(section["text"] for section in sections)
    result = {"parser": parser, "parser_version": parser_version,
        "parse_strategy": "hi_res" if suffix == ".pdf" else ("default" if suffix == ".docx" else None),
        "table_structure_inference": TABLE_STRUCTURE_ENABLED if suffix == ".pdf" else None,
        "ocr_languages": list(OCR_LANGUAGES) if suffix == ".pdf" else None,
        "table_fallback_reason": TABLE_FALLBACK_REASON if suffix == ".pdf" and not TABLE_STRUCTURE_ENABLED else None,
        "page_count": total_pages or (max(pages) if pages else None),
        "text_page_count": len(pages) if pages else None,
        "empty_pages": empty_pages,
        "author": author, "author_source": author_source,
        "char_count": len(content), "section_count": len(sections),
        # 没识别到任何标题时整篇只有一个根章节，标题路径全空，检索效果会明显变差。
        "heading_detected": heading_detected,
        "element_counts": None, "dropped_counts": None, "languages": None}
    result.update(properties)
    if stats is not None:
        result.update(stats)
    elif elements is not None:
        result.update(element_stats(elements))
    return result


# 解析支持的文本格式并返回完整正文；不执行文档中的任何指令。
def extract_text(path):
    suffix = Path(path).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise ValueError("只支持 TXT、Markdown、PDF 和 DOCX")
    if suffix in {".txt", ".md"}:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    elements = partition_elements(path)
    texts = []
    for element in elements:
        category = element_category(element)
        text = element_text(element)
        if text and category not in SKIPPED_CATEGORIES:
            texts.append(text)
    return "\n\n".join(texts)


# 提取文本并保留 Unstructured 的标题层级，供分块器组织章节。
# 同时返回原始元素（TXT/Markdown 为 None），解析元数据需要用它统计元素类别和被丢弃的内容。
def extract_sections(path):
    suffix = Path(path).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise ValueError("只支持 TXT、Markdown、PDF 和 DOCX")
    if suffix in {".txt", ".md"}:
        from .chunking import split_sections
        return split_sections(extract_text(path), suffix), None
    elements = partition_elements(path)
    return sections_from_elements(elements), elements
