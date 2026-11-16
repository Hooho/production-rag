from app.evaluation.retrieval import (
    graph_evidence_paths,
    graph_hit_summary,
    mark_extension,
)


def test_relation_hits_count_once_and_yield_to_chunk_and_extension():
    evidence = [{"targets": [{"chunk_id": "a"}]}]
    relations = [{"id": "G1", "chunk_id": "a"}, {"id": "G2", "chunk_id": "a"}]
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
        {"targets": [{"chunk_id": chunk} for chunk in chunks]}
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
