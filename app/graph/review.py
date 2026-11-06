"""Document-local review suggestions. Applying suggestions requires explicit approval."""

import hashlib
import json
import os
import time
import uuid

import numpy

from sqlalchemy import select

from .. import prompts
from ..mysql.tables import graph_entities
from .extract import call_model
from .resolve import merge_key as resolve_key, normalize
from .schemas import now, type_names

VERSION = 2
# 找候选（分组，不补查）：名字相同算相似度 1；其余用实体向量的余弦相似度。
# 从最像的两个开始往组里合并，组里任意两个都要 ≥ MIN_SIMILARITY 才能放在一起（不会串联），每组最多 MAX_GROUP_SIZE 个；
# 每个实体只进一组，只考虑它最像的 TOP_K 个。最多 MAX_GROUPS 组，按组内最高相似度从高到低保留。
TOP_K = int(os.getenv("GRAPH_REVIEW_TOP_K", "5"))
MIN_SIMILARITY = float(os.getenv("GRAPH_REVIEW_MIN_SIMILARITY", "0.80"))
MAX_GROUP_SIZE = int(os.getenv("GRAPH_REVIEW_MAX_GROUP_SIZE", "6"))
MAX_GROUPS = int(os.getenv("GRAPH_REVIEW_MAX_GROUPS", "300"))
TEXT_FORMAT = "名字 / 别名（类型）：描述"
# 判断用的提示词在「提示词管理」里维护（graph_review），每次检查记下实际用的版本。
PROMPT_ID = "graph_review"


def prompt_snapshot():
    version, _ = prompts.current(PROMPT_ID)
    text = prompts.compose(PROMPT_ID)
    return {
        "system_prompt": text,
        "prompt_tag": f"{PROMPT_ID}@{prompts.version_label(version)}",
    }


def inventory(plan, evidence):
    buckets = {}
    for mention in plan["mentions"]:
        item = buckets.setdefault(
            mention["entity_id"],
            {
                "names": set(),
                "types": set(),
                "keys": set(),
                "descriptions": set(),
                "evidence": [],
            },
        )
        item["names"].update((mention["name"], mention["canonical"]))
        item["types"].add(mention["type"])
        item["keys"].add(
            f"{mention['type']}|{normalize(mention['canonical'], mention['type'])}"
        )
        if mention.get("description"):
            item["descriptions"].add(mention["description"])
        text = evidence.get(mention["chunk_id"], "")
        if (
            text
            and len(item["evidence"]) < 2
            and not any(
                row["chunk_id"] == mention["chunk_id"] for row in item["evidence"]
            )
        ):
            item["evidence"].append(
                {"chunk_id": mention["chunk_id"], "text": text[:1800]}
            )
    result, ids = [], {}
    for entity_id, item in buckets.items():
        key = hashlib.sha256(
            json.dumps(sorted(item.pop("keys")), ensure_ascii=False).encode()
        ).hexdigest()
        ids[key] = entity_id
        result.append(
            {
                "id": key,
                "names": sorted(item["names"]),
                "types": sorted(item["types"]),
                "descriptions": sorted(item["descriptions"])[:3],
                "evidence": item["evidence"],
            }
        )
    return sorted(result, key=lambda item: item["id"]), ids


def embed_text(item):
    text = f"{' / '.join(item['names'])}（{'、'.join(item['types'])}）"
    if item["descriptions"]:
        text += "：" + "；".join(item["descriptions"])
    return text


def embedding_info(models):
    mode = getattr(models, "embedding_mode", "demo")
    return {
        "mode": mode,
        "model": "字符二元组哈希" if mode == "demo" else models.embedding_model,
        "semantic": mode != "demo",
    }


def method_info(models):
    return {
        "embedding": embedding_info(models) if models else None,
        "text_format": TEXT_FORMAT,
        "metric": "余弦相似度",
        "grouping": "全连接分组",
        "top_k": TOP_K,
        "min_similarity": MIN_SIMILARITY,
        "max_group_size": MAX_GROUP_SIZE,
        "max_groups": MAX_GROUPS,
    }


