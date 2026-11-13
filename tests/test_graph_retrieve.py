import json

import pytest
from langchain_core.messages import AIMessage
from sqlalchemy import update

from app.graph import retrieve as graph_retrieve
from app.milvus.graph_store import GraphVectorStore
from app.mysql.tables import graph_relations
from graph_fakes import FakeGraphClient
from test_app import setup  # noqa: F401
from test_graph_build import add_document, build, enable_model, run_graph_jobs

# 按字计数的替身向量：有相同的字就相似，方便在测试里预料哪些名字、关系会被找到。
CHARS = "段永平阿步高苹果公司投资创办买入"


def char_embed(texts):
    vectors = []
    for text in texts:
        vector = [float(text.count(char)) for char in CHARS] + [0.01]
        vectors.append(vector)
    return vectors


@pytest.fixture
def graph(setup, monkeypatch):
    client, store = setup
    models = enable_model(client)
    monkeypatch.setattr(models, "embed", char_embed)
    store.graph_vectors = GraphVectorStore(
        FakeGraphClient(), models.collection, len(CHARS) + 1
    )
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    return client, store, models, document_id


# Agent 给了关键词：不调用模型；具体关键词找到实体「段永平」（阿段归在它下面），一跳取它的两条关系；
# 概括关键词「投资」找到投资那条关系；两张排名表都是出处分片。
def test_retrieve_with_given_keywords(graph):
    client, store, models, document_id = graph
    scope = store.readable_scope("alice")
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平投资了什么",
        scope,
        {
            "graph_relation_min_score": 0.3,
            "graph_entity_min_score": 0.3,
        },
        entities=["段永平"],
        themes=["投资"],
    )
    assert result["status"] == "ok"
    assert result["keywords"]["source"] == "agent" and result["keywords"][
        "entities"
    ] == ["段永平"]
    # 问题始终记在诊断里：关系相似度是「问题 × 关系」，页面要显示是哪个问题。
    assert result["keywords"]["question"] == "段永平投资了什么"
    assert [item["document_id"] for item in result["scope"]] == [document_id]
    assert "段永平" in [entity["name"] for entity in result["entities"]]
    kept_names = {match["name"] for match in result["name_matches"] if match["kept"]}
    assert "段永平" in kept_names
    # 名字向量用的文字：名字（类型）：描述，诊断里能看到向量到底算的是什么。
    assert (
        next(
            match["vector_text"]
            for match in result["name_matches"]
            if match["name"] == "段永平"
        )
        == "段永平（人物）：企业家"
    )
    relations = {
        (item["source"], item["target"])
        for item in result["entity_relations"]
        if item["kept"]
    }
    assert relations == {("段永平", "步步高"), ("阿段", "苹果公司")}
    assert {row["keyword"] for row in result["relation_matches"]} == {
        "段永平投资了什么"
    }
    assert all(row["also_entity"] for row in result["relation_matches"])
    assert result["keywords"]["themes"] == []
    assert result["pipeline"] == "hybrid_relations_v2"
    assert result["sources"]["unified"] and result["sources"]["unified"]
    first = result["sources"]["unified"][0]
    assert (
        first["document_id"] == document_id and first["text"] and first["relation_ids"]
    )
    assert result["tables"]["unified"][0]["rank"] == 1


# 找实体按基准过滤：没有字面命中时以向量第一名为基准，比它低超过差距的名字留在诊断里、标明原因，不参与找实体。
def test_entity_score_gap(graph):
    client, store, models, document_id = graph

    def run(gap):
        return graph_retrieve.retrieve(
            store,
            models,
            "段",
            store.readable_scope("alice"),
            {"graph_entity_score_gap": gap},
            entities=["段"],
        )

    strict = run(0)
    matches = strict["name_matches"]
    baseline = [match for match in matches if match["baseline"]]
    assert len(baseline) == 1 and baseline[0]["match"] == "vector"
    assert baseline[0]["kept"] and baseline[0]["gap"] == 0
    assert strict["name_baselines"][0]["name"] == baseline[0]["name"]
    dropped = [match for match in matches if not match["kept"]]
    assert dropped
    assert all(
        match["reason"] == f"比基准低 {match['gap']:.2f}，超过阈值 0.00"
        for match in dropped
    )
    loose = run(1)
    assert all(
        match["kept"] or "超过每个关键词" in match["reason"]
        for match in loose["name_matches"]
    )


