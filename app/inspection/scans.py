# 主动扫描：不等用户提问出错，直接检查知识库里的文档。目前只有「解析质量」。
# 文档上传后要先从 PDF、Word 里把文字提取出来再分片，提取出问题时（乱码、扫描件没有文字、页眉页脚混进正文、
# 汉字被空格拆开、切成一堆碎片），检索和回答都会受影响，但用户只会看到"找不到"或"答得奇怪"，很难追到原因。
# 这里每次巡检把所有文档的当前版本检查一遍：纯规则统计，不调用模型，几百份文档也只要几秒。
#   有问题：建一个「解析质量」问题，按文档合并（同一份文档只有一个问题）；
#   上传了新版本且检查通过：自动标为已解决；标记已处理后上传的新版本仍有问题：重新打开；
#   文档被删除：自动标为已解决；标记无需处理的只更新检查结果，不再提醒。
from collections import Counter
import re

from sqlalchemy import select

from ..mysql.store import chunks, document_chunks, document_heads, documents, inspection_issues


# 判定阈值。都是经验值：偶尔一两个乱码字符、一两段很短的分片（比如标题段）很正常，不算问题。
# 乱码字符占全文的比例达到 0.5%、且至少 5 个，才算乱码。
GARBLED_RATE = 0.005
GARBLED_MIN = 5
# 不到 50 个字的分片算碎片；分片数不少于 4 个、碎片占 30% 以上才算问题（文档本来就短时不报）。
SHORT_CHARS = 50
SHORT_RATIO = 0.3
MIN_CHUNKS = 4
# 同一行文字出现在一半以上的分片里，多半是页眉、页脚或水印被当成了正文。
REPEAT_RATIO = 0.5
# 全文不到 20 个字：多半是扫描件或图片，没有提取到文字。
EMPTY_CHARS = 20
# 「退 货 政 策」这种连续 5 个以上被空格拆开的汉字，出现 3 处以上算问题（PDF 按字排版时常见）。
SPACED_MIN = 3

GARBLED = re.compile(r"[�\x00-\x08\x0b\x0c\x0e-\x1f\x7f-]|[ÃÂ][\x80-\xbf]|â€")
SPACED = re.compile(r"(?:[一-鿿][ 　]){4,}[一-鿿]")
PROBLEMS = {
    "empty": "几乎没有提取到文字",
    "garbled": "有乱码",
    "spaced": "汉字被空格拆开",
    "repeated": "页眉页脚混进正文",
    "fragments": "分片太碎",
}


# 找出所有匹配，返回数量和原文例子；相邻的匹配只取一个例子，免得几个例子是同一段话。
def matches(pattern, texts, margin):
    count = 0
    examples = []
    for text in texts:
        covered = -1
        for match in pattern.finditer(text):
            count += 1
            if match.start() > covered:
                examples.append(snippet(text, match.start(), match.end(), margin))
                covered = match.end() + margin * 2
    return count, examples


def snippet(text, start, end, margin=30):
    left = max(0, start - margin)
    return ("…" if left else "") + text[left:end + margin].replace("\n", " ") + ("…" if end + margin < len(text) else "")


# 检查一份文档的所有分片，返回发现的问题（没有问题时为空列表）。每个问题带一个数值和最多 3 个原文例子。
def check_document(texts):
    problems = []
    total = sum(len(text) for text in texts)
    if total < EMPTY_CHARS:
        return [{"code": "empty", "label": PROBLEMS["empty"], "value": total,
            "message": f"整份文档只提取到 {total} 个字", "examples": [text for text in texts if text.strip()][:1]}]
    garbled, examples = matches(GARBLED, texts, 30)
    if garbled >= GARBLED_MIN and garbled / total >= GARBLED_RATE:
        problems.append({"code": "garbled", "label": PROBLEMS["garbled"], "value": round(garbled / total, 4),
            "message": f"有 {garbled} 处乱码字符，占全文 {garbled / total:.1%}", "examples": examples[:3]})
    spaced, examples = matches(SPACED, texts, 10)
    if spaced >= SPACED_MIN:
        problems.append({"code": "spaced", "label": PROBLEMS["spaced"], "value": spaced,
            "message": f"有 {spaced} 处连续的汉字被空格隔开，检索时这些词匹配不上", "examples": examples[:3]})
    if len(texts) >= MIN_CHUNKS:
        lines = Counter()
        for text in texts:
            lines.update({line.strip() for line in text.splitlines() if 4 <= len(line.strip()) <= 60})
        repeated = [line for line, count in lines.most_common(3) if count >= len(texts) * REPEAT_RATIO]
        if repeated:
            problems.append({"code": "repeated", "label": PROBLEMS["repeated"], "value": lines[repeated[0]],
                "message": f"「{repeated[0]}」出现在 {lines[repeated[0]]} / {len(texts)} 个分片里",
                "examples": repeated})
        short = sorted((text for text in texts if len(text.strip()) < SHORT_CHARS), key=len)
        if len(short) / len(texts) >= SHORT_RATIO:
            problems.append({"code": "fragments", "label": PROBLEMS["fragments"], "value": round(len(short) / len(texts), 4),
                "message": f"{len(short)} / {len(texts)} 个分片不到 {SHORT_CHARS} 个字，单独检索到时看不出在说什么",
                "examples": [text.strip().replace("\n", " ") or "（空白）" for text in short[:3]]})
    return problems


