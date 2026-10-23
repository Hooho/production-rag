import json

from app.agentic.tools import AgentContext, execute_tool, tool_definitions
from test_app import headers, setup  # noqa: F401  setup 是 pytest fixture
from test_data import create, grant, seed


class RerankOff:
    def rerank(self, query, documents):
        return None


# 知识库替身：两路召回都返回固定结果，分片带文档 id 和位置，供 read_context 读取前后文。
class KnowledgeStore:
    def __init__(self):
        self.chunks = []
        for position in range(6):
            self.chunks.append({"id": f"c{position}", "position": position, "chunk_metadata": {},
                "content": f"第{position}段", "text": f"第{position}段"})

    def search(self, owner, query, models, limit):
        hits = {"退货": ["c2", "c4"], "换货": ["c4"]}
        result = []
        for chunk_id in hits.get(query[:2], []):
            position = int(chunk_id[1:])
            result.append({"id": chunk_id, "title": "售后制度", "text": f"第{position}段", "score": 0.9,
                "document_id": 7, "position": position})
        return result

    def search_keyword(self, owner, query, limit):
        return []

    def neighbor_chunks(self, document_id, position, radius):
        return [row for row in self.chunks if abs(row["position"] - position) <= radius]


def knowledge_context():
    return AgentContext(store=KnowledgeStore(), models=RerankOff(), owner="alice")


def call(ctx, name, **arguments):
    return execute_tool(ctx, name, json.dumps(arguments, ensure_ascii=False))


# 多次检索的资料在整次问答内连续编号；同一分片再次命中时沿用原编号，不重复把正文给模型。
def test_search_numbers_evidence_across_calls(monkeypatch, runtime):
    runtime(parent_context=False)
    ctx = knowledge_context()
    first = call(ctx, "search_knowledge", query="退货需要什么条件？", mode="vector")
    assert first["ok"]
    assert first["trace"]["evidence_ids"] == ["S1", "S2"]
    assert first["content"].startswith("[S1] 《售后制度》\n第2段")
    second = call(ctx, "search_knowledge", query="换货需要什么条件？", mode="vector")
    assert second["trace"]["evidence_ids"] == ["S2"]
    assert "和前面返回的 S2 是同一段资料" in second["content"]
    # 返回的全是前面给过的资料：开头明确说这次没有新资料。
    assert second["content"].startswith("这次检索没有新资料：返回的 S2 前面都已经给过。") and second["trace"]["no_new"] is True
    assert first["trace"]["no_new"] is False
    limited = call(ctx, "search_knowledge", query="退货流程是什么？", mode="vector", top_k=1)
    assert limited["trace"]["evidence_ids"] == ["S1"]
    assert call(ctx, "search_knowledge", query="其他问题", mode="vector")["content"].startswith("没有找到相关资料")


def test_search_rejects_bad_arguments():
    ctx = knowledge_context()
    assert call(ctx, "search_knowledge", query=" ")["content"] == "参数错误：query 不能为空"
    assert "mode 只能是" in call(ctx, "search_knowledge", query="退货", mode="fuzzy")["content"]
    assert "参数不正确" in call(ctx, "search_knowledge", text="退货")["content"]
    assert "没有名为 search 的工具" in call(ctx, "search")["content"]
    assert "不是合法的 JSON" in execute_tool(ctx, "search_knowledge", "{query:")["content"]


# 只能读已检索到的资料的前后文；连续读后文时从上次读到的位置继续。
def test_read_context_follows_evidence(runtime):
    runtime(parent_context=False)
    ctx = knowledge_context()
    call(ctx, "search_knowledge", query="退货需要什么条件？", mode="vector")
    after = call(ctx, "read_context", source_id="S1", direction="after", count=1)
    assert after["content"] == "[S1 后文] 《售后制度》\n第3段"
    again = call(ctx, "read_context", source_id="S1", direction="after", count=2)
    assert again["trace"]["positions"] == [4, 5]
    before = call(ctx, "read_context", source_id="S1", direction="before", count=3)
    assert before["trace"]["positions"] == [0, 1]
    assert "已经到文档开头" in call(ctx, "read_context", source_id="S1", direction="before")["content"]
    assert not call(ctx, "read_context", source_id="S9", direction="after")["ok"]


# 订单和业务数据沿用原工具的权限检查。
def test_order_and_data_follow_permissions(setup):
    client, store = setup
    alice = AgentContext(store=store, models=None, owner="alice")
    assert call(alice, "lookup_order", order_id="a1001")["content"] == "[O1] 订单 A1001：已发货；预计 明天。"
    assert not call(alice, "lookup_order", order_id="B2001")["trace"]["found"]

    _, _, order = seed(client)
    create(client, "shipments", {"order_id": order, "carrier": "顺丰", "tracking_no": "SF123",
        "shipped_at": "2026-09-28"})
    admin = AgentContext(store=store, models=None, owner="admin")
    found = call(admin, "query_data", data_type="shipments",
        filters=[{"field": "order_id", "op": "eq", "value": order}])
    assert found["ok"] and found["content"].startswith("[D1] ") and "SF123" in found["content"]
    assert found["trace"]["plan"]["data_type"] == "shipments"
    wrong = call(admin, "query_data", data_type="shipments",
        filters=[{"field": "sign_date", "op": "eq", "value": "2026-09-30"}])
    assert not wrong["ok"] and wrong["content"].startswith("查询失败：")
    broken = call(admin, "query_data", data_type="shipments", filters=["order_id = A1001"])
    assert not broken["ok"]
    assert "还没有任何业务数据的查看权限" in call(alice, "query_data", data_type="shipments")["content"]
    grant(client, "alice", "service", "orders", read=True)
    assert "没有查看物流单的权限" in call(alice, "query_data", data_type="shipments")["content"]


# query_data 的工具描述按用户权限生成：没有任何数据权限时不提供该工具，敏感字段不出现在数据字典里。
def test_tool_definitions_follow_permissions(setup):
    client, store = setup
    names = [tool["function"]["name"] for tool in tool_definitions(AgentContext(store=store, models=None, owner="alice"))]
    assert names == ["search_knowledge", "read_context", "lookup_order"]
    tools = tool_definitions(AgentContext(store=store, models=None, owner="admin"))
    data = next(tool for tool in tools if tool["function"]["name"] == "query_data")["function"]
    assert "delivered_at" in data["description"]
    assert '"phone"' not in data["description"]
    assert "shipments" in data["parameters"]["properties"]["data_type"]["enum"]
