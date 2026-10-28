"""汇总题的命名计分项：目标分片负责计分，摘录仅供展示。"""
import hashlib
import re
import unicodedata


def fingerprint(content):
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", content or ""))
    return hashlib.sha256(text.encode()).hexdigest()


def bind_groups(texts, groups, catalog):
    if not groups:
        return texts
    if len(texts) != len(groups):
        raise ValueError("汇总题计分项与证据数量不一致，请重新标注")
    indexed = {(row["title"], row["position"]): row for row in catalog}
    evidence = []
    for text, group in zip(texts, groups):
        targets = []
        for target in group["targets"]:
            row = indexed.get((target["title"], target["position"]))
            if not row or fingerprint(row["content"]) != target["fingerprint"]:
                raise ValueError(f"计分项「{group['label']}」目标分片已变化或未导入，请重新标注后评测")
            targets.append({"chunk_id": str(row["chunk_id"]), "position": row["position"],
                "title": row["title"], "quote": target["quote"]})
        if not targets:
            raise ValueError("汇总题计分项缺少目标分片")
        evidence.append({"text": text, "label": group["label"], "targets": targets})
    return evidence


def evidence_fields(value):
    return value if isinstance(value, dict) else {"text": value}


def match_evidence(candidates, evidence, chunk_texts, legacy_variants):
    """新计分项只看目标 ID；旧题兼容原文匹配。"""
    variants = [None if isinstance(value, dict) else legacy_variants(value) for value in evidence]
    hits = {}
    for candidate in candidates:
        chunk_id = candidate["chunk_id"]
        found = []
        for index, value in enumerate(evidence):
            matched = (any(target["chunk_id"] == chunk_id for target in value["targets"])
                if isinstance(value, dict) else any(part in chunk_texts.get(chunk_id, "") for part in variants[index]))
            if matched:
                found.append(index)
        if found:
            hits[chunk_id] = found
    return hits
