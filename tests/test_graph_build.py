import json

from langchain_core.messages import AIMessage
from sqlalchemy import func, select

from app.graph import build as graph_build
from app.mysql.tables import (
    documents,
    graph_builds,
    graph_chunk_extractions,
    graph_entities,
    graph_mentions,
    graph_relations,
)
from test_app import headers, publish, setup  # noqa: F401

CONTENT = (
    "# 创业\n\n段永平创办了步步高。步步高后来分出了 OPPO 和 vivo。\n\n"
    "# 投资\n\n2011 年，阿段买入了苹果公司的股票，他认为苹果有很强的护城河。"
)


# 假的聊天模型：按分片内容回复。分片里有「步步高」就抽创办关系，有「苹果」就抽投资关系；fail 里的词出现时报错。
class FakeChatModel:
    def __init__(self):
        self.calls = 0
        self.fail = set()

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.calls += 1
        text = messages[1].content
        chunk = text.split("<chunk>")[1]
        for word in self.fail:
            if word in chunk:
                raise RuntimeError("连接超时")
        entities, relations = [], []
        if "步步高" in chunk:
            entities += [
                {
                    "name": "段永平",
                    "canonical": "段永平",
                    "type": "人物",
                    "description": "企业家",
                },
                {
                    "name": "步步高",
                    "canonical": "步步高",
                    "type": "组织",
                    "description": "电子公司",
                },
            ]
            relations.append(
                {
                    "source": "段永平",
                    "target": "步步高",
                    "category": "创办",
                    "description": "段永平创办步步高",
                    "evidence": "段永平创办了步步高。",
                }
            )
        if "苹果" in chunk:
            entities += [
                {
                    "name": "阿段",
                    "canonical": "段永平",
                    "type": "人物",
                    "description": "投资人",
                },
                {
                    "name": "苹果公司",
                    "canonical": "苹果公司",
                    "type": "组织",
                    "description": "科技公司",
                },
            ]
            relations.append(
                {
                    "source": "阿段",
                    "target": "苹果公司",
                    "category": "投资",
                    "description": "2011 年买入苹果",
                    "evidence": "2011 年，阿段买入了苹果公司的股票",
                }
            )
        return AIMessage(
            content=json.dumps(
                {"entities": entities, "relations": relations}, ensure_ascii=False
            ),
            usage_metadata={
                "input_tokens": 100,
                "output_tokens": 20,
                "total_tokens": 120,
            },
        )


def enable_model(client):
    models = client.app.state.models
    models.mode = "openai"
    models.chat_model = FakeChatModel()
    return models


def add_document(client, owner="alice", title="段永平", content=CONTENT, replace=None):
    body = {"title": title, "content": content}
    if replace:
        body["replace_document_id"] = replace
    response = client.post("/documents", headers=headers(owner), json=body)
    assert response.status_code == 200, response.text
    return response.json()["document_id"]


# 跑完队列里的所有建图任务（worker 一次处理一批）。
def run_graph_jobs(store, models):
    count = 0
    while True:
        raw = store.cache.lpop(graph_build.QUEUE)
        if raw is None:
            return count
        graph_build.run_job(store, models, json.loads(raw))
        count += 1


def build(client, document_id, owner="alice", **body):
    return client.post(
        f"/documents/{document_id}/graph", headers=headers(owner), json=body
    )


# 演示模式没有大模型：不能建图，直接说明原因。
def test_demo_mode_cannot_build(setup):
    client, store = setup
    document_id = add_document(client)
    response = build(client, document_id)
    assert response.status_code == 409 and "演示模式" in response.json()["detail"]


