"""统一报告的展示字段，只使用当次记录，不查询当前题库或重算成绩。"""

from copy import deepcopy


def _question(question):
    metadata = {}

    def collect(value):
        if isinstance(value, dict):
            chunk_id = value.get("chunk_id")
            if chunk_id:
                metadata.setdefault(str(chunk_id), {}).update(
                    {
                        key: value[key]
                        for key in ("position", "title")
                        if value.get(key) is not None
                    }
                )
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(question)
    buckets = [
        question.get("evidence") or [],
        question.get("fixed_evidence") or [],
        (question.get("agent") or {}).get("evidence") or [],
        (question.get("retry") or {}).get("evidence") or [],
    ]
    for index in range(max(map(len, buckets), default=0)):
        entries = [
            bucket[index]
            for bucket in buckets
            if index < len(bucket) and isinstance(bucket[index], dict)
        ]
        label = next(
            (entry["label"] for entry in entries if entry.get("label")),
            f"要点 {index + 1}",
        )
        targets = {}
        for entry in entries:
            for target in entry.get("targets") or []:
                targets[str(target["chunk_id"])] = target
            ids = entry.get("chunk_ids") or (
                [entry["chunk_id"]] if entry.get("chunk_id") else []
            )
            positions = entry.get("positions") or []
            for order, chunk_id in enumerate(ids):
                chunk_id = str(chunk_id)
                info = metadata.get(chunk_id, {})
                position = positions[order] if order < len(positions) else None
                if position is None:
                    position = info.get("position")
                targets.setdefault(
                    chunk_id,
                    {
                        "chunk_id": chunk_id,
                        "position": position,
                        "title": info.get("title") or "",
                        "quote": entry.get("text") or "",
                    },
                )
        for entry in entries:
            entry["label"] = entry.get("label") or label
            if entry.get("targets") is None:
                entry["targets"] = deepcopy(list(targets.values()))


def normalize_report(run):
    result = deepcopy(run)

    def visit(value):
        if isinstance(value, dict):
            for question in value.get("questions") or []:
                if isinstance(question, dict):
                    _question(question)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(result)
    return result