def load_documents(connection):
    heads = connection.execute(select(document_heads.c.doc_key, document_heads.c.owner, document_heads.c.title,
        document_heads.c.current_document_id, document_heads.c.current_version, documents.c.filename).join(
            documents, documents.c.id == document_heads.c.current_document_id)).mappings().all()
    rows = connection.execute(select(document_chunks.c.document_id, chunks.c.text, chunks.c.content).join(
        chunks, chunks.c.id == document_chunks.c.chunk_id).where(document_chunks.c.document_id.in_(
            [head["current_document_id"] for head in heads])).order_by(document_chunks.c.position)).all() if heads else []
    texts = {}
    for document_id, text, content in rows:
        texts.setdefault(document_id, []).append(content or text or "")
    return heads, texts


# 检查所有文档并更新「解析质量」问题。inspector 提供 create_issue、now、stats；doc_keys 只检查这几份（页面上的「重新检查」）。
def scan_parse_quality(inspector, connection, doc_keys=None, by=None):
    from .service import fingerprint
    now = inspector.now
    stats = inspector.stats
    heads, texts = load_documents(connection)
    existing = {row["fingerprint"]: row for row in connection.execute(select(inspection_issues).where(
        inspection_issues.c.kind == "parse_quality")).mappings().all()}
    seen = set()
    for head in heads:
        if doc_keys is not None and head["doc_key"] not in doc_keys:
            continue
        key = fingerprint("parse_quality", head["doc_key"])
        seen.add(key)
        stats["parse_checked"] += 1
        document_texts = texts.get(head["current_document_id"], [])
        problems = check_document(document_texts)
        info = {"doc_key": head["doc_key"], "document_id": head["current_document_id"], "owner": head["owner"],
            "document_title": head["title"], "filename": head["filename"], "version": head["current_version"],
            "chunks": len(document_texts), "chars": sum(len(text) for text in document_texts),
            "problems": problems, "checked": now}
        if by:
            info["checked_by"] = by
        issue = existing.get(key)
        if problems:
            stats["parse_bad"] += 1
            title = f"《{head['title']}》{'、'.join(problem['label'] for problem in problems)}"
            if issue is None:
                inspector.create_issue(connection, "parse_quality", key, title, now, detail=info)
                continue
            detail = {**(issue["detail"] or {}), **info}
            values = {"title": title[:200], "detail": detail, "last_seen": now, "updated": now}
            new_version = (issue["detail"] or {}).get("document_id") != head["current_document_id"]
            if issue["status"] in ("handled", "resolved") and new_version:
                detail["verification"] = {"at": now, "message": f"上传的第 {head['current_version']} 版解析仍有问题"}
                values.update({"status": "open", "status_by": "system", "status_updated": now})
                stats["parse_reopened"] += 1
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue["id"]).values(**values))
        elif issue is not None:
            detail = {**(issue["detail"] or {}), **info}
            values = {"detail": detail, "updated": now}
            if issue["status"] in ("open", "handled"):
                detail.pop("verification", None)
                detail["resolution"] = (f"{'验证通过：' if issue['status'] == 'handled' else ''}"
                    f"第 {head['current_version']} 版解析正常")
                values.update({"status": "resolved", "status_by": "system", "status_updated": now})
                stats["parse_resolved"] += 1
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue["id"]).values(**values))
    if doc_keys is not None:
        return
    for key, issue in existing.items():
        if key in seen or issue["status"] not in ("open", "handled"):
            continue
        detail = {**(issue["detail"] or {}), "resolution": "文档已删除"}
        connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue["id"]).values(
            status="resolved", status_by="system", status_updated=now, detail=detail, updated=now))
        stats["parse_resolved"] += 1
