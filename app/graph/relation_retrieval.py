"""关系候选融合、分组保底及统一重排。"""

import math


def hybrid_ranking(dense, keyword, minimum, rrf_k=60):
    rows = {}
    for method, hits in (("vector", dense), ("keyword", keyword)):
        for rank, hit in enumerate(hits, 1):
            if method == "vector" and hit["score"] < minimum:
                continue
            item = rows.setdefault(
                hit["id"], {"relation_id": hit["id"], "fusion_score": 0.0}
            )
            item[method + "_rank"] = rank
            item[method + "_score"] = hit["score"]
            item["fusion_score"] += 1 / (rrf_k + rank)
    ranked = sorted(
        rows.values(), key=lambda item: (-item["fusion_score"], item["relation_id"])
    )
    for rank, item in enumerate(ranked, 1):
        item["fusion_rank"] = rank
    return ranked


def select_candidates(groups, capacity, entity_quota, global_quota, rrf_k=60):
    """先按轮次分配保底（总预算不足时也公平），重复关系只占一席。"""
    merged = {}
    for group, rows in groups.items():
        for rank, row in enumerate(rows, 1):
            item = merged.setdefault(
                row["relation_id"],
                {
                    "relation_id": row["relation_id"],
                    "fusion_score": 0.0,
                    "origins": [],
                    "guaranteed_by": [],
                    "retrieval_ranks": [],
                },
            )
            item["fusion_score"] += 1 / (rrf_k + rank)
            item["origins"].append(group)
            item["retrieval_ranks"].append({"origin": group, **row})
    ranked = sorted(
        merged.values(), key=lambda item: (-item["fusion_score"], item["relation_id"])
    )
    for rank, item in enumerate(ranked, 1):
        item["fusion_rank"] = rank
    selected = set()
    for index in range(max(entity_quota, global_quota)):
        for group, rows in groups.items():
            quota = global_quota if group == "global" else entity_quota
            if index >= quota or index >= len(rows):
                continue
            item = merged[rows[index]["relation_id"]]
            if item["relation_id"] in selected or len(selected) < capacity:
                selected.add(item["relation_id"])
                item["guaranteed_by"].append(group)
    for item in ranked:
        if len(selected) >= capacity:
            break
        selected.add(item["relation_id"])
    for item in ranked:
        item["in_pool"] = item["relation_id"] in selected
        item["selection"] = (
            "保底入选"
            if item["guaranteed_by"]
            else "公共竞争"
            if item["in_pool"]
            else "超过关系重排候选上限"
        )
    return ranked


def rerank_candidates(
    models, question, candidates, details, limit, minimum, grouping=False
):
    pool = [item for item in candidates if item["in_pool"]]
    error = None
    if pool:
        texts = [relation_text(details[item["relation_id"]]) for item in pool]
        try:
            scores = models.rerank(question, texts)
            if scores is None:
                raise ValueError("关系重排未启用或模型不可用")
            if len(scores) != len(pool) or any(
                not math.isfinite(float(score)) for score in scores
            ):
                raise ValueError("关系重排返回的分数数量不符或分数无效")
            for item, score in zip(pool, scores):
                item["rerank_score"] = float(score)
            pool.sort(key=lambda item: (-item["rerank_score"], item["fusion_rank"]))
        except Exception as exc:
            error = str(exc)[:500]
            for item in pool:
                item.pop("rerank_score", None)
    eligible = []
    for rank, item in enumerate(pool, 1):
        item["rerank_rank"] = rank if error is None else None
        if error is None and item["rerank_score"] < minimum:
            item.update(kept=False, reason="低于关系重排分数线")
        else:
            eligible.append(item)
    if grouping and error is None:
        groups = {}
        for item in eligible:
            row = details[item["relation_id"]]
            # 缺少端点身份时不把未知实体当成同一个实体。
            key = (
                row.get("source_entity_id") or item["relation_id"],
                row["category"],
                row.get("target_entity_id") or item["relation_id"],
            )
            group = groups.setdefault(key, [])
            group.append(item)
            item["group_key"] = list(key)
            item["group_round"] = len(group)
        # 同轮仍沿用重排顺序，不改变重排分数和原排名。
        eligible.sort(key=lambda item: (item["group_round"], item["rerank_rank"]))
    for rank, item in enumerate(eligible, 1):
        if grouping and error is None:
            item["selection_rank"] = rank
        item.update(
            kept=rank <= limit,
            reason=None if rank <= limit else "超过关系保留上限",
        )
    for item in candidates:
        if not item["in_pool"]:
            item.update(kept=False, reason="超过关系重排候选上限")
    return error


def relation_text(row):
    return f"{row['source']} → {row['target']}（{row['category']}）：{row['description'] or ''}"
