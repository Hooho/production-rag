import json

import numpy

from app.graph import build as graph_build
from app.graph import checks, resolve
from app.graph.schemas import DEFAULT_SCHEMA
from test_app import headers, setup  # noqa: F401
from test_graph_build import add_document, build, enable_model, run_graph_jobs
from test_graph_resolve import engine, entity, extraction


def relation(source, target, evidence, description="d"):
    return {
        "source": source,
        "target": target,
        "category": "其他",
        "description": description,
        "evidence": evidence,
    }


def plan_of(rows):
    db = engine()
    with db.connect() as connection:
        return db, resolve.prepare_build(connection, "online", "b1", rows)


def test_relation_scan_reasons():
    rows = [
        extraction(
            "e1",
            "c1",
            [entity("段永平", "人物"), entity("腾讯", "组织"), entity("网易", "组织")],
            [
                relation(
                    "段永平", "腾讯", "腾讯的用户黏性很强"
                ),  # 引用在原文里，但没提到段永平
                relation("段永平", "网易", "段永平买入网易"),  # 原文里找不到
                relation("腾讯", "网易", "第一章 投资"),  # 只在章节标题里
            ],
        )
    ]
    _, plan = plan_of(rows)
    chunks = [
        {
            "chunk_id": "c1",
            "position": 0,
            "content": "段永平说：腾讯的用户黏性很强。网易也不错。",
            "document_title": "投资",
            "heading_path": ["第一章 投资"],
            "context": "",
        }
    ]
    items = {
        item["target"] + item["evidence"]: item["reasons"]
        for item in checks.scan_relation(plan, chunks, {}, None)
    }
    assert items["腾讯腾讯的用户黏性很强"] == ["name_not_in_quote"]
    assert items["网易段永平买入网易"] == ["not_found"]
    assert items["网易第一章 投资"] == ["context_only"]
    # 抽查：通过核对的也按比例列出。
    rows[0]["result"]["relations"].append(relation("段永平", "腾讯", "段永平说：腾讯"))
    _, plan = plan_of(rows)
    assert len(checks.scan_relation(plan, chunks, {"sample": 100}, None)) == 4


def test_apply_relation_type_split_and_glean():
    rows = [
        extraction("e1", "c1", [entity("苹果", "组织"), entity("腾讯", "产品")]),
        extraction("e2", "c2", [entity("苹果", "组织"), entity("腾讯", "组织")]),
    ]
    db, plan = plan_of(rows)
    with db.connect() as connection:
        # 类型核对：腾讯统一成组织，两处并成一个实体。
        checks.apply_type(
            connection,
            plan,
            {"space": "online"},
            [{"name_key": "腾讯", "type": "组织"}],
        )
        tencent = {
            row["entity_id"] for row in plan["mentions"] if row["name"] == "腾讯"
        }
        assert len(tencent) == 1
        # 拆分：第 2 片的苹果拆出去，叫苹果（水果）。
        checks.apply_split(
            connection,
            plan,
            {"space": "online"},
            [
                {
                    "name_key": "苹果",
                    "type": "组织",
                    "groups": [
                        {"mentions": ["c1|苹果"], "name": "苹果"},
                        {"mentions": ["c2|苹果"], "name": "苹果（水果）"},
                    ],
                }
            ],
        )
        apple = {
            row["chunk_id"]: row for row in plan["mentions"] if row["name"] == "苹果"
        }
        assert apple["c1"]["entity_id"] != apple["c2"]["entity_id"]
        assert apple["c2"]["canonical"] == "苹果（水果）"
    # 补抽：采纳的实体、关系加进那一片的抽取结果，已有的名字不重复。
    checks.apply_glean(
        rows,
        {
            "c1": {
                "entities": [entity("网易", "组织"), entity("苹果", "组织")],
                "relations": [relation("苹果", "网易", "x")],
            }
        },
    )
    names = [row["name"] for row in rows[0]["result"]["entities"]]
    assert names == ["苹果", "腾讯", "网易"]
    assert len(rows[0]["result"]["relations"]) == 1


