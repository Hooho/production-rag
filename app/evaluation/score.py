"""每道题的得分（满分 100），固定流程和 Agent 同一套规则，调参评测和专项都用。

能回答的题看拿到了几条证据：
  全部找到       100
  找到一部分     找到几条 / 一共几条 × 100，最高 90（没拿全就到不了满分）
  一条都没找到   扣分：每条证据扣 10，最多扣 50（证据越多的题完全找偏，扣得越多）
无法回答的题：一段资料都没拿到 100；拿到了资料扣 20（模型可能据此硬凑答案）。
总分是所有题得分的平均；另外按全中 / 过半 / 少量 / 没找到分档计数，只用来看分数低在哪，不参与算分。
"""

FULL = 100
PARTIAL_CAP = 90
MISS_PER_EVIDENCE = 10
MISS_FLOOR = -50
LEAK_PENALTY = -20
BANDS = ("full", "half", "some", "none")


# 一道题的得分；能回答的题没有证据（没法判断）时返回 None。
def question_score(answerable, found, total, returned=0):
    if not answerable:
        return FULL if not returned else LEAK_PENALTY
    if not total:
        return None
    if found >= total:
        return FULL
    if found > 0:
        return round(min(PARTIAL_CAP, found / total * 100), 1)
    return max(MISS_FLOOR, -MISS_PER_EVIDENCE * total)


# 能回答的题分到哪一档：全中、过半（一半及以上）、少量（至少一条）、没找到。
def score_band(found, total):
    if not total:
        return None
    if found >= total:
        return "full"
    if found * 2 >= total:
        return "half"
    return "some" if found > 0 else "none"


# items：(answerable, found, total, returned) 的列表。返回 {score, score_bands}，没有可算的题时 score 是 None。
def summarize_scores(items):
    scores = []
    bands = dict.fromkeys(BANDS, 0)
    for answerable, found, total, returned in items:
        value = question_score(answerable, found, total, returned)
        if value is None:
            continue
        scores.append(value)
        if answerable:
            bands[score_band(found, total)] += 1
    return {"score": round(sum(scores) / len(scores), 1) if scores else None, "score_bands": bands}


# 固定流程一道调参题：按最后交给模型的资料算，被充分性判断清空算一条都没拿到。
def fixed_item(row):
    total = row.get("evidence_count") or len(row.get("evidence") or [])
    if row.get("cleared"):
        return row["answerable"], 0, total, 0
    found = row.get("given_hits")
    if found is None:
        found = round((row.get("given_recall") if row.get("given_recall") is not None else row["stages"]["final"]["recall"] or 0) * total)
    return row["answerable"], found, total, row.get("returned", 0)


# Agent 一道题：按它拿到的全部资料算。
def agent_item(answerable, agent):
    evidence = agent.get("evidence") or []
    found = agent.get("found_count")
    if found is None:
        found = sum(1 for item in evidence if item.get("found"))
    return answerable, found, len(evidence), agent.get("returned", 0)