# 完整流程：预估 → 建图（分批排队）→ 合并 → 文档页签的概览、图、实体表、关系表、合并记录 → 处理流程里的两步。
def test_build_document_graph(setup, monkeypatch):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    estimate = client.get(
        f"/documents/{document_id}/graph/estimate", headers=headers()
    ).json()
    total = estimate["total"]
    assert total >= 1 and estimate["to_extract"] == total and estimate["reusable"] == 0
    assert (
        estimate["provider"] == models.llm_provider
        and estimate["prompt_tag"] == "graph_extract@内置"
    )
    monkeypatch.setattr(graph_build, "BATCH_SIZE", 1)
    response = build(client, document_id)
    assert response.status_code == 202, response.text
    assert (
        response.json()["status"] == "queued" and response.json()["trigger"] == "manual"
    )
    # 正在建图时不能再建一次。
    assert build(client, document_id).status_code == 409
    assert run_graph_jobs(store, models) == total
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert graph["build"]["status"] == "completed" and graph["build"]["active"] is True
    assert graph["build"]["schema_name"] == "默认清单 v1"
    assert graph["stats"]["entity_count"] == 3 and graph["stats"]["relation_count"] == 2
    assert graph["stats"]["status_counts"]["extracted"] == total
    assert graph["can_build"] is True
    names = {node["name"] for node in graph["network"]["nodes"]}
    assert names == {"段永平", "步步高", "苹果公司"}
    entities = client.get(
        f"/documents/{document_id}/graph?view=entities", headers=headers()
    ).json()["entities"]
    assert (
        entities["items"][0]["name"] == "段永平"
        and entities["items"][0]["relation_count"] == 2
    )
    relations = client.get(
        f"/documents/{document_id}/graph?view=relations&q=苹果", headers=headers()
    ).json()["relations"]
    assert [
        (row["source_name"], row["source_entity"], row["target_entity"])
        for row in relations["items"]
    ] == [("阿段", "段永平", "苹果公司")]
    merges = client.get(
        f"/documents/{document_id}/graph?view=merges", headers=headers()
    ).json()["merges"]["items"]
    assert (
        merges[0]["name"] == "阿段"
        and merges[0]["entity_name"] == "段永平"
        and merges[0]["method_label"] == "模型标准名"
    )
    steps = {
        step["step_id"]: step
        for step in client.get(f"/documents/{document_id}", headers=headers()).json()[
            "steps"
        ]
    }
    assert (
        steps["graph_extract"]["status"] == "completed"
        and steps["graph_merge"]["status"] == "completed"
    )
    assert "模型标准名 1" in steps["graph_merge"]["detail"]
    # 实体详情（文档内）：名字、出处、关系。
    entity_id = next(
        node["id"] for node in graph["network"]["nodes"] if node["name"] == "段永平"
    )
    detail = client.get(
        f"/graph/entities/{entity_id}?document_id={document_id}", headers=headers()
    ).json()
    assert {item["name"] for item in detail["names"]} == {"段永平", "阿段"}
    assert len(detail["relations"]) == 2


# 分片文字、清单、模型、提示词都没变时，重新建图直接复用，不再调用模型；旧的建图记录不再生效。
def test_rebuild_reuses_extractions(setup):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    calls = models.chat_model.calls
    assert (
        client.get(
            f"/documents/{document_id}/graph/estimate", headers=headers()
        ).json()["to_extract"]
        == 0
    )
    build(client, document_id)
    run_graph_jobs(store, models)
    assert models.chat_model.calls == calls
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert (
        graph["build"]["reused"] == graph["build"]["total"]
        and graph["build"]["extracted"] == 0
    )
    assert len(graph["history"]) == 2
    with store.engine.connect() as connection:
        assert (
            connection.execute(
                select(func.count())
                .select_from(graph_builds)
                .where(graph_builds.c.active.is_(True))
            ).scalar_one()
            == 1
        )
        # 实体还是 3 个，没有因为重建而重复。
        assert (
            connection.execute(
                select(func.count()).select_from(graph_entities)
            ).scalar_one()
            == 3
        )


# 有分片失败时记为部分完成，失败的可以补跑；补跑成功后重新合并。
def test_partial_and_retry(setup):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    models.chat_model.fail = {"苹果"}
    build(client, document_id)
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    if graph["build"]["total"] == 1:
        # 只切出一片时整份都失败：没有可用的结果，记为失败。
        assert graph["build"]["status"] == "failed"
    else:
        assert (
            graph["build"]["status"] == "partial"
            and graph["stats"]["status_counts"]["failed"] == 1
        )
    models.chat_model.fail = set()
    retry = client.post(
        f"/documents/{document_id}/graph/retry", headers=headers(), json={}
    )
    assert retry.status_code == 202, retry.text
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert (
        graph["build"]["status"] == "completed"
        and graph["stats"]["relation_count"] == 2
    )
    assert (
        client.post(
            f"/documents/{document_id}/graph/retry", headers=headers(), json={}
        ).status_code
        == 409
    )


