from app.evaluation.retrieval import score_question


def test_filter_values_preserve_each_candidate_without_full_diagnostics():
    candidate = {
        "chunk_id": "c1",
        "rrf_rank": 3,
        "rerank_rank": 2,
        "rerank_probability": 0.068,
        "status": "filtered_low_score",
        "source_id": None,
        "contributions": [
            {"query": "q", "method": "dense", "rank": 8},
            {"query": "q", "method": "keyword", "rank": 2},
        ],
    }
    retrieval = {
        "diagnostics": {
            "config": {"return_limit": 2, "reranked": True, "min_score": 0.85},
            "candidates": [candidate],
        },
        "stats": {"returned": 0, "recall_ms": 3, "rerank_ms": 7},
    }
    row = score_question(
        {
            "id": "test",
            "question": "q",
            "type": "事实",
            "answerable": True,
            "evidence": ["具体证据"],
        },
        retrieval,
        {"c1": "具体证据"},
        pool_size=12,
    )
    saved = row["evidence"][0]["filter_candidates"][0]
    assert saved["vector_rank"] == 8
    assert saved["keyword_rank"] == 2
    assert saved["rrf_rank"] == 3
    assert saved["rerank_probability"] == 0.068
    assert saved["status"] == "filtered_low_score"