# 每个实体最多留几条关系，多的标「超过每个实体 N 条」。
def test_entity_relation_limit(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {
            "graph_entity_relation_limit": 1,
            "graph_entity_min_score": 0,
        },
        entities=["段永平"],
    )
    # 每路最多一条，融合后最多两条；全局路径仍能补回实体路径没有的关系。
    assert len(result["entity_relations"]) <= 2
    assert result["relation_candidates"]
    assert all("fusion_rank" in row for row in result["entity_relations"])


# 实体路径的分数线：低于它的关系不算数，也不占「每个实体最多几条」的名额。
# 替身向量算出来的相似度量级比真实嵌入低一档，0.4 正好卡在两条关系中间（0.42 / 0.34）。
def test_entity_relation_threshold(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_entity_min_score": 0.4},
        entities=["段永平"],
    )
    # 向量分数线只作用于向量路径，关键词可以救回低向量分的关系。
    assert result["sources"]["unified"]
    assert all(item["relation_ids"] for item in result["sources"]["unified"])
    assert any(item.get("keyword_rank") for item in result["entity_relations"])
    assert result["settings"]["graph_entity_min_score"] == 0.4


# 范围写进查询条件：看不到这份文档的人什么都查不到（不是先查出来再过滤）；已删除的关系也查不到。
def test_scope_and_deleted_relations(graph):
    client, store, models, document_id = graph
    other = graph_retrieve.retrieve(
        store, models, "段永平", store.readable_scope("bob"), entities=["段永平"]
    )
    assert other["status"] == "skipped" and other["reason"] == "范围内没有建了图的文档"
    searches = store.graph_vectors.client.searches
    assert all("version_id in" in item["filter"] for item in searches)
    with store.engine.begin() as connection:
        connection.execute(
            update(graph_relations)
            .where(graph_relations.c.category == "创办")
            .values(status="deleted")
        )
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {},
        entities=["段永平"],
    )
    assert {item["target"] for item in result["entity_relations"]} == {"苹果公司"}


# 字面匹配：名字或模型给的标准名和关键词相同就命中；「阿段」的标准名是段永平，也算相同。
def test_literal_exact_match(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_entity_score_gap": 1},
        entities=["段永平"],
    )
    literal = {
        match["name"]: match
        for match in result["name_matches"]
        if match["match"] != "vector"
    }
    assert set(literal) == {"段永平", "阿段"}
    # 字面命中也算向量分数，不再固定 1.0；基准是字面命中里分数最高的那个。
    assert all(
        item["match"] == "exact" and item["kept"] and isinstance(item["score"], float)
        for item in literal.values()
    )
    best = max(literal.values(), key=lambda item: item["score"])
    assert best["baseline"] and result["name_baselines"][0]["match"] == "exact"
    assert "段永平" in [entity["name"] for entity in result["entities"]]
    # 字面命中过的名字不再从向量里重复列出。
    names = [(match["name"], match["entity_id"]) for match in result["name_matches"]]
    assert len(names) == len(set(names))


# 互相包含也算字面命中（「段永平先生」包含「段永平」）；单字不算包含，避免「段」把一堆名字都匹配上。
def test_literal_contains(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平先生",
        store.readable_scope("alice"),
        {"graph_entity_score_gap": 1},
        entities=["段永平先生"],
    )
    assert {
        match["name"]
        for match in result["name_matches"]
        if match["match"] == "contains"
    } == {"段永平", "阿段"}
    assert "段永平" in [entity["name"] for entity in result["entities"]]
    with store.engine.connect() as connection:
        version_ids = [
            row["version_id"]
            for row in graph_retrieve.scope_versions(
                store.engine, store.readable_scope("alice")
            )
        ]
        assert graph_retrieve.literal_names(connection, "段", version_ids) == []
        # 名字包含关键词的不算字面命中：「段永平」包含「永平」，但只有关键词包含名字才算。
        assert graph_retrieve.literal_names(connection, "永平", version_ids) == []


# 每个关键词最多留几个实体：字面命中的排最前，多的标原因。
def test_entity_top_k(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_entity_score_gap": 1, "graph_entity_top_k": 1},
        entities=["段永平"],
    )
    assert "段永平" in [entity["name"] for entity in result["entities"]]
    dropped = [match for match in result["name_matches"] if not match["kept"]]
    assert dropped and {match["reason"] for match in dropped} == {
        "超过每个关键词 1 个实体"
    }
    assert result["settings"]["graph_entity_top_k"] == 1