# 权限：读得到文档才能看图；只有上传者和管理员能建图；全局页面只有管理员能看。
def test_permissions(setup):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    assert (
        client.get(
            f"/documents/{document_id}/graph", headers=headers("bob")
        ).status_code
        == 404
    )
    assert build(client, document_id, owner="bob").status_code == 404
    publish(client, document_id)
    assert (
        client.get(f"/documents/{document_id}/graph", headers=headers("bob")).json()[
            "can_build"
        ]
        is False
    )
    assert build(client, document_id, owner="bob").status_code == 403
    assert build(client, document_id, owner="admin").status_code == 202
    run_graph_jobs(store, models)
    for path in ("/graph/overview", "/graph/tasks"):
        assert client.get(path, headers=headers("alice")).status_code == 403
        assert client.get(path, headers=headers("admin")).status_code == 200
    entity_id = client.get("/graph/overview", headers=headers("admin")).json()[
        "network"
    ]["nodes"][0]["id"]
    assert (
        client.get(f"/graph/entities/{entity_id}", headers=headers("alice")).status_code
        == 403
    )
    assert (
        client.get(f"/graph/entities/{entity_id}", headers=headers("admin")).status_code
        == 200
    )


# 跨文档合并：两份文档里的「段永平」是同一个实体；全局总图把两份合在一起，实体详情列出出现在哪几份文档。
def test_cross_document_overview_and_tasks(setup):
    client, store = setup
    models = enable_model(client)
    first = add_document(client)
    second = add_document(client, title="步步高", content="段永平创办了步步高。")
    third = add_document(client, title="第三份", content="这是第三份文档。")
    started = client.post(
        "/graph/builds",
        headers=headers(),
        json={"document_ids": [first, second, third, first]},
    ).json()
    assert len(started["started"]) == 3 and started["skipped"] == []
    run_graph_jobs(store, models)
    overview = client.get("/graph/overview", headers=headers("admin")).json()
    assert len(overview["documents"]) == 3
    person = next(
        node for node in overview["network"]["nodes"] if node["name"] == "段永平"
    )
    detail = client.get(
        f"/graph/entities/{person['id']}", headers=headers("admin")
    ).json()
    assert {item["title"] for item in detail["documents"]} == {"段永平", "步步高"}
    searched = client.get("/graph/overview?q=苹果", headers=headers("admin")).json()
    assert [item["name"] for item in searched["matches"]] == ["苹果公司"]
    # 新版本上传后旧图谱过期；没建过的显示未建。
    add_document(
        client, title="段永平", content=CONTENT + "\n\n补充一段。", replace=first
    )
    states = {
        item["title"]: item["state"]
        for item in client.get("/graph/tasks", headers=headers("admin")).json()["items"]
    }
    assert (
        states["段永平"] == "outdated"
        and states["步步高"] == "completed"
        and states["第三份"] == "completed"
    )
    # 删除文档时它所有版本的图谱一起删掉，只属于它的实体也清理掉。
    assert client.delete(f"/documents/{second}", headers=headers()).status_code == 200
    with store.engine.connect() as connection:
        assert (
            connection.execute(
                select(func.count())
                .select_from(graph_builds)
                .where(graph_builds.c.document_id == second)
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                select(func.count())
                .select_from(graph_mentions)
                .where(graph_mentions.c.document_id == second)
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                select(func.count())
                .select_from(graph_relations)
                .where(graph_relations.c.document_id == second)
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                select(func.count())
                .select_from(graph_chunk_extractions)
                .where(graph_chunk_extractions.c.document_id == second)
            ).scalar_one()
            == 0
        )


