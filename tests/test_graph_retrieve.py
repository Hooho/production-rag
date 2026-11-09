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
            "graph_name_min_score": 0.3,
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
    assert [entity["name"] for entity in result["entities"]] == ["段永平"]
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
    top = result["relation_matches"][0]
    assert (top["source"], top["target"], top["keyword"]) == (
        "阿段",
        "苹果公司",
        "投资",
    )
    assert top["source_entity"] == "段永平" and top["also_entity"] is True
    assert result["sources"]["entity"] and result["sources"]["relation"]
    first = result["sources"]["entity"][0]
    assert (
        first["document_id"] == document_id and first["text"] and first["relation_ids"]
    )
    assert result["tables"]["entity"][0]["rank"] == 1


# 低于阈值的名字留在诊断里，标明原因，不参与找实体。
def test_name_threshold(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段",
        store.readable_scope("alice"),
        {"graph_name_min_score": 0.6},
        entities=["段"],
    )
    assert result["entities"] == [] and result["entity_relations"] == []
    assert result["name_matches"] and not any(
        match["kept"] for match in result["name_matches"]
    )
    assert {match["reason"] for match in result["name_matches"]} == {"相似度低于 0.6"}


# 每个实体最多留几条关系，多的标「超过每个实体 N 条」。
def test_entity_relation_limit(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {
            "graph_name_min_score": 0.3,
            "graph_entity_relation_limit": 1,
            "graph_entity_min_score": 0,
        },
        entities=["段永平"],
    )
    kept = [item for item in result["entity_relations"] if item["kept"]]
    dropped = [item for item in result["entity_relations"] if not item["kept"]]
    assert (
        len(kept) == 1
        and len(dropped) == 1
        and dropped[0]["reason"] == "超过每个实体 1 条"
    )


# 实体路径的分数线：低于它的关系不算数，也不占「每个实体最多几条」的名额。
# 替身向量算出来的相似度量级比真实嵌入低一档，0.4 正好卡在两条关系中间（0.42 / 0.34）。
def test_entity_relation_threshold(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_name_min_score": 0.3, "graph_entity_min_score": 0.4},
        entities=["段永平"],
    )
    kept = [item for item in result["entity_relations"] if item["kept"]]
    dropped = [item for item in result["entity_relations"] if not item["kept"]]
    assert [(item["source"], item["target"]) for item in kept] == [("段永平", "步步高")]
    assert [item["reason"] for item in dropped] == ["相似度低于 0.4"]
    # 被拦下的关系不占名额，出处分片只留留下的那条。
    assert result["sources"]["entity"]
    assert all(item["relation_ids"] for item in result["sources"]["entity"])
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
        {"graph_name_min_score": 0.3},
        entities=["段永平"],
    )
    assert {item["target"] for item in result["entity_relations"]} == {"苹果公司"}


# 字面匹配：名字或模型给的标准名和关键词相同就直接命中，不看向量阈值；「阿段」的标准名是段永平，也算相同。
def test_literal_exact_match(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_name_min_score": 0.99},
        entities=["段永平"],
    )
    literal = {
        match["name"]: match
        for match in result["name_matches"]
        if match["match"] != "vector"
    }
    assert set(literal) == {"段永平", "阿段"}
    assert all(
        item["match"] == "exact" and item["kept"] and item["score"] == 1.0
        for item in literal.values()
    )
    assert [entity["name"] for entity in result["entities"]] == ["段永平"]
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
        {"graph_name_min_score": 0.99},
        entities=["段永平先生"],
    )
    assert {
        match["name"]
        for match in result["name_matches"]
        if match["match"] == "contains"
    } == {"段永平", "阿段"}
    assert [entity["name"] for entity in result["entities"]] == ["段永平"]
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
        {"graph_name_min_score": 0, "graph_entity_top_k": 1},
        entities=["段永平"],
    )
    assert [entity["name"] for entity in result["entities"]] == ["段永平"]
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
        and words["themes"] == ["投资经历"]
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
        words["entities"] == ["你好"]
        and words["fallback"]
        and "没有提出关键词" in words["reason"]
    )
    models.chat_model = KeywordModel("不是 JSON")
    words = graph_retrieve.keywords(models, "段永平")
    assert (
        words["entities"] == ["段永平"]
        and "提关键词失败" in words["reason"]
        and words["error"]
    )
    models.mode = "demo"
    words = graph_retrieve.keywords(models, "段永平")
    assert words["source"] == "fallback" and words["entities"] == ["段永平"]


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
        graph_name_min_score=0.3,
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
    assert [item["query"] for item in graph_lists] == ["图 · 实体", "图 · 关系"]
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
        graph_name_min_score=0.3,
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
    result = graph_retrieve.retrieve(
        store,
        models,
        "段永平",
        store.readable_scope("alice"),
        {"graph_name_min_score": 0.3, "graph_entity_min_score": 0},
        entities=["段永平"],
    )
    to_bbk = [
        item
        for item in result["entity_relations"]
        if item["entity_name"] == "段永平" and item["target"] == "步步高"
    ]
    assert len(to_bbk) == 2
    assert sorted(item["kept"] for item in to_bbk) == [False, True]
    assert [item["reason"] for item in to_bbk if not item["kept"]] == [
        "和前面一条连到同一个实体"
    ]


# 图检索名额：RRF 名次不够进候选池时，按图排名表的名次补进来交给重排，诊断里标出来；名额为 0 时不补。
def test_graph_rerank_quota(graph, runtime):
    from app.tools.search import DocumentSearchTool

    client, store, models, document_id = graph
    tool = DocumentSearchTool()
    keywords = {"entities": ["段永平"], "themes": ["投资"]}
    runtime(
        graph_retrieval=True,
        graph_name_min_score=0.3,
        graph_relation_min_score=0.3,
        graph_entity_min_score=0.3,
        graph_rerank_quota=0,
    )
    off = tool.execute(
        store,
        models,
        "alice",
        ["段永平投资"],
        "段永平投资了什么",
        pool_size=1,
        graph_keywords=keywords,
    )
    assert not any(item["graph_quota"] for item in off["diagnostics"]["candidates"])
    assert off["diagnostics"]["config"]["graph_rerank_quota"] == 0
    runtime(
        graph_retrieval=True,
        graph_name_min_score=0.3,
        graph_relation_min_score=0.3,
        graph_entity_min_score=0.3,
        graph_rerank_quota=5,
    )
    on = tool.execute(
        store,
        models,
        "alice",
        ["段永平投资"],
        "段永平投资了什么",
        pool_size=1,
        graph_keywords=keywords,
    )
    candidates = on["diagnostics"]["candidates"]
    graph_items = [item for item in candidates if "graph" in item["retrieval_methods"]]
    # 图带回的分片全部进了重排（不再是 not_in_pool），靠名额进来的标 graph_quota。
    assert graph_items and all(item["status"] != "not_in_pool" for item in graph_items)
    assert any(item["graph_quota"] for item in graph_items)
    assert all(item["rrf_rank"] > 1 for item in candidates if item["graph_quota"])
    assert on["diagnostics"]["config"]["graph_rerank_quota"] == 5
