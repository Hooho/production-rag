"""一次评测跑多组配置（批次）：发起时保存了几组配置（最多 4 组），按顺序各跑一遍，放进同一份批次报告对比。

每组配置就是发起评测表单的全部内容（调参还是专项、题目、运行模式、参数配置、语料），每组照自己保存的内容跑，
没有特殊处理。每组跑出来是一条普通的评测记录（逐题详情、检索日志照常看），记录上的 batch 写着属于哪个批次、
是第几组、组名；批次本身不单独建表，用 batch.id 把几条记录串起来。

批次报告（report）把几条记录压成对比用的精简数据，不把整份结果传给前端：
- 每组的整体指标：两种模式各自的得分、全中题数、拿到的证据条数，Agent 的平均输入 token、耗时、检索次数；
- 配置差异：只列各组不一样的项（题目、模式、语料、模型、运行参数、提示词版本）；
- 逐题对比：按题目编号对齐，每组一格写两种模式各拿到几条证据；没拿到的证据写丢在哪一步。
"""

from datetime import datetime
import re

from .score import agent_item, question_score
from .suites import evidence_counts

MAX_ARMS = 4
LABELS = "ABCD"
BATCH_ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")

# 固定流程证据的去向（app/evaluation/retrieval.py 记的 status）。
FIXED_REASONS = {
    "not_recalled": "没召回",
    "not_in_pool": "没进重排候选池",
    "filtered_low_score": "被相关度阈值过滤",
    "beyond_limit": "超出返回条数",
    "returned": "交给了模型",
}


def new_batch_id():
    from uuid import uuid4

    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:6]


def check_batch_id(batch_id):
    if not BATCH_ID.match(batch_id or ""):
        raise ValueError("批次编号格式不正确")
    return batch_id


# 一组配置的名字：发起时写了就用写的，没写按顺序叫 A、B、C、D。
def arm_label(label, index):
    label = (label or "").strip()
    return label[:40] if label else f"配置 {LABELS[index]}"


# Agent 没拿到某条证据时丢在哪一步：看它每次检索的候选里有没有这条证据所在的分片，取走得最远的一次。
def agent_miss_reason(agent, index):
    best = None
    order = {
        "beyond_top_k": 0,
        "beyond_limit": 1,
        "filtered_low_score": 2,
        "in_pool": 3,
        "not_in_pool": 4,
    }
    for call in agent.get("calls") or []:
        for candidate in (call.get("retrieval_diagnostics") or {}).get(
            "candidates"
        ) or []:
            if index not in (candidate.get("hits") or []):
                continue
            status = candidate.get("agent_status") or candidate.get("status")
            key = (
                order.get(status, 5),
                -(candidate.get("rerank_probability") or 0),
                candidate.get("rrf_rank") or 999,
            )
            if best is None or key < best[0]:
                best = (key, status, candidate)
    if best is None:
        return "没召回"
    _, status, candidate = best
    score = candidate.get("rerank_probability")
    score_text = f"重排 {score:.2f}" if score is not None else ""
    if status == "beyond_top_k":
        return f"过了阈值，但 Agent 要的条数不够（{score_text}）"
    if status == "beyond_limit":
        return f"过了阈值，但超出返回上限（{score_text}）"
    if status == "filtered_low_score":
        return f"被相关度阈值过滤（最高{score_text}）"
    return f"没进重排候选池（最好排第 {candidate.get('rrf_rank')}）"


# 一条记录里的全部题目，专项按专项分组；每题两种模式各拿到几条证据、得分，没拿到的证据和原因。
def collect(run):
    if run.get("kind") == "special":
        groups = [
            (
                section.get("suite_id") or section.get("name"),
                section.get("name"),
                section.get("questions") or [],
            )
            for section in run.get("special") or []
        ]
    else:
        groups = [("tuning", "调参题", run.get("questions") or [])]
    entries = []
    for group_id, group_name, questions in groups:
        for question in questions:
            answerable = question.get("answerable", True)
            fixed_hits, agent_hits, total = evidence_counts(question)
            fixed_items = question.get("fixed_evidence") or (
                [
                    item
                    for item in question.get("evidence") or []
                    if isinstance(item, dict) and "given" in item
                ]
                or None
            )
            if fixed_items is not None and fixed_hits is None:
                fixed_hits = sum(1 for item in fixed_items if item.get("given"))
            fixed = None
            if fixed_items is not None:
                fixed = {
                    "found": fixed_hits,
                    "total": total,
                    "score": question_score(
                        answerable,
                        fixed_hits or 0,
                        total,
                        question.get("returned") or 0,
                    ),
                    "missing": [
                        {
                            "label": item.get("label") or item.get("text"),
                            "reason": FIXED_REASONS.get(
                                item.get("status"), item.get("status") or "没拿到"
                            ),
                        }
                        for item in fixed_items
                        if not item.get("given")
                    ],
                }
            agent = None
            if question.get("agent"):
                raw = question["agent"]
                evidence = raw.get("evidence") or []
                agent = {
                    "found": agent_hits,
                    "total": len(evidence) or total,
                    "score": question_score(*agent_item(answerable, raw)),
                    "status": raw.get("status"),
                    "searches": raw.get("searches"),
                    "prompt_tokens": raw.get("prompt_tokens"),
                    "latency_ms": raw.get("latency_ms"),
                    "missing": [
                        {
                            "label": item.get("label") or item.get("text"),
                            "reason": agent_miss_reason(raw, index),
                        }
                        for index, item in enumerate(evidence)
                        if not item.get("found")
                    ],
                }
            entries.append(
                {
                    "key": f"{group_id}:{question.get('id')}",
                    "group": group_name,
                    "id": question.get("id"),
                    "question": question.get("question"),
                    "type": question.get("type"),
                    "fixed": fixed,
                    "agent": agent,
                }
            )
    return entries


