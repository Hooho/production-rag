from app.evaluation.agent_retrieval import call_log


def test_filtered_candidates_preserved_without_becoming_delivered_hits():
    diagnostics = {
        "config": {"min_score": 0.85},
        "candidates": [
            {
                "chunk_id": "kept",
                "status": "returned",
                "contributions": [],
                "rerank_probability": 0.9,
            },
            {
                "chunk_id": "filtered",
                "status": "filtered_low_score",
                "contributions": [],
                "rerank_probability": 0.03,
                "preview": "被过滤的摘要",
            },
            {
                "chunk_id": "limited",
                "status": "returned",
                "contributions": [],
                "rerank_probability": 0.88,
            },
        ],
    }
    call = {
        "name": "search_knowledge",
        "status": "ok",
        "trace": {
            "top_k": 1,
            "evidence_ids": ["S1"],
            "retrieval": {
                "sources": [
                    {"chunk_id": "kept", "text": "返回原文"},
                    {"chunk_id": "limited", "text": "Top K 外"},
                ],
                "diagnostics": diagnostics,
                "stats": {"min_score": 0.85},
            },
        },
    }
    evidence = [{"text": "被过滤的证据", "targets": [{"chunk_id": "filtered"}]}]
    row = call_log(1, 1, call, evidence, {"filtered": "被过滤的证据"})
    candidates = row["retrieval_diagnostics"]["candidates"]
    assert candidates[1]["status"] == "filtered_low_score"
    assert candidates[1]["rerank_probability"] == 0.03
    assert candidates[1]["hits"] == [0]
    assert candidates[2]["agent_status"] == "beyond_top_k"
    assert row["chunk_ids"] == ["kept"] and row["hits"] == []
    assert len(row["results"]) == 1
    assert row["retrieval_stats"]["min_score"] == 0.85
    assert "agent_status" not in diagnostics["candidates"][1]


def test_empty_results_still_keep_filter_diagnostics_and_legacy_is_optional():
    call = {
        "name": "search_knowledge",
        "status": "ok",
        "trace": {
            "retrieval": {
                "sources": [],
                "diagnostics": {
                    "config": {},
                    "candidates": [{"chunk_id": "x", "status": "not_in_pool"}],
                },
            }
        },
    }
    row = call_log(1, 1, call, [], {})
    assert row["retrieval_diagnostics"]["candidates"][0]["status"] == "not_in_pool"
    assert row["chunk_ids"] == [] and row["hits"] == []
    legacy = call_log(
        1,
        1,
        {
            "name": "search_knowledge",
            "status": "ok",
            "trace": {"retrieval": {"sources": []}},
        },
        [],
        {},
    )
    assert "retrieval_diagnostics" not in legacy
