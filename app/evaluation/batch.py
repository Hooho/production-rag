"""一次评测跑多组配置（批次）：发起时保存了几组配置（最多 4 组），按顺序各跑一遍，放进同一份批次报告对比。

每组配置就是发起评测表单的全部内容（调参还是专项、题目、运行模式、参数配置、语料），每组照自己保存的内容跑，
没有特殊处理。每组跑出来是一条普通的评测记录（逐题详情、检索日志照常看），记录上的 batch 写着属于哪个批次、
是第几组、组名；批次本身不单独建表，用 batch.id 把几条记录串起来。

批次报告（report）：每组的状态和改了哪些参数、各组配置不一样的项，以及每组的完整结果。
前端用和单次评测同一套报告组件（汇总卡片、按类型、逐题），一组配置的一个模式一列。
"""

from datetime import datetime
import re


MAX_ARMS = 4
LABELS = "ABCD"
BATCH_ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


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


# 批次报告：runs 是这个批次的完整评测记录（按组的顺序）。每组的完整结果原样带上（还没跑完的组是 None），
# 前端用和单次评测同一套报告组件，一组配置的一个模式一列。
def report(batch_id, runs):
    arms = []
    for index, run in enumerate(runs):
        batch = run.get("batch") or {}
        arms.append(
            {
                "id": run["id"],
                "label": batch.get("label") or arm_label(None, index),
                "status": run.get("status"),
                "progress": run.get("progress"),
                "error": run.get("error"),
                "params": run.get("params") or {},
            }
        )
    first = runs[0] if runs else {}
    return {
        "id": batch_id,
        "name": (first.get("batch") or {}).get("name") or "",
        "created": first.get("created"),
        "arms": arms,
        "config_diff": config_diff(runs),
        "runs": [run if run.get("status") == "completed" else None for run in runs],
    }