# 上传时开启图检索：设置记进文档 metadata，处理完自动建图；新版本不传时沿用上一版的设置；关掉的不建。
def test_auto_build_settings(setup):
    client, store = setup
    models = enable_model(client)
    from app.api.graph_routes import upload_settings

    document_id = add_document(client)
    settings = upload_settings(store, models, "on", None, None, None, None)
    assert settings == {
        "enabled": True,
        "schema_id": "default-v1",
        "provider": models.llm_provider,
        "model": models.llm_model,
        "trigger": "upload",
    }
    with store.engine.begin() as connection:
        connection.execute(
            documents.update()
            .where(documents.c.id == document_id)
            .values(document_metadata={"graph": settings})
        )
    doc_key = store.readable_document("alice", document_id)["doc_key"] or document_id
    assert (
        upload_settings(store, models, None, None, None, None, doc_key)["trigger"]
        == "version"
    )
    assert upload_settings(store, models, "off", None, None, None, doc_key) is None
    assert upload_settings(store, models, None, None, None, None, None) is None
    started = graph_build.auto_build(store, models, document_id)
    assert started["trigger"] == "upload"
    run_graph_jobs(store, models)
    assert (
        client.get(f"/documents/{document_id}/graph", headers=headers()).json()[
            "build"
        ]["status"]
        == "completed"
    )
    other = add_document(client, title="不建图", content="没有开启图检索。")
    assert graph_build.auto_build(store, models, other) is None
    # 选了没保存过的模型配置：上传时直接拒绝；自动建图时改用当前启用的模型并写明原因。
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        upload_settings(store, models, "on", None, "nobody", "x", None)
    llm, note = graph_build.resolve_llm(
        store, models, {"provider": "nobody", "model": "x"}, fallback=True
    )
    assert llm["provider"] == models.llm_provider and "改用当前启用的模型" in note


# worker 重启时把中断的建图任务重新放回队列。
def test_recover_requeues_unfinished_builds(setup):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    build(client, document_id)
    store.cache.delete(graph_build.QUEUE)
    assert graph_build.recover(store) == 1
    assert graph_build.recover(store) == 0
    run_graph_jobs(store, models)
    assert (
        client.get(f"/documents/{document_id}/graph", headers=headers()).json()[
            "build"
        ]["status"]
        == "completed"
    )


# 分块列表：每个分片带上抽取情况（名字归到了哪个实体、关系、提示词、原始输出），可以按抽取状态筛选。
def test_chunk_list_shows_extraction(setup):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    page = client.get(f"/documents/{document_id}/chunks", headers=headers()).json()
    assert page["graph"] is None and all(
        chunk["graph"] is None for chunk in page["chunks"]
    )
    models.chat_model.fail = {"苹果"}
    build(client, document_id)
    run_graph_jobs(store, models)
    page = client.get(f"/documents/{document_id}/chunks", headers=headers()).json()
    assert (
        page["graph"]["schema_name"] == "默认清单 v1"
        and page["graph"]["prompt_tag"] == "graph_extract@内置"
    )
    counts = page["graph_counts"]
    assert counts["failed"] == 1
    failed = client.get(
        f"/documents/{document_id}/chunks?graph_status=failed", headers=headers()
    ).json()
    assert failed["total"] == 1
    item = failed["chunks"][0]["graph"]
    assert (
        item["status"] == "failed"
        and "连接超时" in item["error"]
        and item["prompt"][1]["role"] == "user"
    )
    models.chat_model.fail = set()
    client.post(
        f"/documents/{document_id}/graph/retry",
        headers=headers(),
        json={"chunk_id": failed["chunks"][0]["chunk_id"]},
    )
    run_graph_jobs(store, models)
    page = client.get(f"/documents/{document_id}/chunks", headers=headers()).json()
    apple = next(chunk for chunk in page["chunks"] if "苹果" in chunk["content"])[
        "graph"
    ]
    assert apple["status"] == "extracted" and apple["input_tokens"] == 100
    assert [
        (item["name"], item["entity_name"], item["method_label"])
        for item in apple["mentions"]
    ][0] == ("阿段", "段永平", "模型标准名")
    assert apple["relations"][0]["source_entity"] == "段永平"
    assert (
        client.get(
            f"/documents/{document_id}/chunks?graph_status=failed", headers=headers()
        ).json()["total"]
        == 0
    )
    assert (
        client.get(
            f"/documents/{document_id}/chunks?graph_status=bad", headers=headers()
        ).status_code
        == 422
    )


