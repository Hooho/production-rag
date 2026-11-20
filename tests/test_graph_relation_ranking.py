from types import SimpleNamespace

from app.graph.relation_retrieval import (
    hybrid_ranking,
    select_candidates,
    rerank_candidates,
)


def rows(prefix, count):
    return [{"relation_id": f"{prefix}{i}"} for i in range(count)]


def test_group_guarantees_and_global_budget():
    groups = {
        "A": rows("a", 400),
        "B": rows("b", 200),
        "C": rows("c", 100),
        "global": rows("g", 300),
    }
    candidates = select_candidates(groups, 100, 5, 10)
    pool = [row for row in candidates if row["in_pool"]]
    assert len(pool) == 100
    for group, quota in (("A", 5), ("B", 5), ("C", 5), ("global", 10)):
        assert sum(group in row["guaranteed_by"] for row in pool) == quota
    # 同一关系跨路径重复不消耗保底席位，总预算不足时仍按轮次而非先到先占。
    groups = {"A": rows("same", 10), "B": rows("same", 10), "global": rows("other", 10)}
    small = [row for row in select_candidates(groups, 3, 5, 10) if row["in_pool"]]
    assert len(small) == 3
    assert any("global" in row["origins"] for row in small)


def test_keyword_rescue_and_no_raw_score_addition():
    ranked = hybrid_ranking(
        [{"id": "a", "score": 0.9}, {"id": "b", "score": 0.1}],
        [{"id": "b", "score": 1000}],
        0.5,
    )
    assert {row["relation_id"] for row in ranked} == {"a", "b"}
    assert all(abs(row["fusion_score"] - 1 / 61) < 1e-10 for row in ranked)
    assert (
        next(row for row in ranked if row["relation_id"] == "b").get("vector_rank")
        is None
    )


def test_rerank_recovers_investment_and_failure_keeps_fusion_order():
    candidates = select_candidates({"global": rows("r", 3)}, 3, 5, 0)
    details = {
        f"r{i}": {
            "source": "段永平",
            "target": target,
            "category": category,
            "description": text,
        }
        for i, (target, category, text) in enumerate(
            [
                ("马云", "评价", "称赞马云"),
                ("高盛", "投资", "买入高盛股票"),
                ("午餐", "参与", "参加午餐"),
            ]
        )
    }
    model = SimpleNamespace(rerank=lambda question, texts: [0.1, 0.95, 0.2])
    assert (
        rerank_candidates(model, "段永平投资了哪些公司", candidates, details, 1, 0.3)
        is None
    )
    assert [row["relation_id"] for row in candidates if row["kept"]] == ["r1"]
    assert candidates[1]["rerank_rank"] == 1
    broken = SimpleNamespace(rerank=lambda *args: [float("nan")])
    fresh = select_candidates({"global": rows("r", 3)}, 3, 5, 0)
    assert rerank_candidates(broken, "问题", fresh, details, 1, 0.99)
    assert [row["relation_id"] for row in fresh if row["kept"]] == ["r0"]
    assert all("rerank_score" not in row for row in fresh)


def test_optional_grouping_uses_entity_ids_and_preserves_scores():
    details = {}
    for i, (target, category) in enumerate(
        [
            ("ge", "投资"),
            ("ge", "投资"),
            ("tencent", "投资"),
            ("apple", "投资"),
            ("ge", "评价"),
            ("other", "投资"),
        ]
    ):
        details[f"r{i}"] = {
            "source": "段永平",
            "source_entity_id": "duan",
            "target": "GE" if i == 0 else "通用电气" if i == 1 else target,
            "target_entity_id": target,
            "category": category,
            "description": "事实",
        }
    model = SimpleNamespace(rerank=lambda *args: [0.99, 0.98, 0.97, 0.96, 0.95, 0.1])

    def run(grouping, limit=4, models=model):
        candidates = select_candidates({"global": rows("r", 6)}, 6, 0, 0)
        rerank_candidates(models, "问题", candidates, details, limit, 0.5, grouping)
        return candidates

    original = run(False)
    assert [r["relation_id"] for r in original if r["kept"]] == ["r0", "r1", "r2", "r3"]
    grouped = run(True)
    assert [r["relation_id"] for r in grouped if r["kept"]] == ["r0", "r2", "r3", "r4"]
    assert grouped[1]["group_key"] == grouped[0]["group_key"]
    assert grouped[1]["group_round"] == 2
    assert grouped[1]["rerank_rank"] == 2
    assert grouped[1]["selection_rank"] == 5
    assert grouped[1]["rerank_score"] == 0.98
    assert "group_round" not in grouped[5]  # 低相关关系不参加分组。
    assert sum(r["kept"] for r in run(True, 6)) == 5  # 第二轮仍可选入。
    broken = SimpleNamespace(rerank=lambda *args: None)
    fallback = run(True, models=broken)
    assert [r["kept"] for r in fallback] == [True, True, True, True, False, False]
    assert all("group_round" not in r for r in fallback)
