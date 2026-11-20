"""图谱检查报告里的 AI 判断（judgments）单独存在 graph_step_judgments，每项一行。

报告（document_steps.result）写入前用 detach 拆出 judgments：只写内容变了的行，删掉不在报告里的行，
返回不带 judgments 的报告去存。读报告后用 attach 把 judgments 拼回去，接口和前端看到的结构不变。

约定：
- 报告里没有 judgments 这个键：判断不变（只改了状态、人工决定等）。要清空判断就显式给空的 {} / []。
- attach(trace=False) 读出的判断不带 prompt 和模型原始输出（列表页、步骤条用）；
  这样的判断再写回去时，库里的 prompt 和原始输出保留不动。
- 旧数据：报告里本来就存着 judgments 的，attach 原样返回；下一次保存时拆到新表。
"""

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import and_, delete, select

from .tables import graph_step_judgments as table

# 检查漏合并的判断是列表（每项带 candidate_id），前 4 步是 {项编号: 判断}。
LIST_STEPS = {"graph_review"}
DICT_STEPS = {
    "graph_check_glean",
    "graph_check_relation",
    "graph_check_type",
    "graph_check_split",
}
TRACE_KEYS = ("prompt", "raw_output")
CHUNK = 500


def tracked(step_id):
    return step_id in LIST_STEPS or step_id in DICT_STEPS


def _empty(step_id):
    return [] if step_id in LIST_STEPS else {}


def _entries(step_id, judgments):
    if step_id in LIST_STEPS:
        return [(str(row["candidate_id"]), row) for row in judgments or []]
    return [(str(key), row) for key, row in (judgments or {}).items()]


def _split(row):
    data = {key: value for key, value in row.items() if key not in TRACE_KEYS}
    trace = {key: row[key] for key in TRACE_KEYS if key in row}
    return data, trace


def _digest(position, data, trace):
    text = json.dumps(
        [position, data, trace], ensure_ascii=False, sort_keys=True, default=str
    )
    return hashlib.sha256(text.encode()).hexdigest()


def _where(document_id, step_id):
    return and_(table.c.document_id == document_id, table.c.step_id == step_id)


def detach(connection, document_id, step_id, result):
    """保存报告前调用：把 judgments 逐项写进 graph_step_judgments，返回要存进 document_steps 的报告。"""
    if (
        not tracked(step_id)
        or not isinstance(result, dict)
        or "judgments" not in result
        or not result.get("build_id")
    ):
        return result
    build_id = result["build_id"]
    where = _where(document_id, step_id)
    # 每份文档每步只留最近一次建图的判断。
    connection.execute(delete(table).where(where, table.c.build_id != build_id))
    existing = dict(
        connection.execute(select(table.c.item_id, table.c.digest).where(where)).all()
    )
    wanted = {}
    for position, (item_id, row) in enumerate(_entries(step_id, result["judgments"])):
        data, trace = _split(row)
        wanted[item_id] = (position, data, trace, _digest(position, data, trace))
    stale = [key for key in existing if key not in wanted]
    for start in range(0, len(stale), CHUNK):
        connection.execute(
            delete(table).where(
                where, table.c.item_id.in_(stale[start : start + CHUNK])
            )
        )
    updated = datetime.now(timezone.utc).isoformat()
    inserts = []
    for item_id, (position, data, trace, digest) in wanted.items():
        if existing.get(item_id) == digest:
            continue
        values = {
            "build_id": build_id,
            "position": position,
            "digest": digest,
            "data": data,
            "updated": updated,
        }
        # 不带 prompt 的判断（trace=False 读出来的）写回时不覆盖库里的 prompt。
        if trace:
            values["trace"] = trace
        if item_id in existing:
            connection.execute(
                table.update().where(where, table.c.item_id == item_id).values(**values)
            )
        else:
            inserts.append(
                {
                    "document_id": document_id,
                    "step_id": step_id,
                    "item_id": item_id,
                    "trace": None,
                    **values,
                }
            )
    for start in range(0, len(inserts), CHUNK):
        connection.execute(table.insert(), inserts[start : start + CHUNK])
    return {key: value for key, value in result.items() if key != "judgments"}


def attach(connection, document_id, step_id, result, trace=True):
    """读报告后调用：把 graph_step_judgments 里这次建图的判断拼回 judgments。"""
    if (
        not tracked(step_id)
        or not isinstance(result, dict)
        or not result.get("build_id")
        or "judgments" in result
    ):
        return result
    columns = [table.c.item_id, table.c.data] + ([table.c.trace] if trace else [])
    rows = connection.execute(
        select(*columns)
        .where(_where(document_id, step_id), table.c.build_id == result["build_id"])
        .order_by(table.c.position)
    ).all()
    judgments = _empty(step_id)
    for row in rows:
        value = {**row.data, **((row.trace or {}) if trace else {})}
        if step_id in LIST_STEPS:
            judgments.append(value)
        else:
            judgments[row.item_id] = value
    return {**result, "judgments": judgments}


def remove(connection, document_ids, step_ids=None):
    """删掉文档（或文档的部分步骤）时一起删判断。"""
    document_ids = list(document_ids)
    for start in range(0, len(document_ids), CHUNK):
        condition = table.c.document_id.in_(document_ids[start : start + CHUNK])
        if step_ids is not None:
            condition = and_(condition, table.c.step_id.in_(list(step_ids)))
        connection.execute(delete(table).where(condition))