def candidates(items, embed=None):
    """返回 (候选组, 统计)。embed 为空时只按名字相同分组。"""
    count = len(items)
    texts = [embed_text(item) for item in items]
    names = [{normalize(name) for name in item["names"]} - {""} for item in items]
    scores = numpy.zeros((count, count), dtype=numpy.float32)
    if embed and count > 1:
        matrix = numpy.asarray(embed(texts), dtype=numpy.float32)
        norms = numpy.linalg.norm(matrix, axis=1, keepdims=True)
        matrix = matrix / numpy.where(norms == 0, 1, norms)
        scores = matrix @ matrix.T
    same = numpy.zeros((count, count), dtype=bool)
    owners = {}
    for index, keys in enumerate(names):
        for key in keys:
            owners.setdefault(key, []).append(index)
    for members in owners.values():
        for a in members:
            for b in members:
                same[a, b] = True
    scores = numpy.where(same, 1.0, scores).astype(numpy.float32)
    numpy.fill_diagonal(scores, -1.0)

    # 候选边：名字相同的全部 + 每个实体最像的 TOP_K 个（≥ 门槛）。
    edges = {}
    for a, b in zip(*numpy.nonzero(numpy.triu(same, 1))):
        edges[(int(a), int(b))] = 1.0
    if embed and count > 1:
        order = numpy.argsort(-scores, axis=1)[:, : min(TOP_K, count - 1)]
        for a in range(count):
            for b in order[a]:
                score = float(scores[a, b])
                if score < MIN_SIMILARITY:
                    break
                edges.setdefault((min(a, int(b)), max(a, int(b))), score)

    # 从最像的开始合并；两组合并的条件：合并后任意两个都 ≥ 门槛，且不超过上限。
    group_of = list(range(count))
    members = {index: [index] for index in range(count)}
    for (a, b), _ in sorted(edges.items(), key=lambda row: (-row[1], row[0])):
        left, right = group_of[a], group_of[b]
        if left == right:
            continue
        joined = members[left] + members[right]
        if len(joined) > MAX_GROUP_SIZE:
            continue
        if scores[numpy.ix_(members[left], members[right])].min() < MIN_SIMILARITY:
            continue
        for index in members[right]:
            group_of[index] = left
        members[left] = sorted(joined)
        del members[right]

    groups = []
    for indexes in members.values():
        if len(indexes) < 2:
            continue
        pairs = [
            [i, j, round(float(scores[a, b]), 4)]
            for i, a in enumerate(indexes)
            for j, b in enumerate(indexes)
            if i < j
        ]
        values = [row[2] for row in pairs]
        same_name = all(same[a, b] for a in indexes for b in indexes)
        groups.append(
            {
                "kind": "same_name" if same_name else "similar",
                "reason": "名字相同"
                if same_name
                else f"语义相似 {min(values):.2f}–{max(values):.2f}",
                "entities": [items[index] for index in indexes],
                "similarity": round(min(values), 4),
                "similarity_max": round(max(values), 4),
                "texts": [texts[index] for index in indexes],
                # 组里两两的相似度：[第几个, 第几个, 分数]；名字相同的记 1。
                "pairs": pairs,
            }
        )
    total = len(groups)
    groups.sort(key=lambda row: (-row["similarity_max"], -row["similarity"]))
    groups = groups[:MAX_GROUPS]
    for index, group in enumerate(groups):
        group["id"] = str(index + 1)
    stats = {
        "same_name": sum(row["kind"] == "same_name" for row in groups),
        "similar": sum(row["kind"] == "similar" for row in groups),
        "total": total,
    }
    return groups, stats


