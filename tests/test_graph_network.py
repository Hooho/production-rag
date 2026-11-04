from app.graph.query import network


def graph():
    entities = [
        {"id": str(i), "name": f"Entity {i:03}", "type": "人物", "mention_count": 1}
        for i in range(40)
    ]
    relations = [
        {"source_id": "0", "target_id": str(i), "category": "任职", "description": ""}
        for i in range(1, 36)
    ]
    relations.extend(
        {"source_id": "1", "target_id": str(i), "category": "任职", "description": ""}
        for i in range(36, 40)
    )
    return entities, relations


def ids(result):
    return {node["id"] for node in result["nodes"]}


def test_overview_and_center_pages():
    entities, relations = graph()
    assert len(network(entities, relations)["nodes"]) == 20
    assert len(network(entities, relations, focus=["0"])["nodes"]) == 35
    first = network(entities, relations, center="0")
    assert len(first["nodes"]) == 16
    assert "36" not in ids(first)  # No automatic second hop.
    assert first["center_id"] == "0"
    assert (
        next(node for node in first["nodes"] if node["id"] == "0")["hidden_neighbors"]
        == 20
    )
    second = network(entities, relations, center="0", focus=["0"])
    assert len(second["nodes"]) == 31
    complete = network(entities, relations, center="0", focus=["0", "0"])
    assert len(complete["nodes"]) == 36
    assert ids(network(entities, relations, center="0", focus=[])) == ids(first)


def test_expansion_collapse_and_shared_neighbors():
    entities, relations = graph()
    first = network(entities, relations, center="0")
    expanded = network(entities, relations, center="0", focus=["1"])
    assert ids(expanded) - ids(first) == {"36", "37", "38", "39"}
    assert ids(network(entities, relations, center="0", focus=[])) == ids(first)
    # A collapsed parent must not leave a disconnected descendant's expansion behind.
    assert ids(network(entities, relations, center="0", focus=["36"])) == ids(first)
    # Repeated/reversed relations do not consume neighbor slots.
    repeated = (
        relations + relations + [{**relations[0], "source_id": "1", "target_id": "0"}]
    )
    assert len(network(entities, repeated, center="0")["nodes"]) == 16


def test_invalid_center_filters_and_cap():
    entities, relations = graph()
    assert not network(entities, relations, center="unknown")["nodes"]
    assert not network(entities, relations, center="0", entity_type="组织")["nodes"]
    assert ids(network(entities, relations, center="0", category="投资")) == {"0"}
    many = [{**entities[0], "id": str(i)} for i in range(500)]
    edges = [{**relations[0], "target_id": str(i)} for i in range(1, 500)]
    assert len(network(many, edges, center="0", focus=["0"] * 100)["nodes"]) <= 300
