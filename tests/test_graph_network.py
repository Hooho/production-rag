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


def test_category_expansion_adds_only_matching_unseen_neighbors():
    entities, relations = graph()
    relations = [
        {**row, "category": "投资" if int(row["target_id"]) % 2 else "评价"}
        for row in relations
    ]
    first = network(entities, relations, limit=1)
    investment = network(entities, relations, limit=1, focus=["0|%E6%8A%95%E8%B5%84"])
    added = ids(investment) - ids(first)
    assert len(added) == 15
    assert all(int(item) % 2 for item in added)
    twice = network(
        entities,
        relations,
        limit=1,
        focus=["0|%E6%8A%95%E8%B5%84", "0|%E6%8A%95%E8%B5%84"],
    )
    assert len(ids(twice) - ids(first)) == 18
    assert ids(investment) <= ids(twice)
    mixed = network(
        entities,
        relations,
        limit=1,
        focus=["0|%E6%8A%95%E8%B5%84", "0|%E8%AF%84%E4%BB%B7"],
    )
    assert len(ids(mixed) - ids(investment)) == 15
    assert all(int(item) % 2 == 0 for item in ids(mixed) - ids(investment))
    assert ids(network(entities, relations, limit=1, focus=["0|不存在"])) == ids(first)
    all_categories = network(entities, relations, limit=1, focus=["0"])
    assert len(ids(all_categories) - ids(first)) == 15


def test_category_remaining_neighbors_matches_expansion():
    entities, relations = graph()
    relations = [
        {**row, "category": "投资" if int(row["target_id"]) % 2 else "评价"}
        for row in relations
    ]
    first = network(entities, relations, limit=1)
    node = next(item for item in first["nodes"] if item["id"] == "0")
    assert node["hidden_neighbors_by_category"] == {"投资": 18, "评价": 17}
    expanded = network(entities, relations, limit=1, focus=["0|%E6%8A%95%E8%B5%84"] * 2)
    node = next(item for item in expanded["nodes"] if item["id"] == "0")
    assert node["hidden_neighbors_by_category"] == {"投资": 0, "评价": 17}
    assert node["hidden_neighbors"] == 17


def test_edges_split_by_category_and_direction():
    entities, _ = graph()

    def relation(source, target, category):
        return {
            "source_id": source,
            "target_id": target,
            "category": category,
            "description": category,
        }

    relations = [
        relation("0", "1", "投资"),
        relation("0", "1", "投资"),
        relation("0", "1", "评价"),
        relation("1", "0", "投资"),
        relation("0", "0", "评价"),
    ]
    result = network(entities, relations)
    edges = {edge["id"]: edge for edge in result["edges"]}
    assert set(edges) == {"0>1|投资", "0>1|评价", "1>0|投资", "0>0|评价"}
    assert edges["0>1|投资"]["count"] == 2
    assert edges["0>1|评价"]["count"] == 1
    assert all(len(edge["categories"]) == 1 for edge in edges.values())
    assert sum(edge["count"] for edge in edges.values()) == len(relations)


def test_show_matching_neighbors_respects_name_category_and_existing_nodes():
    from urllib.parse import quote

    entities, relations = graph()
    entities = [
        {
            **item,
            "name": "腾讯" + item["id"]
            if int(item["id"]) % 2
            else "Apple " + item["id"],
        }
        for item in entities
    ]
    relations = [
        {**row, "category": "投资" if int(row["target_id"]) < 30 else "评价"}
        for row in relations
    ]
    before = network(entities, relations, limit=1)
    result = network(
        entities, relations, limit=1, focus=[f"0|{quote('投资')}|{quote('腾讯')}"]
    )
    added = ids(result) - ids(before)
    assert added == {str(i) for i in range(1, 30, 2)}
    repeated = network(
        entities, relations, limit=1, focus=[f"0|{quote('投资')}|{quote('腾讯')}"] * 2
    )
    assert ids(repeated) == ids(result)
    all_categories = network(
        entities, relations, limit=1, focus=[f"0||{quote('腾讯')}"]
    )
    assert ids(all_categories) - ids(before) == {str(i) for i in range(1, 36, 2)}
    no_match = network(entities, relations, limit=1, focus=[f"0||{quote('不存在')}"])
    assert ids(no_match) == ids(before)
    english = network(entities, relations, limit=1, focus=[f"0||{quote('ＡＰＰＬＥ')}"])
    assert ids(english) - ids(before) == {str(i) for i in range(2, 36, 2)}
