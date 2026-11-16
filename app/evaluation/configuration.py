"""Unified evaluation inputs: questions describe expectations, configurations describe execution."""

import copy

from .dataset import select_split


def questions(dataset, split, suites=()):
    if not suites:
        return copy.deepcopy(select_split(dataset, split))
    result = []
    for suite in suites:
        for source in suite["items"]:
            if source.get("enabled") is False:
                continue
            item = copy.deepcopy(source)
            if item.get("turns") and not item.get("prelude"):
                raise ValueError(
                    f"「{suite['name']}」含有旧版动态多轮题，请先保存固定的前置问答"
                )
            item.update(
                reviewed=True,
                split="all",
                source_suite_id=suite["id"],
                source_suite_name=suite["name"],
            )
            item["id"] = f"{suite['id']}:{item['id']}"
            item["type"] = item.get("type") or suite["name"]
            item.setdefault("answerable", True)
            result.append(item)
    return result


def validate_questions(items, kind):
    if not items:
        raise ValueError("当前题目范围没有已审核题目")
    for item in items:
        if (
            kind == "retrieval"
            and item.get("answerable", True)
            and not (item.get("evidence") or item.get("evidence_groups"))
        ):
            raise ValueError(f"题目「{item['question'][:40]}」缺少计分证据，请先补齐")
        if (
            kind == "generation"
            and item.get("answerable", True)
            and not item.get("reference_answer")
        ):
            raise ValueError(f"题目「{item['question'][:40]}」缺少参考答案，请先补齐")
    return items