def _mean(values):
    values = [value for value in values if value is not None]
    return round(sum(values) / len(values), 1) if values else None


# 一组的整体指标：两种模式分开算，没跑的模式是 None。
def summarize(entries):
    result = {"questions": len(entries)}
    for mode in ("fixed", "agent"):
        cells = [entry[mode] for entry in entries if entry[mode]]
        if not cells:
            result[mode] = None
            continue
        summary = {
            "score": _mean([cell["score"] for cell in cells]),
            "passed": sum(
                1
                for cell in cells
                if cell["total"] and (cell["found"] or 0) >= cell["total"]
            ),
            "found": sum(cell["found"] or 0 for cell in cells),
            "total": sum(cell["total"] or 0 for cell in cells),
        }
        if mode == "agent":
            summary.update(
                prompt_tokens=_mean([cell["prompt_tokens"] for cell in cells]),
                latency_ms=_mean([cell["latency_ms"] for cell in cells]),
                searches=_mean([cell["searches"] for cell in cells]),
                failed=sum(
                    1
                    for cell in cells
                    if cell["status"] and cell["status"] != "completed"
                ),
            )
        result[mode] = summary
    return result


# 一组配置在报告里要比较的各项：题目范围、运行模式、语料，以及实际生效的模型、运行参数、提示词版本。
def config_values(run):
    config = run.get("config") or {}
    effective = run.get("effective") or {}
    if run.get("kind") == "special":
        scope = "专项：" + "、".join(
            item.get("name", "")
            for item in (config.get("special") or {}).get("suites") or []
        )
    else:
        scope = f"{'生成' if run.get('kind') == 'generation' else '检索'}评测 · {config.get('split')}"
    values = {
        "题目": scope,
        "运行模式": "+".join(config.get("modes") or ["fixed"]),
        "评测语料": "、".join(
            item.get("title", "") for item in config.get("corpus") or []
        )
        or "全部",
        "大模型": (effective.get("llm") or {}).get("model"),
        "评审模型": (effective.get("judge") or {}).get("model"),
    }
    for key, value in (effective.get("settings") or {}).items():
        values[f"setting:{key}"] = value
    for key, value in (effective.get("prompts") or {}).items():
        values[f"prompt:{key}"] = value
    return values


EFFECTIVE_KEYS = ("大模型", "评审模型")


# 只留各组不一样的项。模型、运行参数、提示词版本开跑时才记下（effective），还没开跑的组这几项不参与比较。
def config_diff(runs):
    rows = []
    all_values = [config_values(run) for run in runs]
    started = [bool(run.get("effective")) for run in runs]
    keys = list(dict.fromkeys(key for values in all_values for key in values))
    for key in keys:
        from_effective = key in EFFECTIVE_KEYS or key.startswith(
            ("setting:", "prompt:")
        )
        cells = [
            values.get(key) if (started[index] or not from_effective) else None
            for index, values in enumerate(all_values)
        ]
        compared = [
            cell
            for index, cell in enumerate(cells)
            if started[index] or not from_effective
        ]
        if len({repr(cell) for cell in compared}) > 1:
            rows.append({"key": key, "values": cells})
    return rows


# 批次报告：runs 是这个批次的完整评测记录（按组的顺序）。
def report(batch_id, runs):
    arms = []
    by_key = {}
    order = []
    for index, run in enumerate(runs):
        batch = run.get("batch") or {}
        entries = collect(run) if run.get("status") == "completed" else []
        arms.append(
            {
                "id": run["id"],
                "label": batch.get("label") or arm_label(None, index),
                "status": run.get("status"),
                "progress": run.get("progress"),
                "error": run.get("error"),
                "params": run.get("params") or {},
                "summary": summarize(entries) if entries else None,
            }
        )
        for entry in entries:
            if entry["key"] not in by_key:
                by_key[entry["key"]] = {
                    key: entry[key]
                    for key in ("key", "group", "id", "question", "type")
                }
                by_key[entry["key"]]["cells"] = [None] * len(runs)
                order.append(entry["key"])
            by_key[entry["key"]]["cells"][index] = {
                "fixed": entry["fixed"],
                "agent": entry["agent"],
            }
    first = runs[0] if runs else {}
    return {
        "id": batch_id,
        "name": (first.get("batch") or {}).get("name") or "",
        "created": first.get("created"),
        "arms": arms,
        "config_diff": config_diff(runs),
        "questions": [by_key[key] for key in order],
    }
