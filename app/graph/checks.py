"""图谱检查的前 4 步：① 补抽 ② 关系核对 ③ 类型核对 ④ 拆分（⑤ 合并在 review.py / build.py 里）。

每一步的流程一样：
1. 找可疑项（系统，不调用模型）：在「抽取结果 + 前面各步已写入的决定」算出的图上找，也就是在最新写入的结果上检查。
2. AI 判断：人确认后，每个可疑项调用一次模型。
3. 人逐条决定（采纳 / 不采纳，可以改模型的建议）。
4. 确认写入：把采纳的决定记成这一步的 applied，按「抽取结果 + 各步 applied」重算整份图谱，存成一个新版本（不自动生效）。

报告存在 document_steps 里（每步一行），结构：
  {build_id, step, status, phase, params, signature, items, judgments, decisions, applied, stale, started, scan}
其中 judgments（每项的 AI 判断，带 prompt 和模型原始输出）逐项存在 graph_step_judgments，
读写报告时由 mysql/step_judgments.py 拆开、拼回（每判断完一项只写一行，不再整份重写）。
status：idle 未开始 / queued 排队 / running 进行中 / scanned 找完待确认判断 / stopped 已停止 /
        ready 可以决定 / rewriting 正在写入 / skipped 已跳过 / failed 失败。
"""

import copy
import hashlib
import json
import re
import time

import numpy
from sqlalchemy import select

from .. import prompts
from ..mysql import step_judgments
from ..mysql.tables import document_steps, graph_builds
from . import build as graph_build
from . import extract, resolve, review
from .schemas import now, type_names

ORDER = ["glean", "relation", "type", "split", "merge"]
STEP_IDS = {
    "glean": "graph_check_glean",
    "relation": "graph_check_relation",
    "type": "graph_check_type",
    "split": "graph_check_split",
}
TITLES = {
    "glean": "图谱检查 · 补抽",
    "relation": "图谱检查 · 关系核对",
    "type": "图谱检查 · 类型核对",
    "split": "图谱检查 · 拆分",
}
PROMPTS = {
    "glean": "graph_glean",
    "relation": "graph_verify",
    "type": "graph_type",
    "split": "graph_split",
}
# 写入某一步后，哪些后面的步骤要重新检查：补抽影响全部；改类型影响拆分、合并；拆分影响合并；关系核对谁都不影响。
DEPENDS = {
    "glean": ["relation", "type", "split", "merge"],
    "relation": [],
    "type": ["split", "merge"],
    "split": ["merge"],
    "merge": [],
}
# 每个任务最多判断多少项，判断完剩下的重新排队。
BATCH = 20
# 拆分：同一个实体下两堆名字的平均相似度低于它，就列为可疑。阈值要在实际数据上调。
SPLIT_MAX_SIMILARITY = 0.72
SPLIT_MAX_MENTIONS = 30
EXCERPT = 600
HUMAN_KEYS = ("decisions", "applied")


class CheckError(Exception):
    pass


def norm(text):
    return "".join(resolve.fold(text).split())