def test_entity_detail_requires_visible_mention(setup):
    client, store = setup
    models = enable_model(client)
    private = add_document(client)
    assert build(client, private).status_code == 202
    run_graph_jobs(store, models)
    private_entity = client.get(
        f"/documents/{private}/graph", headers=headers()
    ).json()["network"]["nodes"][0]["id"]
    public = add_document(client, title="公开资料", content="普通介绍，没有相关实体。")
    publish(client, public)
    assert (
        client.get(
            f"/graph/entities/{private_entity}?document_id={public}",
            headers=headers("bob"),
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/graph/entities/{private_entity}?document_id={private}",
            headers=headers("bob"),
        ).status_code
        == 404
    )
    # 同名实体跨文档共用，但描述只能来自当前有权查看的出处。
    from app.mysql.tables import graph_entities

    with store.engine.begin() as connection:
        connection.execute(
            graph_entities.update()
            .where(graph_entities.c.id == private_entity)
            .values(description="私有描述不可泄露")
        )
    shared = add_document(client)
    publish(client, shared)
    assert build(client, shared).status_code == 202
    run_graph_jobs(store, models)
    response = client.get(
        f"/graph/entities/{private_entity}?document_id={shared}", headers=headers("bob")
    )
    assert response.status_code == 200
    assert "私有描述不可泄露" not in response.text
    assert {row["document_id"] for row in response.json()["documents"]} == {shared}
    assert (
        "私有描述不可泄露"
        not in client.get(
            f"/documents/{shared}/graph?view=entities", headers=headers("bob")
        ).text
    )


def test_build_freezes_prompt_and_schema_across_batches_and_retry(setup, monkeypatch):
    from app import prompts
    from app.graph.extract import cache_key
    from app.graph.schemas import get_schema, DEFAULT_SCHEMA_ID
    from app.mysql.tables import graph_schemas

    client, store = setup
    models = enable_model(client)
    document_id = add_document(client, content=CONTENT * 30)
    original_current = prompts.current
    monkeypatch.setattr(
        prompts,
        "current",
        lambda key: (41, "固定规则 A")
        if key == "graph_extract"
        else original_current(key),
    )
    monkeypatch.setattr(graph_build, "BATCH_SIZE", 1)
    started = build(client, document_id).json()
    assert started["total"] > 1
    snapshot = graph_build.build_inputs(store.engine, started["id"])
    models.chat_model.fail = {"苹果"}
    first = json.loads(store.cache.lpop(graph_build.QUEUE))
    graph_build.run_job(store, models, first)
    # 改动当前提示词及清单后，剩余批次仍使用原快照。
    monkeypatch.setattr(
        prompts,
        "current",
        lambda key: (42, "新规则 B")
        if key == "graph_extract"
        else original_current(key),
    )
    schema = get_schema(store.engine, DEFAULT_SCHEMA_ID)
    monkeypatch.setattr(
        graph_build, "schema_for", lambda *args: {**schema, "entity_types": []}
    )
    run_graph_jobs(store, models)
    models.chat_model.fail.clear()
    assert (
        client.post(
            f"/documents/{document_id}/graph/retry", headers=headers(), json={}
        ).status_code
        == 202
    )
    run_graph_jobs(store, models)
    with store.engine.connect() as connection:
        rows = (
            connection.execute(
                select(graph_chunk_extractions).where(
                    graph_chunk_extractions.c.build_id == started["id"]
                )
            )
            .mappings()
            .all()
        )
    assert len(rows) == started["total"]
    for row in rows:
        assert row["prompt"][0]["content"] == snapshot["system_prompt"]
        assert row["cache_key"] == cache_key(
            row["chunk_key"],
            snapshot["schema_snapshot"],
            started["provider"],
            started["model"],
            started["prompt_identity"],
        )
    assert (
        graph_build.get_build(store.engine, started["id"])["prompt_tag"]
        == "graph_extract@v41"
    )
    assert graph_build.get_build(store.engine, started["id"])["status"] == "completed"