def validate(text, candidate, allowed_types):
    value = json.loads(text)
    if not isinstance(value, dict) or not isinstance(value.get("groups"), list):
        raise ValueError("模型判断格式错误：需要groups数组")
    if not isinstance(value.get("separate_reason", ""), str):
        raise ValueError("模型保持分开的依据必须为文本")
    allowed = {item["id"] for item in candidate["entities"]}
    used = set()
    groups, ignored = [], []
    for group in value["groups"]:
        ids = group.get("ids") if isinstance(group, dict) else None
        if (
            not isinstance(ids, list)
            or not ids
            or not all(isinstance(key, str) for key in ids)
        ):
            raise ValueError("模型合并组格式错误：ids 需要编号列表")
        # 只有一个编号的组：模型想说「它就是它自己」，不是合并建议，忽略（视为不合并）。
        if len(ids) == 1:
            if ids[0] not in allowed:
                raise ValueError(f"模型合并组里有不在这一组的编号：{ids}")
            ignored.append(ids[0])
            continue
        if len(set(ids)) != len(ids) or used.intersection(ids):
            raise ValueError(f"模型合并组里有重复的编号：{ids}")
        if not set(ids) <= allowed:
            raise ValueError(
                f"模型合并组里有不在这一组的编号：{sorted(set(ids) - allowed)}"
            )
        if (
            group.get("type") not in allowed_types
            or not all(
                isinstance(group.get(key), str) and group[key].strip()
                for key in ("name", "reason")
            )
            or len(group["name"]) > 200
        ):
            raise ValueError("模型统一名称、类型或判断依据不合规")
        used.update(ids)
        groups.append(group)
    # 同一个编号既单独列出、又在合并组里：结论矛盾，判为失败。
    if used.intersection(ignored):
        raise ValueError(
            f"模型把同一个编号既单独列出又放进合并组：{sorted(used.intersection(ignored))}"
        )
    value["groups"] = groups
    if ignored:
        value["ignored"] = list(dict.fromkeys(ignored))
    return value


def judge(models, schema, candidate, system_prompt=None):
    # 发给模型的实体用短编号 e1、e2……（原来是 64 位哈希，模型容易抄错或写成组号），返回后再换回真正的 id。
    # 组号只给界面用，不发给模型。
    codes = {
        f"e{index + 1}": item["id"] for index, item in enumerate(candidate["entities"])
    }
    short = {
        "entities": [
            {**item, "id": code} for code, item in zip(codes, candidate["entities"])
        ]
    }
    messages = [
        {
            "role": "system",
            "content": system_prompt
            if system_prompt is not None
            else prompts.compose(PROMPT_ID),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "types": type_names(schema),
                    # 相似度、排名只用于展示，不给模型，免得分数左右判断。
                    "candidate": short,
                },
                ensure_ascii=False,
            ),
        },
    ]
    result = {
        "candidate_id": candidate["id"],
        "prompt": messages,
        "status": "running",
        "raw_output": None,
        "input_tokens": None,
        "output_tokens": None,
    }
    started = time.monotonic()
    try:
        raw, text, incoming, outgoing, finish = call_model(models, messages)
        result.update(raw_output=raw, input_tokens=incoming, output_tokens=outgoing)
        if finish == "length":
            raise ValueError("模型输出被截断")
        decision = validate(text, short, set(type_names(schema)))
        for group in decision["groups"]:
            group["ids"] = [codes[key] for key in group["ids"]]
        if decision.get("ignored"):
            decision["ignored"] = [codes[key] for key in decision["ignored"]]
        result.update(decision=decision, codes=codes, status="completed")
    except Exception as error:
        result.update(status="failed", error=str(error)[:1000])
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


def proposals(report):
    """所有合并建议：模型给的（组号:序号）和人工添加的（m1:0、m2:0……）。"""
    result = {
        f"{row['candidate_id']}:{index}": group
        for row in report.get("judgments") or []
        if row["status"] == "completed"
        for index, group in enumerate(row["decision"]["groups"])
    }
    for item in report.get("manual") or []:
        result[f"{item['id']}:0"] = {
            key: item[key] for key in ("ids", "name", "type", "reason")
        }
    return result