def short_id(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[
        :16
    ]


def excerpt(content, name, size=EXCERPT):
    content = content or ""
    index = content.find(name) if name else -1
    if index < 0 or len(content) <= size:
        return content[:size]
    start = max(0, index - size // 2)
    return content[start : start + size]


# ---------- 报告读写 ----------


# judgments：True 带上全部 AI 判断（含 prompt、原始输出）；"light" 不带 prompt 和原始输出；
# False 不读判断（只看状态、人工决定时用，判断多时省很多读取）。不读判断的报告写回去时判断保持不变。
def report_in(connection, build, step, judgments=True):
    result = connection.execute(
        select(document_steps.c.result).where(
            document_steps.c.document_id == build["document_id"],
            document_steps.c.step_id == STEP_IDS[step],
        )
    ).scalar_one_or_none()
    if not (isinstance(result, dict) and result.get("build_id") == build["id"]):
        return None
    if not judgments:
        return result
    return step_judgments.attach(
        connection,
        build["document_id"],
        STEP_IDS[step],
        result,
        trace=judgments != "light",
    )


def report(engine, build, step, judgments=True):
    with engine.connect() as connection:
        return report_in(connection, build, step, judgments)


def reports(engine, build, judgments=True):
    with engine.connect() as connection:
        return {
            step: report_in(connection, build, step, judgments) for step in STEP_IDS
        }


def write(store, build, step, value, status, detail):
    graph_build.write_step(
        store, build["document_id"], STEP_IDS[step], status, detail, value
    )


def save_in(connection, build, step, value, status, detail):
    result = step_judgments.detach(
        connection, build["document_id"], STEP_IDS[step], value
    )
    connection.execute(
        document_steps.update()
        .where(
            document_steps.c.document_id == build["document_id"],
            document_steps.c.step_id == STEP_IDS[step],
        )
        .values(result=result, status=status, detail=detail, updated=now())
    )


def lock(connection, build):
    current = connection.execute(
        select(graph_builds.c.status)
        .where(graph_builds.c.id == build["id"])
        .with_for_update()
    ).scalar_one()
    if current in ("queued", "running"):
        raise CheckError("建图或写入图谱进行中，完成后再试")


# ---------- 图：抽取结果 + 各步已写入的决定 ----------


def plan_for(connection, build, rows, applied, upto=None):
    """按「抽取结果 + 各步 applied」算写入方案；upto 给了就只套用这一步之前的（检查这一步时用）。"""
    steps = ORDER[: ORDER.index(upto)] if upto else ORDER[:-1]
    rows = copy.deepcopy(rows)
    if "glean" in steps and applied.get("glean"):
        apply_glean(rows, applied["glean"])
    plan = resolve.prepare_build(
        connection, build["space"], build["id"], rows, build["created_by"]
    )
    if "relation" in steps and applied.get("relation"):
        apply_relation(plan, applied["relation"])
    if "type" in steps and applied.get("type"):
        apply_type(connection, plan, build, applied["type"])
    if "split" in steps and applied.get("split"):
        apply_split(connection, plan, build, applied["split"])
    return plan


def applied_of(engine, build):
    return {
        step: (value or {}).get("applied", {}).get("items")
        for step, value in reports(engine, build, judgments=False).items()
    }


def refresh_summary(plan):
    used = {item["entity_id"] for item in plan["mentions"]}
    plan["entities"] = [item for item in plan["entities"] if item["id"] in used]
    plan["summary"].update(
        entity_count=len(used),
        created_count=len(plan["entities"]),
        relation_count=sum(
            row.get("status", "active") == "active" for row in plan["relations"]
        ),
    )
    plan["summary"]["methods"] = {
        method: sum(item["resolve_method"] == method for item in plan["mentions"])
        for method in {item["resolve_method"] for item in plan["mentions"]}
    }


# ① 补抽：采纳的新实体、新关系加进那一片的抽取结果（名字重复的跳过）。
def apply_glean(rows, items):
    by_chunk = {row["chunk_id"]: row for row in rows}
    for chunk_id, extra in items.items():
        row = by_chunk.get(chunk_id)
        if row is None:
            continue
        result = row["result"] = copy.deepcopy(row.get("result") or {})
        entities = result.setdefault("entities", [])
        names = {item["name"] for item in entities}
        for item in extra.get("entities") or []:
            if item["name"] not in names:
                entities.append({**item, "origin": "glean"})
                names.add(item["name"])
        relations = result.setdefault("relations", [])
        seen = {(r["source"], r["target"], r.get("description")) for r in relations}
        for item in extra.get("relations") or []:
            key = (item["source"], item["target"], item.get("description"))
            if key not in seen and item["source"] in names and item["target"] in names:
                relations.append(item)
                seen.add(key)


def relation_key(plan_mentions, relation):
    source = plan_mentions.get(relation["source_mention_id"]) or {}
    target = plan_mentions.get(relation["target_mention_id"]) or {}
    return short_id(
        relation["chunk_id"],
        source.get("name"),
        target.get("name"),
        relation.get("description"),
        relation.get("evidence"),
    )


# ② 关系核对：采纳「删除」的关系标成已删除（查询只读 active）。
def apply_relation(plan, keys):
    mentions = {row["id"]: row for row in plan["mentions"]}
    wanted = set(keys)
    for relation in plan["relations"]:
        if relation_key(mentions, relation) in wanted:
            relation["status"] = "deleted"
    refresh_summary(plan)


def name_key(name):
    return norm(resolve.normalize(name)).lower()


# ③ 类型核对：这个名字在这份文档里的所有出现都改成选定的类型（标准名不变），再按身份归属。
def apply_type(connection, plan, build, items):
    for item in items:
        groups = {}
        for mention in plan["mentions"]:
            if name_key(mention["canonical"]) == item["name_key"]:
                groups.setdefault(mention["canonical"], []).append(mention["id"])
        for canonical, ids in groups.items():
            review.rename(
                connection, plan, build["space"], ids, canonical, item["type"]
            )
    refresh_summary(plan)


# ④ 拆分：除第一组外，每组名字改成新名字（第一组保留原名）。名字按「分片 + 原名」定位。
def apply_split(connection, plan, build, items):
    for item in items:
        for group in item["groups"][1:]:
            if not group.get("name"):
                continue
            wanted = {tuple(key.split("|", 1)) for key in group["mentions"]}
            ids = [
                row["id"]
                for row in plan["mentions"]
                if (row["chunk_id"], row["name"]) in wanted
                and name_key(row["canonical"]) == item["name_key"]
            ]
            if ids:
                review.rename(
                    connection,
                    plan,
                    build["space"],
                    ids,
                    group["name"],
                    group.get("type") or item["type"],
                )
    refresh_summary(plan)


# ---------- 找可疑项 ----------


def scan_glean(plan, chunks, params, models):
    counts = {}
    for mention in plan["mentions"]:
        counts[mention["chunk_id"]] = counts.get(mention["chunk_id"], 0) + 1
    scope = (params or {}).get("scope") or "few"
    items = []
    for chunk in chunks:
        count = counts.get(chunk["chunk_id"], 0)
        if scope == "few" and count > 1:
            continue
        items.append(
            {
                "id": chunk["chunk_id"],
                "chunk_id": chunk["chunk_id"],
                "position": chunk["position"],
                "entity_count": count,
                "names": sorted(
                    {
                        row["name"]
                        for row in plan["mentions"]
                        if row["chunk_id"] == chunk["chunk_id"]
                    }
                ),
                # 「原文」浮窗看整片（补的实体、关系可能在后半段），不截断。
                "excerpt": chunk["content"],
            }
        )
    return items


def scan_relation(plan, chunks, params, models):
    by_chunk = {chunk["chunk_id"]: chunk for chunk in chunks}
    mentions = {row["id"]: row for row in plan["mentions"]}
    sample = int((params or {}).get("sample") or 0)
    items = []
    for relation in plan["relations"]:
        if relation.get("status", "active") != "active":
            continue
        chunk = by_chunk.get(relation["chunk_id"]) or {}
        content = norm(chunk.get("content"))
        around = norm(
            " ".join(
                [
                    chunk.get("document_title") or "",
                    " ".join(chunk.get("heading_path") or []),
                    chunk.get("context") or "",
                ]
            )
        )
        source = mentions.get(relation["source_mention_id"]) or {}
        target = mentions.get(relation["target_mention_id"]) or {}
        parts = [norm(part) for part in (relation.get("evidence") or "").split("||")]
        parts = [part for part in parts if part]
        reasons = []
        if not parts:
            reasons.append("no_evidence")
        elif not all(part in content for part in parts):
            reasons.append(
                "context_only"
                if all(part in content or part in around for part in parts)
                else "not_found"
            )
        missing = [
            row.get("name")
            for row in (source, target)
            if row.get("name") and norm(row["name"]) not in content
        ]
        if missing:
            reasons.append("name_not_in_chunk")
        if parts and not reasons:
            quote = "".join(parts)
            if any(
                row.get("name") and norm(row["name"]) not in quote
                for row in (source, target)
            ):
                reasons.append("name_not_in_quote")
        key = relation_key(mentions, relation)
        sampled = not reasons and sample > 0 and int(key[:4], 16) % 100 < sample
        if not reasons and not sampled:
            continue
        items.append(
            {
                "id": key,
                "chunk_id": relation["chunk_id"],
                "position": chunk.get("position"),
                "source": source.get("name"),
                "target": target.get("name"),
                "category": relation.get("category"),
                "description": relation.get("description"),
                "evidence": relation.get("evidence"),
                "reasons": reasons or ["sampled"],
                "excerpt": (chunk.get("content") or "")[:2000],
            }
        )
    return items


def scan_type(plan, chunks, params, models, schema=None):
    by_chunk = {chunk["chunk_id"]: chunk for chunk in chunks}
    allowed = set(type_names(schema)) if schema else None
    groups = {}
    for mention in plan["mentions"]:
        groups.setdefault(name_key(mention["canonical"]), []).append(mention)
    items = []
    for key, rows in groups.items():
        types = sorted({row["type"] for row in rows})
        unknown = [
            kind for kind in types if allowed is not None and kind not in allowed
        ]
        if len(types) < 2 and not unknown:
            continue
        items.append(
            {
                "id": short_id("type", key),
                "name_key": key,
                "names": sorted({row["canonical"] for row in rows}),
                "unknown": unknown,
                "types": [
                    {
                        "type": kind,
                        "count": sum(row["type"] == kind for row in rows),
                        "samples": [
                            {
                                "chunk_id": row["chunk_id"],
                                "position": (by_chunk.get(row["chunk_id"]) or {}).get(
                                    "position"
                                ),
                                "name": row["name"],
                                "description": row.get("description"),
                                "excerpt": excerpt(
                                    (by_chunk.get(row["chunk_id"]) or {}).get(
                                        "content"
                                    ),
                                    row["name"],
                                    300,
                                ),
                            }
                            for row in [r for r in rows if r["type"] == kind][:3]
                        ],
                    }
                    for kind in types
                ],
            }
        )
    return items


def mention_text(row, chunk):
    sentence = excerpt(chunk.get("content"), row["name"], 120)
    return f"{row['name']}（{row['type']}）：{row.get('description') or ''}；{sentence}"


def two_groups(matrix):
    """平均连接聚成两堆，返回 (两堆的下标, 两堆之间的平均相似度)。"""
    clusters = [[index] for index in range(len(matrix))]
    while len(clusters) > 2:
        best = None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                score = float(matrix[numpy.ix_(clusters[i], clusters[j])].mean())
                if best is None or score > best[0]:
                    best = (score, i, j)
        _, i, j = best
        clusters[i] = clusters[i] + clusters[j]
        del clusters[j]
    between = float(matrix[numpy.ix_(clusters[0], clusters[1])].mean())
    return sorted(clusters, key=len, reverse=True), between


def scan_split(plan, chunks, params, models):
    by_chunk = {chunk["chunk_id"]: chunk for chunk in chunks}
    entities = {}
    for mention in plan["mentions"]:
        entities.setdefault(mention["entity_id"], []).append(mention)
    names = {item["id"]: item for item in plan["entities"]}
    candidates = []
    texts = []
    for entity_id, rows in entities.items():
        seen, unique = set(), []
        for row in rows:
            key = (row["chunk_id"], row["name"])
            if key not in seen:
                seen.add(key)
                unique.append(row)
        if len(unique) < 2 or len({row["chunk_id"] for row in unique}) < 2:
            continue
        unique = unique[:SPLIT_MAX_MENTIONS]
        candidates.append((entity_id, unique, len(texts)))
        texts.extend(
            mention_text(row, by_chunk.get(row["chunk_id"]) or {}) for row in unique
        )
    if not candidates:
        return []
    embed = getattr(models, "embed", None) if models else None
    if embed is None:
        return []
    vectors = numpy.asarray(embed(texts), dtype=numpy.float32)
    vectors /= numpy.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9
    items = []
    for entity_id, rows, start in candidates:
        block = vectors[start : start + len(rows)]
        matrix = block @ block.T
        groups, between = two_groups(matrix)
        if between >= SPLIT_MAX_SIMILARITY:
            continue
        entity = names.get(entity_id) or {}
        first = rows[0]
        items.append(
            {
                "id": short_id("split", name_key(first["canonical"]), first["type"]),
                "name_key": name_key(first["canonical"]),
                "name": entity.get("name") or first["canonical"],
                "type": first["type"],
                "similarity": round(between, 3),
                "mentions": [
                    {
                        "key": f"{row['chunk_id']}|{row['name']}",
                        "chunk_id": row["chunk_id"],
                        "position": (by_chunk.get(row["chunk_id"]) or {}).get(
                            "position"
                        ),
                        "name": row["name"],
                        "description": row.get("description"),
                        "excerpt": excerpt(
                            (by_chunk.get(row["chunk_id"]) or {}).get("content"),
                            row["name"],
                            300,
                        ),
                    }
                    for row in rows
                ],
                "proposal": [
                    [
                        f"{rows[index]['chunk_id']}|{rows[index]['name']}"
                        for index in group
                    ]
                    for group in groups
                ],
            }
        )
    return items


# ---------- AI 判断 ----------


def parse_json(text):
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        raise ValueError("模型没有返回 JSON")
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON 解析失败：{error.msg}") from None
    if not isinstance(value, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    return value


def user_glean(item, chunk, schema, plan):
    existing = [
        {"name": row["name"], "type": row["type"]}
        for row in plan["mentions"]
        if row["chunk_id"] == item["chunk_id"]
    ]
    mentions = {row["id"]: row for row in plan["mentions"]}
    relations = [
        {
            "source": (mentions.get(row["source_mention_id"]) or {}).get("name"),
            "target": (mentions.get(row["target_mention_id"]) or {}).get("name"),
            "description": row.get("description"),
        }
        for row in plan["relations"]
        if row["chunk_id"] == item["chunk_id"]
    ]
    message = extract.build_messages(schema, chunk)[1]["content"]
    return (
        message
        + "\n<extracted>\n"
        + json.dumps({"entities": existing, "relations": relations}, ensure_ascii=False)
        + "\n</extracted>"
    )


def glean_key(text):
    return norm(text).strip("《》「」“”\"'")


# 补抽结果先由程序过滤，模型给的不直接当建议：
# 名字在这一片原文里找不到的（模型自己概括的词、只在上下文说明里出现的）去掉；
# 可能是已有实体另一种写法的（「巴菲特」之于已有的「沃伦·巴菲特」）不去掉，标上 same_as 给人判断；
# 关系的原文引用在这一片里找不到、或这两个实体之间已经有关系的去掉。去掉的记在 dropped 里给人看。
def decide_glean(text, item, schema, plan, chunk=None):
    value = parse_json(text)
    content = norm((chunk or {}).get("content") or item.get("excerpt"))
    rows = [row for row in plan["mentions"] if row["chunk_id"] == item["chunk_id"]]
    existing = [
        {
            "name": row["name"],
            "canonical": row["canonical"],
            "type": row["type"],
            "description": row.get("description") or "",
        }
        for row in rows
    ]
    known = {row["name"] for row in existing}
    keys = {}
    for row in existing:
        for name in (row["name"], row["canonical"]):
            if glean_key(name):
                keys.setdefault(glean_key(name), row["name"])
    dropped, similar, fresh = [], {}, []
    for row in value.get("entities") or []:
        if not isinstance(row, dict) or not str(row.get("name") or "").strip():
            continue
        name = str(row["name"]).strip()
        if name in known:
            continue
        key = glean_key(name)
        if not key or key not in content:
            dropped.append({"kind": "entity", "name": name, "reason": "原文里找不到"})
            continue
        # 新名字是已有名字的一部分：可能是同一个的简写，只标出来（新名字更长的不算，「股市大跌」不是「股市」）。
        # 只比字面，会误标（已有「苹果股票」时补「苹果」），所以不自动去掉。
        same = next(
            (keys[other] for other in keys if len(key) >= 2 and key in other), None
        )
        if same:
            similar[name] = same
        fresh.append(row)
    names = known | {str(row["name"]).strip() for row in fresh}
    mentions = {row["id"]: row for row in plan["mentions"]}
    pairs = {
        frozenset(
            (
                (mentions.get(row["source_mention_id"]) or {}).get("name"),
                (mentions.get(row["target_mention_id"]) or {}).get("name"),
            )
        )
        for row in plan["relations"]
        if row["chunk_id"] == item["chunk_id"]
    }
    relations = []
    for row in value.get("relations") or []:
        if not isinstance(row, dict):
            continue
        source, target = row.get("source"), row.get("target")
        label = f"{source} → {target}"
        parts = [norm(part) for part in str(row.get("evidence") or "").split("||")]
        parts = [part for part in parts if part]
        if source not in names or target not in names:
            reason = "起点或终点不是这一片的实体"
        elif frozenset((source, target)) in pairs:
            reason = "这两个实体之间已经有关系"
        elif not parts or not all(part in content for part in parts):
            reason = "原文引用在这一片里找不到"
        else:
            relations.append({**row, "source": source, "target": target})
            pairs.add(frozenset((source, target)))
            continue
        dropped.append({"kind": "relation", "name": label, "reason": reason})
    combined = {"entities": existing + fresh, "relations": relations}
    parsed = extract.parse_output(json.dumps(combined, ensure_ascii=False), schema)
    entities = [
        {**row, "same_as": similar[row["name"]]} if row["name"] in similar else row
        for row in parsed["entities"]
        if row["name"] not in known
    ]
    return {
        "entities": entities,
        "relations": parsed["relations"],
        "dropped": dropped[:50],
        "dropped_count": len(dropped),
        "suggest": bool(entities or parsed["relations"]),
    }


def user_relation(item, chunk, schema, plan):
    return json.dumps(
        {
            "chunk": (chunk or {}).get("content") or item["excerpt"],
            "relation": {
                key: item[key]
                for key in ("source", "target", "category", "description", "evidence")
            },
        },
        ensure_ascii=False,
    )


def decide_relation(text, item, schema, plan, chunk=None):
    value = parse_json(text)
    verdict = value.get("verdict")
    if verdict not in ("supported", "partial", "unsupported"):
        raise ValueError("verdict 必须是 supported、partial 或 unsupported")
    return {
        "verdict": verdict,
        "reason": str(value.get("reason") or "")[:500],
        # 建议删除：原文不支持
        "suggest": verdict == "unsupported",
    }


def user_type(item, chunk, schema, plan):
    return json.dumps(
        {
            "types": type_names(schema),
            "entity": {
                "names": item["names"],
                "types": [
                    {key: row[key] for key in ("type", "count", "samples")}
                    for row in item["types"]
                ],
            },
        },
        ensure_ascii=False,
    )


def decide_type(text, item, schema, plan, chunk=None):
    value = parse_json(text)
    kind = value.get("type")
    if kind is not None and kind not in type_names(schema):
        raise ValueError(f"type 不在清单里：{kind}")
    return {
        "type": kind,
        "reason": str(value.get("reason") or "")[:500],
        # 不同的东西碰巧同名（type 为 null）：不改，交给拆分
        "suggest": kind is not None,
    }


def user_split(item, chunk, schema, plan):
    return json.dumps(
        {
            "entity": {"name": item["name"], "type": item["type"]},
            "mentions": [
                {
                    "id": f"m{index + 1}",
                    "name": row["name"],
                    "description": row["description"],
                    "text": row["excerpt"],
                }
                for index, row in enumerate(item["mentions"])
            ],
        },
        ensure_ascii=False,
    )


def decide_split(text, item, schema, plan, chunk=None):
    value = parse_json(text)
    codes = {f"m{index + 1}": row["key"] for index, row in enumerate(item["mentions"])}
    groups = []
    if value.get("split"):
        used = set()
        for group in value.get("groups") or []:
            ids = [key for key in group.get("ids") or [] if key in codes]
            if not ids or used & set(ids):
                raise ValueError("groups 里的 id 不合法或重复")
            used |= set(ids)
            groups.append(
                {
                    "mentions": [codes[key] for key in ids],
                    "name": str(group.get("name") or "")[:200],
                }
            )
        rest = [key for key in codes if key not in used]
        if rest and groups:
            groups[0]["mentions"] += [codes[key] for key in rest]
        if len(groups) < 2:
            raise ValueError("要拆分时至少分成两组")
        for group in groups[1:]:
            if not group["name"] or name_key(group["name"]) == item["name_key"]:
                raise ValueError("拆出去的组要给一个不同的名字")
    return {
        "split": bool(groups),
        "groups": groups,
        "reason": str(value.get("reason") or "")[:500],
        "suggest": bool(groups),
    }


BUILDERS = {
    "glean": (user_glean, decide_glean),
    "relation": (user_relation, decide_relation),
    "type": (user_type, decide_type),
    "split": (user_split, decide_split),
}


def judge(step, models, item, chunk, schema, plan, system_prompt):
    user, decide = BUILDERS[step]
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user(item, chunk, schema, plan)},
    ]
    result = {
        "item_id": item["id"],
        "prompt": messages,
        "status": "running",
        "raw_output": None,
        "input_tokens": None,
        "output_tokens": None,
    }
    started = time.monotonic()
    try:
        raw, text, incoming, outgoing, finish = extract.call_model(models, messages)
        result.update(raw_output=raw, input_tokens=incoming, output_tokens=outgoing)
        if finish == "length":
            raise ValueError("模型输出被截断")
        result.update(
            decision=decide(text, item, schema, plan, chunk), status="completed"
        )
    except Exception as error:
        result.update(status="failed", error=str(error)[:1000])
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


# ---------- 任务 ----------


def scan_items(step, plan, chunks, params, models, schema):
    if step == "glean":
        return scan_glean(plan, chunks, params, models)
    if step == "relation":
        return scan_relation(plan, chunks, params, models)
    if step == "type":
        return scan_type(plan, chunks, params, models, schema)
    return scan_split(plan, chunks, params, models)


def run_job(store, models, build_id, step):
    build = graph_build.get_build(store.engine, build_id)
    value = report(store.engine, build, step) if build else None
    if (
        build is None
        or build["status"] not in ("completed", "partial")
        or (value or {}).get("status") not in ("queued", "running")
    ):
        return
    try:
        run(store, models, build, step, value)
    except graph_build.BuildStopped:
        pass
    except Exception as error:
        current = report(store.engine, build, step) or value
        current.update(status="failed", error=str(error)[:1000])
        write(store, build, step, current, "failed", f"检查失败：{str(error)[:300]}")


def save_progress(store, build, step, value, detail, status="running"):
    """检查任务保存进度：锁住建图记录，以库里最新的人工决定为准；被停止或重新开始了就返回 True。"""
    with store.engine.begin() as connection:
        connection.execute(
            select(graph_builds.c.id)
            .where(graph_builds.c.id == build["id"])
            .with_for_update()
        )
        latest = report_in(connection, build, step, judgments=False)
        for key in HUMAN_KEYS:
            if latest and key in latest:
                value[key] = latest[key]
        if latest is None or latest.get("status") not in ("queued", "running"):
            if latest and latest.get("signature") in (None, value.get("signature")):
                value["status"] = latest["status"]
                save_in(
                    connection, build, step, value, "pending", "已停止，可以继续检查"
                )
            return True
        save_in(connection, build, step, value, status, detail)
    return False


def run(store, models, build, step, value):
    inputs = graph_build.build_inputs(store.engine, build["id"])
    schema = inputs["schema_snapshot"]
    chunks = graph_build.chunk_rows(store.engine, build["document_id"])
    by_chunk = {chunk["chunk_id"]: chunk for chunk in chunks}
    rows = graph_build.extraction_rows(store.engine, build["id"])
    with store.engine.connect() as connection:
        plan = plan_for(connection, build, rows, applied_of(store.engine, build), step)
    started = time.monotonic()
    params = value.get("params") or {}
    run_models = (
        graph_build.models_for(store, models, {**build, **(params.get("llm") or {})})
        if params.get("llm")
        else graph_build.models_for(store, models, build)
    )
    items = scan_items(step, plan, chunks, params, run_models, schema)
    signature = hashlib.sha256(
        json.dumps([step, items, params], ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    if value.get("signature") != signature:
        old = value.get("judgments") or {}
        ids = {item["id"] for item in items}
        snapshot = prompts.compose(PROMPTS[step])
        version, _ = prompts.current(PROMPTS[step])
        value.update(
            signature=signature,
            items=items,
            scan={
                "count": len(items),
                "duration_ms": round((time.monotonic() - started) * 1000),
            },
            # 同一项（编号相同）之前判断过就沿用
            judgments={key: row for key, row in old.items() if key in ids},
            system_prompt=snapshot,
            prompt_tag=f"{PROMPTS[step]}@{prompts.version_label(version)}",
            started=now(),
        )
    value.setdefault("judgments", {})
    value["stale"] = False
    todo = [
        item
        for item in value["items"]
        if (value["judgments"].get(item["id"]) or {}).get("status") != "completed"
    ]
    total = len(value["items"])
    if value.get("phase") == "scan":
        value["status"] = "scanned" if todo else "ready"
        save_progress(
            store,
            build,
            step,
            value,
            f"找出 {total} 项可疑，{len(todo)} 项要让 AI 判断（约 {len(todo)} 次调用），等确认"
            if todo
            else f"找出 {total} 项可疑"
            if total
            else "没有发现可疑项",
            "pending" if todo else "completed",
        )
        if not total:
            auto_next(store, build, step)
        return
    value["status"] = "running"
    for item in todo[:BATCH]:
        latest = report(store.engine, build, step, judgments=False)
        if (latest or {}).get("status") not in ("queued", "running"):
            raise graph_build.BuildStopped()
        result = judge(
            step,
            run_models,
            item,
            by_chunk.get(item.get("chunk_id")),
            schema,
            plan,
            value["system_prompt"],
        )
        value["judgments"][item["id"]] = result
        done = sum(
            row.get("status") != "running" for row in value["judgments"].values()
        )
        if save_progress(store, build, step, value, f"AI 判断：{done}/{total}"):
            raise graph_build.BuildStopped()
    if len(todo) > BATCH:
        graph_build.enqueue(store, build["id"], f"check:{step}")
        return
    value["status"] = "ready"
    save_progress(store, build, step, value, f"AI 判断完成：{total} 项", "completed")
    if not total:
        auto_next(store, build, step)


# ---------- 人的操作 ----------


def load(store, build_id, step, states=None):
    build = graph_build.get_build(store.engine, build_id)
    if build is None:
        raise CheckError("建图记录不存在")
    value = report(store.engine, build, step)
    if states is not None and (value or {}).get("status") not in states:
        raise CheckError("检查还没到这一步，或正在进行，请稍后再试")
    return build, value


def start(store, build_id, step, params, username, phase="scan"):
    build, value = load(store, build_id, step)
    if (value or {}).get("status") in ("queued", "running", "rewriting"):
        raise CheckError("这一步正在检查，不能重复开始")
    if build["status"] not in ("completed", "partial"):
        raise CheckError("建图完成后才能检查")
    kept = {key: value[key] for key in ("applied",) if value and key in value}
    # 参数没变、之前判断过：沿用判断和决定，找完可疑项后判断过的不再调用模型。
    if value and value.get("params") == params:
        kept.update(
            {
                key: value[key]
                for key in ("judgments", "decisions", "signature", "items")
                if key in value
            }
        )
    fresh = {
        "build_id": build_id,
        "step": step,
        "status": "queued",
        "phase": phase,
        "params": params,
        "started_by": username,
        # 参数变了不沿用判断：显式清空（报告里没有 judgments 键表示判断不变）。
        "judgments": {},
        **kept,
    }
    write(store, build, step, fresh, "pending", "排队找可疑项（不调用模型）")
    graph_build.enqueue(store, build_id, f"check:{step}")
    return fresh


def judge_now(store, build_id, step):
    build, _ = load(store, build_id, step, ("scanned", "stopped"))
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        value.update(status="queued", phase="judge", started=now())
        save_in(connection, build, step, value, "pending", "排队让 AI 判断")
    graph_build.enqueue(store, build_id, f"check:{step}")
    return value


def stop(store, build_id, step):
    build, _ = load(store, build_id, step, ("queued", "running"))
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        if (value or {}).get("status") not in ("queued", "running"):
            raise CheckError("检查没有在进行")
        value["status"] = "stopped" if value.get("items") is not None else "idle"
        save_in(connection, build, step, value, "pending", "已停止，可以继续检查")
    return value


def retry_failed(store, build_id, step):
    build, value = load(store, build_id, step, ("ready", "stopped"))
    failed = [
        key
        for key, row in (value.get("judgments") or {}).items()
        if row.get("status") == "failed"
    ]
    if not failed:
        raise CheckError("没有判断失败的项")
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        for key in failed:
            value["judgments"].pop(key, None)
        value.update(status="queued", phase="judge")
        save_in(connection, build, step, value, "pending", f"排队重试 {len(failed)} 项")
    graph_build.enqueue(store, build_id, f"check:{step}")
    return value


# 全部重新判断：清掉这一步所有 AI 判断和还没写入的人工决定，用当前提示词、当前过滤规则重新判断每一项。
# 已经写入的（applied）不动。signature 清空，任务会重新找可疑项、重新记下提示词快照。
def rejudge(store, build_id, step):
    build, _ = load(store, build_id, step, ("scanned", "ready", "stopped"))
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        value.update(
            judgments={},
            decisions={},
            signature=None,
            status="queued",
            phase="judge",
            started=now(),
        )
        save_in(connection, build, step, value, "pending", "排队全部重新判断")
    graph_build.enqueue(store, build_id, f"check:{step}")
    return value


DECIDE_STATES = ("ready", "stopped", "scanned", "queued", "running")


def decide(store, build_id, step, item_ids, decision, edit, username):
    build, value = load(store, build_id, step, DECIDE_STATES)
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        known = {item["id"] for item in value.get("items") or []}
        if not item_ids or not set(item_ids) <= known:
            raise CheckError("包含无效的项")
        decisions = value.setdefault("decisions", {})
        for item_id in item_ids:
            if decision is None:
                decisions.pop(item_id, None)
            else:
                decisions[item_id] = {
                    "decision": decision,
                    "by": username,
                    "at": now(),
                    **({"edit": edit} if edit else {}),
                }
        save_in(
            connection,
            build,
            step,
            value,
            "completed" if value["status"] == "ready" else "pending",
            progress_text(value),
        )
    return value


def progress_text(value):
    items = value.get("items") or []
    decisions = value.get("decisions") or {}
    accepted = sum(row["decision"] == "accept" for row in decisions.values())
    rejected = sum(row["decision"] == "reject" for row in decisions.values())
    return (
        f"{len(items)} 项可疑：采纳 {accepted}，不采纳 {rejected}，"
        f"待处理 {len(items) - accepted - rejected}"
    )


# 采纳的决定变成这一步要写入的内容（applied.items）。
def accepted_items(step, value):
    items = {item["id"]: item for item in value.get("items") or []}
    judgments = value.get("judgments") or {}
    result = {} if step == "glean" else []
    for item_id, row in (value.get("decisions") or {}).items():
        if row["decision"] != "accept" or item_id not in items:
            continue
        item = items[item_id]
        decision = (judgments.get(item_id) or {}).get("decision") or {}
        edit = row.get("edit") or {}
        if step == "glean":
            result[item["chunk_id"]] = {
                "entities": decision.get("entities") or [],
                "relations": decision.get("relations") or [],
            }
        elif step == "relation":
            result.append(item_id)
        elif step == "type":
            kind = edit.get("type") or decision.get("type")
            if kind:
                result.append({"name_key": item["name_key"], "type": kind})
        else:
            groups = copy.deepcopy(edit.get("groups") or decision.get("groups") or [])
            if len(groups) >= 2:
                result.append(
                    {
                        "name_key": item["name_key"],
                        "type": item["type"],
                        "groups": groups,
                    }
                )
    return result


def write_step_result(store, build_id, step, username):
    build, value = load(store, build_id, step, ("ready", "stopped", "scanned"))
    items = accepted_items(step, value)
    previous = (value.get("applied") or {}).get("items")
    if not items and not previous:
        raise CheckError("还没有采纳任何建议")
    with store.engine.begin() as connection:
        lock(connection, build)
        value = report_in(connection, build, step)
        # ids：这次写入时采纳的是哪几项，用来判断之后采纳有没有变（变了就是「待写入」）。
        value["applied"] = {
            "items": items,
            "ids": accepted_ids(value),
            "by": username,
            "at": now(),
        }
        value["status"] = "rewriting"
        save_in(
            connection, build, step, value, "running", "已提交：写入图谱，存成新版本"
        )
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build_id)
            .values(status="queued", updated=now(), error=None)
        )
    graph_build.enqueue(store, build_id)
    return value


def skip(store, build_id, step, username):
    build, value = load(store, build_id, step)
    if (value or {}).get("status") in ("queued", "running", "rewriting"):
        raise CheckError("这一步正在进行，不能跳过")
    value = {
        **(value or {"build_id": build_id, "step": step}),
        "status": "skipped",
        "skipped_by": username,
    }
    write(store, build, step, value, "completed", "已跳过")
    auto_next(store, build, step)
    return value


# 开了自动检查（GRAPH_REVIEW_AUTO=1）：一步写入、跳过或没有可疑项后，自动开始下一步的找可疑项和 AI 判断。
def auto_next(store, build, step):
    if not graph_build.REVIEW_AUTO:
        return
    index = ORDER.index(step) + 1
    if index >= len(ORDER):
        return
    following = ORDER[index]
    if following == "merge":
        graph_build.auto_review(
            store, build, graph_build.review_report(store.engine, build)
        )
        return
    if (report(store.engine, build, following, judgments=False) or {}).get(
        "status"
    ) in (
        "queued",
        "running",
        "rewriting",
    ):
        return
    start(store, build["id"], following, {}, "system", phase="judge")


# 写入图谱之后：正在写入的步骤回到可以决定；依赖它的后续步骤标成「需要重新检查」。
def after_write(store, build, merge_report=None):
    current = reports(store.engine, build, judgments=False)
    written = [
        step
        for step, value in current.items()
        if (value or {}).get("status") == "rewriting"
    ]
    if merge_report and merge_report.get("status") == "rewriting":
        written.append("merge")
    stale = {after for step in written for after in DEPENDS[step]}
    for step, value in current.items():
        if not value:
            continue
        changed = False
        if step in written:
            value["status"] = "ready"
            changed = True
        if step in stale and value.get("status") not in ("idle", "skipped", None):
            value["stale"] = True
            changed = True
        if changed:
            write(store, build, step, value, "completed", progress_text(value))
    for step in written:
        if step != "merge":
            auto_next(store, build, step)
    return "merge" in stale


def checking(engine, build):
    return any(
        (value or {}).get("status") == "rewriting"
        for value in reports(engine, build, judgments=False).values()
    )


def busy(engine, build):
    return any(
        (value or {}).get("status") in ("queued", "running", "rewriting")
        for value in reports(engine, build, judgments=False).values()
    )


# 步骤条要的概要：状态、可疑项数、判断进度、待处理数、是否需要重新检查。
# 采纳了的项（编号排好序）。
def accepted_ids(value):
    ids = {item["id"] for item in value.get("items") or []}
    return sorted(
        key
        for key, row in (value.get("decisions") or {}).items()
        if key in ids and (row or {}).get("decision") == "accept"
    )


# 采纳的和上次写入的不一样：还没写入。老的写入记录没记 ids，有写入就当作已经写入了现在的采纳。
def unwritten(value):
    accepted = accepted_ids(value)
    applied = value.get("applied") or {}
    written = applied.get("ids")
    if written is None:
        written = accepted if applied.get("items") else []
    return accepted != sorted(written)


def summary(value):
    if not value:
        return {"status": "idle"}
    items = value.get("items") or []
    judgments = value.get("judgments") or {}
    decisions = value.get("decisions") or {}
    suggested = [
        item["id"]
        for item in items
        if ((judgments.get(item["id"]) or {}).get("decision") or {}).get("suggest")
    ]
    return {
        "status": value.get("status"),
        "stale": bool(value.get("stale")),
        "count": len(items),
        "judged": sum(row.get("status") != "running" for row in judgments.values()),
        "failed": sum(row.get("status") == "failed" for row in judgments.values()),
        "pending": sum(1 for key in suggested if key not in decisions),
        "applied": bool((value.get("applied") or {}).get("items")),
        "accepted": len(accepted_ids(value)),
        "unwritten": unwritten(value),
        "started": value.get("started"),
        "error": value.get("error"),
    }


LABELS = {"glean": "补抽", "relation": "关系核对", "type": "类型核对", "split": "拆分"}


# 正在写入的检查步骤，版本摘要里写「这次写入了什么」。
def writing(engine, build):
    result = []
    for step, value in reports(engine, build).items():
        if (value or {}).get("status") != "rewriting":
            continue
        items = (value.get("applied") or {}).get("items") or []
        result.append(f"{LABELS[step]}：写入 {len(items)} 项")
    return result


# 这次写入是谁确认的。
def writer(engine, build, merge_report=None):
    if merge_report and merge_report.get("status") == "rewriting":
        return merge_report["applied"]["by"]
    for value in reports(engine, build).values():
        if (value or {}).get("status") == "rewriting":
            return (value.get("applied") or {}).get("by") or build["created_by"]
    return build["created_by"]
