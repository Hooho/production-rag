from types import SimpleNamespace

from app.tools.search import DocumentSearchTool


class BudgetStore:
    def search(self, owner, query, models, limit):
        return [
            dict(
                id=key,
                title=key,
                text="原" * 400,
                score=1 - i / 10,
                document_id="d",
                position=position,
                retrieval_methods=["dense"],
            )
            for i, (key, position) in enumerate([("a", 0), ("b", 2), ("c", 3)])
        ]

    def neighbor_chunks(self, document_id, position, radius):
        return [
            dict(
                id=key,
                position=pos,
                content=body,
                text=body,
                chunk_metadata={"heading_path": ["章节"]},
            )
            for key, pos, body in [
                ("a", 0, "原" * 400),
                ("x", 1, "补" * 300),
                ("b", 2, "原" * 400),
                ("c", 3, "原" * 400),
            ]
        ]


def search(runtime, budget, mode="tokens"):
    runtime(
        source_selection_mode=mode,
        source_token_budget=budget,
        return_limit=1,
        parent_context=True,
        rerank_min_score=0.1,
        rerank_fallback_min_score=0,
    )
    models = SimpleNamespace(rerank=lambda query, texts: [0.9, 0.8, 0.7][: len(texts)])
    return DocumentSearchTool().execute(
        BudgetStore(),
        models,
        "alice",
        ["原文"],
        "问题",
        methods=("dense",),
        pool_size=10,
    )


def test_original_hits_take_priority_over_parent_expansion(runtime):
    result = search(runtime, 1000)
    assert [row["chunk_id"] for row in result["sources"]] == ["a", "b"]
    assert all(len(row["parent_chunk_ids"]) == 1 for row in result["sources"])
    config = result["diagnostics"]["config"]
    assert config["source_tokens_used"] == 800
    assert config["source_budget_skipped"] == 1
    assert config["source_expansion_skipped"] >= 1
    assert (
        next(
            row for row in result["diagnostics"]["candidates"] if row["chunk_id"] == "c"
        )["status"]
        == "beyond_budget"
    )


def test_remaining_budget_can_expand_without_counting_hits_twice(runtime):
    result = search(runtime, 1600)
    assert len(result["sources"]) == 3  # 不受原来的 return_limit=1 截断
    chunks = [key for row in result["sources"] for key in row["parent_chunk_ids"]]
    assert len(chunks) == len(set(chunks))
    assert "x" in chunks
    config = result["diagnostics"]["config"]
    assert config["source_child_tokens"] == 1200
    assert 1500 <= config["source_tokens_used"] <= 1600


def test_count_mode_preserves_existing_limit_and_parent_behavior(runtime):
    result = search(runtime, 1000, mode="count")
    assert len(result["sources"]) == 1
    assert result["diagnostics"]["config"]["source_selection_mode"] == "count"
    assert result["diagnostics"]["config"]["source_tokens_used"] is None


def test_oversized_hit_does_not_block_smaller_later_hits(runtime):
    runtime(
        source_selection_mode="tokens",
        source_token_budget=1000,
        return_limit=1,
        parent_context=False,
        rerank_min_score=0.1,
        rerank_fallback_min_score=0,
    )

    class Store(BudgetStore):
        def search(self, *args, **kwargs):
            rows = super().search(*args, **kwargs)
            rows[0]["text"] = "大" * 1100
            return rows

    result = DocumentSearchTool().execute(
        Store(),
        SimpleNamespace(rerank=lambda *args: [0.9, 0.8, 0.7]),
        "alice",
        ["原文"],
        "问题",
        methods=("dense",),
    )
    assert [row["chunk_id"] for row in result["sources"]] == ["b", "c"]
    assert result["stats"]["source_tokens_used"] == 800
