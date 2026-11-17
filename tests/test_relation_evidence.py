from app.evaluation.retrieval import (
    graph_evidence_paths,
    graph_hit_summary,
    mark_extension,
)


def test_relation_hits_count_once_and_yield_to_chunk_and_extension():
    evidence = [{"targets": [{"chunk_id": "a"}], "relations": [{"relation_id": "Y"}]}]
    relations = [
        {"id": "G1", "relation_id": "X", "chunk_id": "a"},
        {"id": "G2", "relation_id": "Y", "chunk_id": "a"},
    ]
    for sources, expected in [
        ([], "relation"),
        ([{"chunk_id": "a"}], "direct"),
        ([{"chunk_id": "b", "parent_chunk_ids": ["b", "a"]}], "extension"),
    ]:
        row = {"evidence": [{}]}
        mark_extension(row, sources, evidence, {}, relations)
        assert row["given_hits"] == 1 and row["given_recall"] == 1
        assert row["evidence"][0]["via"] == expected
        assert row["relation_hits"] == (1 if expected == "relation" else 0)
    row = {"evidence": [{}]}
    mark_extension(row, [], evidence, {}, [])
    assert row["given_hits"] == 0 and row["evidence"][0]["via"] is None


def test_graph_paths_only_count_retained_and_delivered_relations():
    evidence = [
        {
            "targets": [{"chunk_id": chunk} for chunk in chunks],
            "relations": [{"relation_id": chunk} for chunk in chunks],
        }
        for chunks in [("a",), ("b",), ("c", "d"), ("e",), ("f",), ("g",)]
    ]
    candidates = [
        {"relation_id": name, "chunk_id": name, "kept": name != "e", "origins": origins}
        for name, origins in [
            ("a", ["entity-1", "entity-2"]),
            ("b", ["global"]),
            ("c", ["entity-1"]),
            ("d", ["global"]),
            ("e", ["global"]),
            ("f", ["global"]),
            ("g", ["entity-1", "global"]),
        ]
    ]
    diagnostics = {"graph": {"status": "ok", "relation_candidates": candidates}}
    sources = [{"chunk_id": name} for name in ("a", "c", "d", "e")]
    sources.append({"chunk_id": "parent", "parent_chunk_ids": ["parent", "f"]})
    relations = [{"relation_id": "b", "chunk_id": "b"}]
    paths = graph_evidence_paths(diagnostics, sources, relations, evidence, {})
    assert paths == [["entity"], ["global"], ["entity", "global"], [], [], []]
    assert graph_hit_summary(paths) == {"entity_only": 1, "global_only": 1, "both": 1}
    row = {"evidence": [{} for _ in evidence]}
    mark_extension(row, sources, evidence, {}, relations, diagnostics)
    assert row["graph_hits"]["both"] == 1
    assert row["evidence"][2]["graph_paths"] == ["entity", "global"]
    assert graph_hit_summary(
        graph_evidence_paths(diagnostics, [], [], evidence, {})
    ) == {
        "entity_only": 0,
        "global_only": 0,
        "both": 0,
    }
    assert graph_evidence_paths({}, sources, relations, evidence, {}) is None
    candidates[0].pop("origins")
    assert graph_evidence_paths(diagnostics, sources, relations, evidence, {}) is None


def test_same_chunk_unselected_relation_cannot_score_but_its_delivered_chunk_can():
    evidence = [{"targets": [{"chunk_id": "a"}], "relations": [{"relation_id": "Y"}]}]
    unrelated = {"relation_id": "X", "chunk_id": "a", "id": "G1"}
    for sources, expected in [([], 0), ([{"chunk_id": "a"}], 1)]:
        row = {"evidence": [{}]}
        mark_extension(row, sources, evidence, {}, [unrelated])
        assert row["given_hits"] == expected
        assert row["relation_hits"] == 0
        assert row["evidence"][0]["relation_ids"] == []
    row = {"evidence": [{}]}
    mark_extension(row, [], [{"targets": [{"chunk_id": "a"}]}], {}, [unrelated])
    assert row["given_hits"] == 0  # no configured relation evidence


def test_filter_reason_only_uses_selected_relation_not_other_relations_in_same_chunk():
    from app.evaluation.retrieval import score_question

    item = {
        "id": "question",
        "question": "黄峥评价",
        "type": "汇总",
        "answerable": True,
        "evidence": [
            {"targets": [{"chunk_id": "a"}], "relations": [{"relation_id": "Y"}]}
        ],
    }
    unrelated = {
        "chunk_id": "a",
        "relation_id": "X",
        "kept": False,
        "reason": "超过关系保留上限",
    }
    retrieval = {
        "diagnostics": {
            "config": {"return_limit": 1, "reranked": True},
            "candidates": [],
            "graph": {"relation_candidates": [unrelated]},
        },
        "sources": [],
        "stats": {"returned": 0},
    }
    result = score_question(item, retrieval, {}, 1)
    assert result["evidence"][0]["status"] == "not_recalled"
    retrieval["diagnostics"]["graph"]["relation_candidates"].append(
        {
            "chunk_id": "a",
            "relation_id": "Y",
            "kept": False,
            "reason": "超过关系重排候选上限",
        }
    )
    result = score_question(item, retrieval, {}, 1)
    assert result["evidence"][0]["graph_filter_reason"] == "超过关系重排候选上限"