def test_glean_decision_drops_names_not_in_chunk_and_duplicates():
    rows = [
        extraction(
            "e1",
            "c1",
            [
                entity("沃伦·巴菲特", "人物"),
                entity("段永平", "人物"),
                entity("股市", "概念"),
            ],
            [relation("段永平", "沃伦·巴菲特", "段永平学习沃伦·巴菲特")],
        )
    ]
    _, plan = plan_of(rows)
    chunk = {
        "content": "段永平学习沃伦·巴菲特，也读芒格。二、存在银行或买国债。股市大跌时他没卖。"
    }
    output = {
        "entities": [
            {"name": "《富爸爸穷爸爸》", "type": "作品"},  # 原文没有
            {"name": "巴菲特", "type": "人物"},  # 可能是已有的：只标出来
            {"name": "芒格", "type": "人物"},
            {"name": "国债", "type": "产品"},
            {"name": "股市大跌", "type": "事件"},  # 比已有的长，不算重复
        ],
        "relations": [
            relation("段永平", "芒格", "也读芒格"),
            relation("段永平", "沃伦·巴菲特", "段永平学习沃伦·巴菲特"),  # 已有关系
            relation("段永平", "国债", "他买了国债"),  # 引用找不到
            relation("段永平", "《富爸爸穷爸爸》", "读了这本书"),  # 终点被去掉
        ],
    }
    item = {"chunk_id": "c1", "excerpt": ""}
    decision = checks.decide_glean(
        json.dumps(output, ensure_ascii=False), item, DEFAULT_SCHEMA, plan, chunk
    )
    assert [row["name"] for row in decision["entities"]] == [
        "巴菲特",
        "芒格",
        "国债",
        "股市大跌",
    ]
    assert decision["entities"][0]["same_as"] == "沃伦·巴菲特"
    assert "same_as" not in decision["entities"][3]
    assert [(row["source"], row["target"]) for row in decision["relations"]] == [
        ("段永平", "芒格")
    ]
    reasons = {row["name"]: row["reason"] for row in decision["dropped"]}
    assert reasons["《富爸爸穷爸爸》"] == "原文里找不到"
    assert "巴菲特" not in reasons
    assert reasons["段永平 → 沃伦·巴菲特"] == "这两个实体之间已经有关系"
    assert reasons["段永平 → 国债"] == "原文引用在这一片里找不到"
    assert reasons["段永平 → 《富爸爸穷爸爸》"] == "起点或终点不是这一片的实体"


def test_split_scan_uses_vectors_to_find_mixed_entity():
    rows = [
        extraction("e1", "c1", [entity("苹果", "组织", description="公司")]),
        extraction("e2", "c2", [entity("苹果", "组织", description="公司")]),
        extraction("e3", "c3", [entity("苹果", "组织", description="水果")]),
    ]
    _, plan = plan_of(rows)
    chunks = [
        {"chunk_id": key, "position": index, "content": f"苹果 {key}"}
        for index, key in enumerate(["c1", "c2", "c3"])
    ]

    class Models:
        @staticmethod
        def embed(texts):
            return [[0.0, 1.0] if "水果" in text else [1.0, 0.0] for text in texts]

    items = checks.scan_split(plan, chunks, {}, Models)
    assert len(items) == 1
    assert sorted(len(group) for group in items[0]["proposal"]) == [1, 2]
    assert ["c3|苹果"] in items[0]["proposal"]
    # 向量都很像：不列出。
    Models.embed = staticmethod(lambda texts: [[1.0, 0.0] for _ in texts])
    assert checks.scan_split(plan, chunks, {}, Models) == []
    assert numpy  # 保持导入


def test_type_scan_finds_same_name_with_different_types():
    rows = [
        extraction("e1", "c1", [entity("腾讯", "产品")]),
        extraction("e2", "c2", [entity("腾讯公司", "组织")]),
        extraction("e3", "c3", [entity("段永平", "人物")]),
    ]
    _, plan = plan_of(rows)
    chunks = [
        {"chunk_id": key, "position": index, "content": "腾讯"}
        for index, key in enumerate(["c1", "c2", "c3"])
    ]
    items = checks.scan_type(plan, chunks, {}, None)
    assert len(items) == 0  # 「腾讯」和「腾讯公司」规范化前不同名
    rows[1]["result"]["entities"][0]["canonical"] = "腾讯"
    _, plan = plan_of(rows)
    items = checks.scan_type(plan, chunks, {}, None)
    assert [item["name_key"] for item in items] == ["腾讯"]
    assert [row["type"] for row in items[0]["types"]] == ["产品", "组织"]