def search_entities(items, query="", ids=None, limit=30):
    """按名字或描述搜实体（人工合并时用）；ids 有值时按编号取。"""
    if ids:
        wanted = set(ids)
        return [item for item in items if item["id"] in wanted]
    keyword = normalize(query)
    if not keyword:
        return []
    hits = []
    for item in items:
        names = [normalize(name) for name in item["names"]]
        if any(keyword in name for name in names):
            rank = 0 if keyword in names else 1
        elif any(keyword in normalize(text) for text in item["descriptions"]):
            rank = 2
        else:
            continue
        hits.append((rank, min(len(name) for name in names), item))
    hits.sort(key=lambda row: (row[0], row[1]))
    return [item for _, _, item in hits[:limit]]


def components(report, approved):
    """把批准的建议按共享实体连起来：A+B、B+C 都批准时，A、B、C 合成一个实体。

    key 取组内字典序最小的建议编号，前端按同样规则算，用来对应人工选的名字。"""
    chosen = {key: group for key, group in proposals(report).items() if key in approved}
    parents = {}

    def root(key):
        parents.setdefault(key, key)
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key

    for group in chosen.values():
        for key in group["ids"][1:]:
            parents[root(key)] = root(group["ids"][0])
    buckets = {}
    for proposal_id, group in chosen.items():
        buckets.setdefault(root(group["ids"][0]), []).append(proposal_id)
    result = []
    for proposal_ids in buckets.values():
        proposal_ids.sort()
        options = []
        for proposal_id in proposal_ids:
            option = {
                "name": chosen[proposal_id]["name"],
                "type": chosen[proposal_id]["type"],
            }
            if option not in options:
                options.append(option)
        result.append(
            {
                "key": proposal_ids[0],
                "proposal_ids": proposal_ids,
                "ids": sorted(
                    {key for pid in proposal_ids for key in chosen[pid]["ids"]}
                ),
                "options": options,
                "reasons": [chosen[pid]["reason"] for pid in proposal_ids],
                # 每条建议各自涉及的实体：写入时用来标出每个名字是哪几条建议带进来的。
                "members": {pid: chosen[pid]["ids"] for pid in proposal_ids},
            }
        )
    return sorted(result, key=lambda item: item["key"])


def resolve_groups(report, approved, resolutions=None):
    """把批准的建议整理成最终要执行的合并结果；连在一起且名字不一致的必须在 resolutions 里选定。"""
    resolutions = resolutions or {}
    groups = []
    for component in components(report, set(approved)):
        choice = component["options"][0]
        if len(component["options"]) > 1:
            choice = resolutions.get(component["key"])
            if not choice or choice not in component["options"]:
                raise ValueError(
                    "连在一起的合并建议名字或类型不一致，请先选定最终名字："
                    + "、".join(item["name"] for item in component["options"])
                )
        groups.append(
            {
                "key": component["key"],
                "proposal_ids": component["proposal_ids"],
                "ids": component["ids"],
                "name": choice["name"],
                "type": choice["type"],
                "reason": "；".join(dict.fromkeys(component["reasons"])),
                "members": component["members"],
            }
        )
    return groups