class KeywordModel:
    def __init__(self, reply):
        self.reply = reply
        self.messages = None

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.messages = messages
        return AIMessage(
            content=self.reply,
            usage_metadata={
                "input_tokens": 50,
                "output_tokens": 10,
                "total_tokens": 60,
            },
        )


# 没给关键词：用 graph_keywords 提取，记下提示词、原始输出和 token。
def test_keywords_from_model(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel(
        '<think>想一想</think>{"entities": ["段永平", "段永平"], "themes": ["投资经历"]}'
    )
    words = graph_retrieve.keywords(models, "段永平厉害吗")
    assert (
        words["source"] == "model"
        and words["entities"] == ["段永平"]
        and words["themes"] == []
    )
    assert words["input_tokens"] == 50 and words["prompt_tag"] == "graph_keywords@内置"
    assert json.loads(words["prompt"][1]["content"]) == {"question": "段永平厉害吗"}


# 提关键词时按的是哪个问题、来自哪条流程，诊断里要记下来：前端据此说明关键词的出处。
def test_keywords_records_question_source(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel('{"entities": ["段永平"], "themes": ["投资"]}')
    words = graph_retrieve.keywords(
        models, "段永平厉害吗", question_source="Agent 的检索词"
    )
    assert words["question"] == "段永平厉害吗"
    assert words["question_source"] == "Agent 的检索词"
    # 调用方自己给了关键词就不问模型；但问题照样记下来：实体的关系就是按它打分的。
    given = graph_retrieve.keywords(models, "段永平厉害吗", entities=["段永平"])
    assert given["source"] == "agent"
    assert given["question"] == "段永平厉害吗"
    assert "prompt" not in given


# 提取失败或什么都没提出来：用整个问题当具体关键词，并写明原因。
def test_keywords_fallback(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel('{"entities": [], "themes": []}')
    words = graph_retrieve.keywords(models, "你好")
    assert (
        words["entities"] == []
        and words["fallback"]
        and "没有提取到实体" in words["reason"]
    )
    models.chat_model = KeywordModel("不是 JSON")
    words = graph_retrieve.keywords(models, "段永平")
    assert (
        words["entities"] == [] and "实体提取失败" in words["reason"] and words["error"]
    )
    models.mode = "demo"
    words = graph_retrieve.keywords(models, "段永平")
    assert words["source"] == "fallback" and words["entities"] == []


# 接入混合检索：设置页打开图检索后，两张图排名表进入 RRF，候选记下通过哪些关系找到；诊断里有图检索明细和每一路耗时。
def test_search_tool_with_graph(graph, runtime):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    tool = DocumentSearchTool()
    runtime(graph_retrieval=False)
    off = tool.execute(store, models, "alice", ["段永平投资"], "段永平投资了什么")
    assert "graph" not in off["diagnostics"] and off["diagnostics"]["config"][
        "methods"
    ] == ["dense", "keyword"]
    runtime(
        graph_retrieval=True,
        graph_relation_min_score=0.3,
        graph_entity_min_score=0.3,
    )
    result = tool.execute(
        store,
        models,
        "alice",
        ["段永平投资"],
        "段永平投资了什么",
        graph_keywords={"entities": ["段永平"], "themes": ["投资"]},
    )
    diagnostics = result["diagnostics"]
    assert diagnostics["config"]["methods"] == ["dense", "keyword", "graph"]
    assert (
        diagnostics["graph"]["status"] == "ok" and "sources" not in diagnostics["graph"]
    )
    assert diagnostics["scope"]["graph_versions"][0]["document_id"] == document_id
    graph_lists = [item for item in diagnostics["lists"] if item["method"] == "graph"]
    assert [item["query"] for item in graph_lists] == ["图检索"]
    assert graph_lists[0]["hits"][0]["relation_ids"]
    with_graph = [
        row for row in diagnostics["candidates"] if "graph" in row["retrieval_methods"]
    ]
    assert with_graph and all(row["graph_relation_ids"] for row in with_graph)
    stats = result["stats"]
    assert (
        stats["graph_hits"] >= 1
        and stats["graph_ms"] is not None
        and "dense_ms" in stats
    )


# 图检索出错不影响向量、关键词两路，诊断里写明原因。
def test_search_tool_graph_failure(graph, runtime, monkeypatch):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    runtime(graph_retrieval=True)

    def broken(*args, **kwargs):
        raise RuntimeError("milvus down")

    monkeypatch.setattr(graph_retrieve, "retrieve", broken)
    result = DocumentSearchTool().execute(store, models, "alice", ["段永平"], "段永平")
    assert result["diagnostics"]["graph"]["status"] == "failed"
    assert "milvus down" in result["diagnostics"]["graph"]["reason"]
    assert result["stats"]["dense_hits"] > 0


# Agent：图检索对它透明。打开图检索后工具定义不变，hybrid 模式在工具内部多走一路图，关键词由图检索自己提取；
# keyword、vector 模式不走图。
def test_agent_search_knowledge_graph(graph, runtime):
    from app.agentic import tools as agent_tools

    client, store, models, document_id = graph
    ctx = agent_tools.AgentContext(store=store, models=models, owner="alice")
    runtime(graph_retrieval=False)
    before = agent_tools.tool_definitions(ctx)
    runtime(
        graph_retrieval=True,
        graph_relation_min_score=0.3,
        graph_entity_min_score=0.3,
    )
    assert agent_tools.tool_definitions(ctx) == before
    models.chat_model = KeywordModel('{"entities": ["段永平"], "themes": ["投资"]}')
    outcome = agent_tools.search_knowledge(ctx, "段永平投资了什么")
    graph_diag = outcome["trace"]["retrieval"]["diagnostics"]["graph"]
    assert graph_diag["status"] == "ok" and graph_diag["keywords"]["source"] == "model"
    assert json.loads(models.chat_model.messages[1].content) == {
        "question": "段永平投资了什么"
    }
    keyword_only = agent_tools.search_knowledge(ctx, "段永平", mode="keyword")
    assert "graph" not in keyword_only["trace"]["retrieval"]["diagnostics"]
    rejected = agent_tools.execute_tool(
        ctx, "search_knowledge", json.dumps({"query": "段永平", "entities": ["段永平"]})
    )
    assert rejected["ok"] is False and "entities" in rejected["content"]


# 同一个实体连到同一个另一端的关系只留相似度最高的一条，名额留给不同的另一端。
def test_entity_relations_dedupe_other_end(graph):
    from sqlalchemy import insert, select as sql_select

    client, store, models, document_id = graph
    with store.engine.begin() as connection:
        row = dict(
            connection.execute(
                sql_select(graph_relations).where(graph_relations.c.category == "创办")
            )
            .mappings()
            .first()
        )
        row.update(id="duplicate-relation", description="段永平又创办了步步高")
        connection.execute(insert(graph_relations).values(**row))
    from app.graph.vectors import index_version

    with store.engine.connect() as connection:
        version_id = connection.execute(sql_select(graph_relations.c.build_id)).scalar()
    index_version(store, models, version_id)
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_entity_min_score": 0},
        entities=["段永平"],
    )
    to_bbk = [
        item
        for item in result["entity_relations"]
        if item["entity_name"] == "段永平" and item["target"] == "步步高"
    ]
    # 另一条相同端点但不同事实不提前删掉，交给关系重排；关系 ID 才是去重依据。
    assert len(to_bbk) == 2
    assert all(row["kept"] for row in to_bbk)
    assert all(
        row["relation_id"]
        in {item["relation_id"] for item in result["relation_candidates"]}
        for row in to_bbk
    )


# 交给重排的候选分两份：其他路也找到的按 RRF 名次取前 pool_size 个；只被图找到的按图的名次取前
# graph_chunk_rerank_candidates 个，不和其他分片比 RRF 名次。上限为 0 时只被图找到的分片不进重排。
def test_graph_only_chunks_enter_rerank_by_graph_rank(graph, runtime):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    tool = DocumentSearchTool()
    keywords = {"entities": ["段永平"], "themes": ["投资"]}

    def run(limit):
        runtime(
            graph_retrieval=True,
            graph_relation_min_score=0.3,
            graph_entity_min_score=0.3,
            graph_chunk_rerank_candidates=limit,
        )
        return tool.execute(
            store,
            models,
            "alice",
            ["段永平投资"],
            "段永平投资了什么",
            pool_size=1,
            graph_keywords=keywords,
            # 测试语料很小，向量、关键词几乎能找到所有分片；只用图检索，所有分片都是只被图找到的。
            methods=("graph",),
        )

    def graph_only(item):
        return item["retrieval_methods"] == ["graph"]

    off = run(0)
    candidates = off["diagnostics"]["candidates"]
    # 上限为 0：只被图找到的分片一个都不进重排（候选池为空时没有重排，和重排失败一样按 RRF 顺序兜底）。
    assert not any(item["pool_via"] for item in candidates)
    assert off["diagnostics"]["config"]["graph_pool_size"] == 0
    assert off["diagnostics"]["config"]["graph_pool_count"] == 0
    on = run(5)
    candidates = on["diagnostics"]["candidates"]
    only = [item for item in candidates if graph_only(item)]
    assert only
    entered = [item for item in only if item["status"] != "not_in_pool"]
    # 按图的名次取前 5 个，标 pool_via = graph；不占 RRF 那一份。
    assert sorted(item["graph_only_rank"] for item in entered) == list(
        range(1, min(5, len(only)) + 1)
    )
    assert all(item["pool_via"] == "graph" for item in entered)
    assert not any(item["pool_via"] == "rrf" for item in candidates)
    config = on["diagnostics"]["config"]
    assert config["graph_pool_size"] == 5
    assert config["graph_pool_count"] == len(entered)


def test_relation_rerank_happens_before_chunk_selection(graph, monkeypatch):
    client, store, models, document_id = graph
    calls = []

    def rerank(question, texts):
        calls.append((question, texts))
        return [0.95 if "买入" in text else 0.1 for text in texts]

    monkeypatch.setattr(models, "rerank", rerank)
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平投资了什么",
        store.readable_scope("alice"),
        {
            "graph_entity_min_score": 0,
            "graph_relation_min_score": 0,
            "graph_relation_return_limit": 1,
        },
        entities=["段永平"],
    )
    assert len(calls) == 1
    assert all("→" in text for text in calls[0][1])
    kept = [row for row in result["relation_candidates"] if row["kept"]]
    assert len(kept) == 1 and kept[0]["target"] == "苹果公司"
    assert kept[0]["rerank_rank"] == 1 and kept[0]["rerank_score"] == 0.95
    assert all(
        kept[0]["relation_id"] in item["relation_ids"]
        for rows in result["sources"].values()
        for item in rows
    )
    assert all("原文" not in text for text in calls[0][1])


def test_existing_graph_gets_keyword_index_without_embeddings(graph, monkeypatch):
    from sqlalchemy import select
    from app.graph import vectors
    from app.mysql.tables import graph_versions

    client, store, models, document_id = graph
    with store.engine.begin() as connection:
        row = (
            connection.execute(select(graph_versions.c.id, graph_versions.c.summary))
            .mappings()
            .first()
        )
        summary = dict(row["summary"])
        summary.pop("relation_keyword_collection", None)
        connection.execute(
            update(graph_versions)
            .where(graph_versions.c.id == row["id"])
            .values(summary=summary)
        )
    monkeypatch.setattr(
        models,
        "embed",
        lambda *args: (_ for _ in ()).throw(AssertionError("不应重算向量")),
    )
    vectors.ensure_keyword_versions(store, models, [row["id"]])
    assert store.graph_vectors.search_relation_keywords("苹果", [row["id"]], 10)
    # 新的进程使用同一持久标记，不再次写索引。
    monkeypatch.setattr(
        store.graph_vectors,
        "upsert_relation_keywords",
        lambda *args: (_ for _ in ()).throw(AssertionError("不应重复补索引")),
    )
    vectors.ensure_keyword_versions(store, models, [row["id"]])


def test_global_relations_work_without_extracted_entities(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel('{"entities": []}')
    result = graph_retrieve.retrieve(
        store,
        models,
        "苹果投资",
        store.readable_scope("alice"),
        {"graph_relation_min_score": 0},
    )
    assert result["entities"] == [] and result["entity_relations"] == []
    assert result["relation_matches"] and result["sources"]["unified"]
    assert result["keywords"]["themes"] == []


def test_graph_chunk_pool_is_separate_from_rrf_pool(graph, runtime):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    runtime(
        graph_retrieval=True,
        rerank_candidates=12,
        graph_chunk_rerank_candidates=60,
        return_limit=6,
    )
    result = DocumentSearchTool().execute(
        store,
        models,
        "alice",
        ["段永平"],
        "段永平投资了什么",
        graph_keywords={"entities": ["段永平"]},
    )
    # 开了图检索也不再抬高 RRF 那一份候选；只被图找到的分片另有上限。
    assert result["diagnostics"]["config"]["rerank_candidates"] == 12
    assert result["diagnostics"]["config"]["graph_pool_size"] == 60
    assert result["diagnostics"]["config"]["return_limit"] == 6


def test_graph_hybrid_settings_persist_and_validate(graph):
    from test_app import headers

    client, store, models, document_id = graph
    changes = {
        "graph_entity_relation_quota": 5,
        "graph_global_relation_quota": 10,
        "graph_relation_rerank_candidates": 80,
        "graph_relation_return_limit": 25,
        "graph_chunk_rerank_candidates": 60,
    }
    response = client.put(
        "/settings/runtime", headers=headers("admin"), json={"changes": changes}
    )
    assert response.status_code == 200
    saved = {item["key"]: item for item in response.json()["items"]}
    assert all(saved[key]["value"] == value for key, value in changes.items())
    invalid = client.put(
        "/settings/runtime",
        headers=headers("admin"),
        json={"changes": {"graph_relation_return_limit": 81}},
    )
    assert invalid.status_code == 422


def test_all_candidates_and_original_chunks_are_saved(graph, monkeypatch):
    from sqlalchemy import insert, select
    from app.graph.vectors import index_version

    client, store, models, document_id = graph
    with store.engine.begin() as connection:
        original = dict(connection.execute(select(graph_relations)).mappings().first())
        connection.execute(
            insert(graph_relations),
            [
                {
                    **original,
                    "id": f"candidate-{i}",
                    "description": f"段永平投资公司{i}",
                }
                for i in range(188)
            ],
        )
    index_version(store, models, original["build_id"])
    monkeypatch.setattr(models, "rerank", lambda question, texts: [0.9] * len(texts))
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平投资哪些公司",
        store.readable_scope("alice"),
        {
            "graph_entity_relation_limit": 300,
            "graph_relation_top_k": 300,
            "graph_entity_min_score": 0,
            "graph_relation_min_score": 0,
        },
        entities=["段永平"],
    )
    assert result["relation_candidate_counts"] == {
        "total": 190,
        "in_pool": 100,
        "kept": 30,
    }
    assert len(result["relation_candidates"]) == 190
    assert result["dropped_more"]["relation_candidates"] == 0
    originals = {row["chunk_id"]: row for row in result["candidate_chunks"]}
    assert all(row["chunk_id"] in originals for row in result["relation_candidates"])
    assert all(row["text"] for row in originals.values())


def test_unified_graph_chunks_have_one_rrf_contribution(graph, runtime):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    runtime(graph_retrieval=True, graph_entity_min_score=0, graph_relation_min_score=0)
    result = DocumentSearchTool().execute(
        store,
        models,
        "alice",
        ["段永平投资"],
        "段永平投资哪些公司",
        graph_keywords={"entities": ["段永平"]},
    )
    diagnostics = result["diagnostics"]
    lists = [row for row in diagnostics["lists"] if row["method"] == "graph"]
    assert len(lists) == 1 and lists[0]["table"] == "unified"
    chunks = diagnostics["graph"]["tables"]["unified"]
    assert chunks and len({row["chunk_id"] for row in chunks}) == len(chunks)
    for candidate in diagnostics["candidates"]:
        contributions = [
            row for row in candidate["contributions"] if row["method"] == "graph"
        ]
        assert len(contributions) <= 1
    assert len(lists[0]["hits"]) == diagnostics["graph"]["counts"]["chunks"]


def test_entity_disambiguation_uses_full_question(graph):
    import math

    _, store, models, _ = graph
    question = "段永平投资苹果公司"
    result = graph_retrieve.retrieve(
        store,
        models,
        question,
        store.readable_scope("alice"),
        {"graph_entity_score_gap": 1},
        entities=["段永平"],
    )
    assert result["name_score_query"] == question
    query = char_embed([question])[0]
    matches = result["name_matches"]
    assert matches
    for match in matches:
        text = char_embed([match["vector_text"]])[0]
        expected = sum(a * b for a, b in zip(query, text)) / math.sqrt(
            sum(a * a for a in query) * sum(b * b for b in text)
        )
        assert match["score"] == pytest.approx(expected, abs=0.0001)
    assert any(abs(m["score"] - m["keyword_score"]) > 0.01 for m in matches)