# 完整流程：关系核对 开始（只找）→ 确认判断 → 采纳删除 → 写入存成新版本（不生效）。
def test_relation_check_end_to_end(setup, monkeypatch):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    assert build(client, document_id).status_code == 202
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    build_id = graph["build"]["id"]
    assert graph["stats"]["relation_count"] == 2
    calls = []

    def fake(_, messages):
        calls.append(messages)
        body = json.loads(messages[1]["content"])
        verdict = (
            "unsupported" if body["relation"]["target"] == "苹果公司" else "supported"
        )
        return ("raw", json.dumps({"verdict": verdict, "reason": "r"}), 5, 3, "stop")

    monkeypatch.setattr(checks.extract, "call_model", fake)
    url = f"/documents/{document_id}/graph/check/relation"
    response = client.post(
        f"{url}/start",
        headers=headers(),
        json={"build_id": build_id, "params": {"sample": 100}},
    )
    assert response.status_code == 202, response.text
    # 检查进行中不能重建图。
    assert build(client, document_id).status_code == 409
    run_graph_jobs(store, models)
    detail = client.get(url, headers=headers()).json()["report"]
    assert detail["status"] == "scanned" and len(detail["items"]) == 2 and calls == []
    summary = client.get(
        f"/documents/{document_id}/graph/check", headers=headers()
    ).json()
    assert summary["steps"]["relation"]["status"] == "scanned"
    assert summary["steps"]["type"]["status"] == "idle"
    assert (
        client.post(
            f"{url}/judge", headers=headers(), json={"build_id": build_id}
        ).status_code
        == 200
    )
    run_graph_jobs(store, models)
    detail = client.get(url, headers=headers()).json()["report"]
    assert detail["status"] == "ready" and len(calls) == 2
    suggested = [
        key for key, row in detail["judgments"].items() if row["decision"]["suggest"]
    ]
    assert len(suggested) == 1
    # 还没采纳：不能写入。
    assert (
        client.post(
            f"{url}/write", headers=headers(), json={"build_id": build_id}
        ).status_code
        == 409
    )
    response = client.post(
        f"{url}/decide",
        headers=headers(),
        json={"build_id": build_id, "item_ids": suggested, "decision": "accept"},
    )
    assert response.status_code == 200, response.text
    assert (
        client.post(
            f"{url}/write", headers=headers(), json={"build_id": build_id}
        ).status_code
        == 200
    )
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    # 生效的还是 v1（2 条关系）；检查写入的 v2 少了一条，没有生效。
    assert graph["version"]["number"] == 1 and graph["stats"]["relation_count"] == 2
    second = next(row for row in graph["versions"] if row["number"] == 2)
    assert second["origin"] == "check" and second["active"] is False
    viewed = client.get(
        f"/documents/{document_id}/graph?version={second['id']}", headers=headers()
    ).json()
    assert viewed["stats"]["relation_count"] == 1
    detail = client.get(url, headers=headers()).json()["report"]
    assert detail["status"] == "ready" and detail["applied"]["items"] == suggested
    # 全部重新判断：每项都重新调用模型，人工决定清空，已写入的不动。
    response = client.post(
        f"{url}/rejudge", headers=headers(), json={"build_id": build_id}
    )
    assert response.status_code == 200, response.text
    run_graph_jobs(store, models)
    detail = client.get(url, headers=headers()).json()["report"]
    assert detail["status"] == "ready" and len(calls) == len(detail["items"]) * 2
    assert not detail.get("decisions")
    assert detail["applied"]["items"] == suggested
    # 跳过另一步。
    response = client.post(
        f"/documents/{document_id}/graph/check/glean/skip",
        headers=headers(),
        json={"build_id": build_id},
    )
    assert response.status_code == 200
    assert graph_build.checking_document  # 函数存在


# 自动检查：建图写入后从第 1 步开始，没有可疑项的步骤自动进入下一步。
def test_auto_check_starts_from_first_step(setup, monkeypatch):
    client, store = setup
    models = enable_model(client)
    monkeypatch.setattr(graph_build, "REVIEW_AUTO", True)
    document_id = add_document(client)
    assert build(client, document_id).status_code == 202
    run_graph_jobs(store, models)
    steps = client.get(
        f"/documents/{document_id}/graph/check", headers=headers()
    ).json()["steps"]
    # 每片都抽出了两个以上的实体：补抽没有可疑项；关系引用都在原文里：关系核对也没有；都自动往下走了。
    assert steps["glean"]["status"] == "ready" and steps["glean"]["count"] == 0
    assert steps["relation"]["status"] == "ready" and steps["relation"]["count"] == 0
    assert steps["type"]["status"] != "idle"
