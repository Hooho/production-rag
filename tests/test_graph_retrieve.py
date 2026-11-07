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
    store.graph_vectors = GraphVectorStore(FakeGraphClient(), models.collection, len(CHARS) + 1)
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    return client, store, models, document_id


# Agent 给了关键词：不调用模型；具体关键词找到实体「段永平」（阿段归在它下面），一跳取它的两条关系；
# 概括关键词「投资」找到投资那条关系；两张排名表都是出处分片。
def test_retrieve_with_given_keywords(graph):
    client, store, models, document_id = graph
    scope = store.readable_scope("alice")
    result = graph_retrieve.retrieve(store, models, "段永平投资了什么", scope,
        {"graph_name_min_score": 0.3, "graph_relation_min_score": 0.3}, entities=["段永平"], themes=["投资"])
    assert result["status"] == "ok"
    assert result["keywords"]["source"] == "agent" and result["keywords"]["entities"] == ["段永平"]
    assert [item["document_id"] for item in result["scope"]] == [document_id]
    assert [entity["name"] for entity in result["entities"]] == ["段永平"]
    kept_names = {match["name"] for match in result["name_matches"] if match["kept"]}
    assert "段永平" in kept_names
    relations = {(item["source"], item["target"]) for item in result["entity_relations"] if item["kept"]}
    assert relations == {("段永平", "步步高"), ("阿段", "苹果公司")}
    top = result["relation_matches"][0]
    assert (top["source"], top["target"], top["keyword"]) == ("阿段", "苹果公司", "投资")
    assert top["source_entity"] == "段永平" and top["also_entity"] is True
    assert result["sources"]["entity"] and result["sources"]["relation"]
    first = result["sources"]["entity"][0]
    assert first["document_id"] == document_id and first["text"] and first["relation_ids"]
    assert result["tables"]["entity"][0]["rank"] == 1


# 低于阈值的名字留在诊断里，标明原因，不参与找实体。
def test_name_threshold(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(store, models, "段", store.readable_scope("alice"),
        {"graph_name_min_score": 0.6}, entities=["段"])
    assert result["entities"] == [] and result["entity_relations"] == []
    assert result["name_matches"] and not any(match["kept"] for match in result["name_matches"])
    assert {match["reason"] for match in result["name_matches"]} == {"相似度低于 0.6"}


# 每个实体最多留几条关系，多的标「超过每个实体 N 条」。
def test_entity_relation_limit(graph):
    client, store, models, document_id = graph
    result = graph_retrieve.retrieve(store, models, "段永平", store.readable_scope("alice"),
        {"graph_name_min_score": 0.3, "graph_entity_relation_limit": 1}, entities=["段永平"])
    kept = [item for item in result["entity_relations"] if item["kept"]]
    dropped = [item for item in result["entity_relations"] if not item["kept"]]
    assert len(kept) == 1 and len(dropped) == 1 and dropped[0]["reason"] == "超过每个实体 1 条"


# 范围写进查询条件：看不到这份文档的人什么都查不到（不是先查出来再过滤）；已删除的关系也查不到。
def test_scope_and_deleted_relations(graph):
    client, store, models, document_id = graph
    other = graph_retrieve.retrieve(store, models, "段永平", store.readable_scope("bob"), entities=["段永平"])
    assert other["status"] == "skipped" and other["reason"] == "范围内没有建了图的文档"
    searches = store.graph_vectors.client.searches
    assert all("version_id in" in item["filter"] for item in searches)
    with store.engine.begin() as connection:
        connection.execute(update(graph_relations).where(graph_relations.c.category == "创办").values(status="deleted"))
    result = graph_retrieve.retrieve(store, models, "段永平", store.readable_scope("alice"),
        {"graph_name_min_score": 0.3}, entities=["段永平"])
    assert {item["target"] for item in result["entity_relations"]} == {"苹果公司"}


class KeywordModel:
    def __init__(self, reply):
        self.reply = reply
        self.messages = None

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.messages = messages
        return AIMessage(content=self.reply, usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60})


# 没给关键词：用 graph_keywords 提取，记下提示词、原始输出和 token。
def test_keywords_from_model(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel('<think>想一想</think>{"entities": ["段永平", "段永平"], "themes": ["投资经历"]}')
    words = graph_retrieve.keywords(models, "段永平厉害吗")
    assert words["source"] == "model" and words["entities"] == ["段永平"] and words["themes"] == ["投资经历"]
    assert words["input_tokens"] == 50 and words["prompt_tag"] == "graph_keywords@内置"
    assert json.loads(words["prompt"][1]["content"]) == {"question": "段永平厉害吗"}


# 提取失败或什么都没提出来：用整个问题当具体关键词，并写明原因。
def test_keywords_fallback(graph):
    client, store, models, document_id = graph
    models.chat_model = KeywordModel('{"entities": [], "themes": []}')
    words = graph_retrieve.keywords(models, "你好")
    assert words["entities"] == ["你好"] and words["fallback"] and "没有提出关键词" in words["reason"]
    models.chat_model = KeywordModel("不是 JSON")
    words = graph_retrieve.keywords(models, "段永平")
    assert words["entities"] == ["段永平"] and "提关键词失败" in words["reason"] and words["error"]
    models.mode = "demo"
    words = graph_retrieve.keywords(models, "段永平")
    assert words["source"] == "fallback" and words["entities"] == ["段永平"]
