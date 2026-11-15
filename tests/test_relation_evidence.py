from app.evaluation.retrieval import mark_extension


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