# 改名：把一组名字的标准名、类型改掉，再按规则合并的身份（类型 + 规范化后的标准名）重新归属。
# 已有同身份的实体（这次写入的方案里，或空间里其他文档已经用着的）就并进去，没有就新建。
# 二次检查的合并、类型纠正、拆分都用它：合并 = 几个实体的名字改成同一个标准名；拆分 = 其中几处改成新名字。
# 只改这份文档里这些名字的归属，不动其他文档。返回 (实体 id, 受影响的名字 id 列表)。
def rename(connection, plan, space, mention_ids, name, entity_type, description=""):
    key = resolve_key(entity_type, name)
    target = (
        next(
            (item["id"] for item in plan["entities"] if item["merge_key"] == key), None
        )
        or connection.execute(
            select(graph_entities.c.id).where(
                graph_entities.c.space == space, graph_entities.c.merge_key == key
            )
        ).scalar_one_or_none()
    )
    if target is None:
        target = str(uuid.uuid4())
        plan["entities"].append(
            {
                "id": target,
                "space": space,
                "name": name[:200],
                "type": entity_type,
                "merge_key": key,
                "description": (description or "")[:500] or None,
                "origin": "extracted",
                "created": now(),
                "updated": now(),
            }
        )
    wanted = set(mention_ids)
    affected = []
    for mention in plan["mentions"]:
        if mention["id"] in wanted:
            mention.update(
                entity_id=target,
                canonical=name,
                type=entity_type,
                resolve_method="review",
            )
            affected.append(mention["id"])
    return target, affected


def apply(connection, plan, build, groups, ids, approved_by):
    """把人工确认过的合并结果应用到这次建图的写入方案上（写图谱前调用）。

    做法是改名：组里实体的名字都改成选定的标准名和类型，再按身份归属（见 rename）。
    groups 来自 resolve_groups；ids 是 inventory 返回的「候选 id → 实体 id」。抽取结果变化后找不到的实体跳过。"""
    records = []
    for group in groups:
        proposal_id = group["key"]
        if any(key not in ids for key in group["ids"]):
            records.append(
                {
                    **{key: value for key, value in group.items() if key != "members"},
                    "id": proposal_id,
                    "status": "skipped",
                    "reason": "抽取结果已变化，找不到其中的实体，未合并",
                }
            )
            continue
        sources = {ids[key] for key in group["ids"]}
        summary = {key: value for key, value in group.items() if key != "members"}
        # 每个实体是哪几条建议带进来的（模型建议「12:0」、人工添加「m1:0」）；
        # 旧的已写入结果没有 members，via 为空，合并记录就按整组的建议来源显示。
        members = group.get("members") or {}
        via = {}
        for pid, keys in members.items():
            for key in keys:
                if key in ids:
                    via.setdefault(ids[key], set()).add(pid)
        chosen = [row for row in plan["mentions"] if row["entity_id"] in sources]
        via_of = {
            row["id"]: sorted(via[row["entity_id"]])
            for row in chosen
            if row["entity_id"] in via
        }
        from_names = {row["name"] for row in chosen}
        type_corrections = sum(row["type"] != group["type"] for row in chosen)
        target, affected = rename(
            connection,
            plan,
            build["space"],
            [row["id"] for row in chosen],
            group["name"],
            group["type"],
            group["reason"],
        )
        for merge in plan["merges"]:
            if merge["mention_id"] in affected:
                merge.update(
                    entity_id=target,
                    method="review",
                    detail={
                        **merge["detail"],
                        "review": {
                            "proposal_id": proposal_id,
                            **summary,
                            "via": via_of.get(merge["mention_id"]),
                        },
                        "approved_by": approved_by,
                    },
                )
        records.append(
            {
                **summary,
                "id": proposal_id,
                "status": "completed",
                "entity_id": target,
                "mention_count": len(affected),
                "from_names": sorted(from_names),
                "type_corrections": type_corrections,
                "relation_count": sum(
                    row["source_mention_id"] in affected
                    or row["target_mention_id"] in affected
                    for row in plan["relations"]
                ),
            }
        )
    used = {item["entity_id"] for item in plan["mentions"]}
    plan["entities"] = [item for item in plan["entities"] if item["id"] in used]
    plan["summary"].update(entity_count=len(used), created_count=len(plan["entities"]))
    plan["summary"]["methods"] = {
        method: sum(item["resolve_method"] == method for item in plan["mentions"])
        for method in {item["resolve_method"] for item in plan["mentions"]}
    }
    return records
