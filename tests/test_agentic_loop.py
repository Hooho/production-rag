import json

import httpx

from app.agentic.llm import is_minimax, parse_message
from app.agentic.loop import run_agent
from app.agentic.messages import initial_messages
from app.agentic.tools import AgentContext
from app.models import CITATION_REJECTED
from test_agentic_tools import KnowledgeStore, RerankOff


# 假模型：按顺序返回预先写好的响应，并记下每次收到的消息和 tools，供断言检查。
class ScriptedModel:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, messages, tools):
        self.calls.append({"messages": json.loads(json.dumps(messages)), "tools": tools})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return json.dumps(item, ensure_ascii=False), item


def reply(content="", calls=None, reasoning=None):
    message = {"role": "assistant", "content": content}
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    if calls:
        message["tool_calls"] = calls
    return {"id": "x", "object": "chat.completion", "choices": [{"index": 0, "message": message,
        "finish_reason": "tool_calls" if calls else "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 80}}}


def tool_call(call_id, name, **arguments):
    return {"id": call_id, "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Orders:
    def execute(self, store, owner, order_id):
        if order_id == "BOOM":
            raise RuntimeError("数据库连接断开")
        return {"answer": f"订单 {order_id}：已发货；预计 明天。", "order_id": order_id}


# 这些测试不涉及业务数据：替身用户没有任何数据权限，工具列表里没有 query_data。
class NoData:
    @staticmethod
    def load_access(store, owner):
        return [], {}


CONFIG = {"agent_tool_budget": 6, "agent_timeout": 90}


def context():
    return AgentContext(store=KnowledgeStore(), models=RerankOff(), owner="alice", order_tool=Orders(), data_tool=NoData())


def start(question="A1001 到哪了？没签收能退吗？"):
    return [{"role": "system", "content": "系统"}, {"role": "user", "content": question}]


# 正常流程：先调用工具，拿到资料后回答；工具结果和推理过程都原样放回消息，下一轮模型能看到。
def test_loop_calls_tools_then_answers(runtime):
    runtime(parent_context=False)
    model = ScriptedModel(
        reply(calls=[tool_call("c1", "lookup_order", order_id="A1001"),
            tool_call("c2", "search_knowledge", query="退货需要什么条件？", mode="vector")], reasoning="先查订单和退货规则"),
        reply("<think>资料够了</think>订单已发货 [O1]，签收后可以申请退货 [S1]。"))
    result = run_agent(context(), start(), model, CONFIG)
    assert result["status"] == "completed" and result["stop_reason"] == "answered"
    assert result["answer"] == "订单已发货 [O1]，签收后可以申请退货 [S1]。"
    assert result["tool_calls_used"] == 2 and result["citation"]["passed"]
    first, second = result["rounds"]
    assert first["reasoning"] == "先查订单和退货规则" and first["cached_tokens"] == 80
    assert [item["status"] for item in first["tool_results"]] == ["ok", "ok"]
    assert first["tool_results"][0]["content"].endswith("剩余预算：还能调用 5 次工具。")
    # 第 2 轮只记新增的 3 条：assistant（带推理过程，交错思考要原样传回）和两条 tool。
    assert [message["role"] for message in second["new_messages"]] == ["assistant", "tool", "tool"]
    assert second["new_messages"][0]["reasoning_content"] == "先查订单和退货规则"
    assert second["reasoning"] == "资料够了"
    assert model.calls[1]["tools"] == model.calls[0]["tools"]
    assert [source["id"] for source in result["sources"]] == ["S1", "S2", "O1"]
    assert result["sources"][2]["title"] == "订单 A1001"
    assert result["usage"] == {"prompt_tokens": 200, "completion_tokens": 40, "cached_tokens": 160}


# 预算用完后最后一轮不带 tools，并告诉模型直接回答；同一轮超出预算的调用不执行。
def test_budget_forces_final_answer(runtime):
    runtime(parent_context=False)
    model = ScriptedModel(
        reply(calls=[tool_call("c1", "lookup_order", order_id="A1001"), tool_call("c2", "lookup_order", order_id="A1002"),
            tool_call("c3", "lookup_order", order_id="A1003")]),
        reply("两个订单都已发货 [O1][O2]。"))
    result = run_agent(context(), start(), model, {"agent_tool_budget": 2, "agent_timeout": 90})
    assert [item["status"] for item in result["rounds"][0]["tool_results"]] == ["ok", "ok", "skipped"]
    final = result["rounds"][1]
    assert final["kind"] == "forced" and final["tools_sent"] == [] and model.calls[1]["tools"] is None
    assert "工具调用次数已经用完" in model.calls[1]["messages"][-1]["content"]
    assert result["stop_reason"] == "budget" and result["answer"] == "两个订单都已发货 [O1][O2]。"


# 完全相同的调用（参数顺序不同也算）只执行一次，不占预算。
def test_duplicate_call_is_blocked(runtime):
    runtime(parent_context=False)
    model = ScriptedModel(
        reply(calls=[tool_call("c1", "search_knowledge", query="退货需要什么条件？", mode="vector")]),
        reply(calls=[{"id": "c2", "type": "function", "function": {"name": "search_knowledge",
            "arguments": '{"mode": "vector", "query": "退货需要什么条件？"}'}}]),
        reply("签收后七天内可以退货 [S1]。"))
    result = run_agent(context(), start(), model, CONFIG)
    duplicate = result["rounds"][1]["tool_results"][0]
    assert duplicate["status"] == "duplicate" and "和第 1 轮的调用完全相同" in duplicate["content"]
    assert result["tool_calls_used"] == 1


# 超过整体超时后，下一轮开始前进入强制回答。
def test_timeout_forces_final_answer(runtime):
    runtime(parent_context=False)
    clock = Clock()

    class SlowModel(ScriptedModel):
        def __call__(self, messages, tools):
            clock.now += 100
            return super().__call__(messages, tools)

    model = SlowModel(reply(calls=[tool_call("c1", "lookup_order", order_id="A1001")]), reply("已发货 [O1]。"))
    result = run_agent(context(), start(), model, CONFIG, clock=clock)
    assert result["stop_reason"] == "timeout" and result["rounds"][1]["kind"] == "forced"
    assert "处理时间已经到上限" in model.calls[1]["messages"][-1]["content"]


# 引用了不存在的编号：把问题告诉模型重写一次，重写这一轮单独记录，不带 tools。
def test_citation_retry_succeeds(runtime):
    runtime(parent_context=False)
    model = ScriptedModel(reply(calls=[tool_call("c1", "lookup_order", order_id="A1001")]),
        reply("已发货 [O1]，可以退货 [S3]。"), reply("已发货 [O1]。退货规则资料里没有。"))
    result = run_agent(context(), start(), model, CONFIG)
    kinds = [record["kind"] for record in result["rounds"]]
    assert kinds == ["normal", "normal", "citation_retry"]
    failed = result["rounds"][1]
    assert failed["citation_check"]["unknown"] == ["S3"] and "可以引用的编号只有：O1" in failed["citation_fix_prompt"]
    assert model.calls[2]["tools"] is None and model.calls[2]["messages"][-1]["content"] == failed["citation_fix_prompt"]
    assert result["answer"] == "已发货 [O1]。退货规则资料里没有。" and result["citation_retried"]


def test_citation_retry_fails(runtime):
    runtime(parent_context=False)
    model = ScriptedModel(reply(calls=[tool_call("c1", "lookup_order", order_id="A1001")]),
        reply("已经发货了。"), reply("已经发货了，放心。"))
    result = run_agent(context(), start(), model, CONFIG)
    assert result["answer"] == CITATION_REJECTED
    assert result["citation"]["reason"] == "no_citation" and result["citation"]["raw_answer"] == "已经发货了，放心。"


# 问候不调用工具，资料池为空，不做引用检查。
def test_greeting_skips_citation_check():
    model = ScriptedModel(reply("你好，有什么可以帮你？"))
    result = run_agent(context(), start("你好"), model, CONFIG)
    assert result["answer"] == "你好，有什么可以帮你？" and result["citation"] is None
    assert len(result["rounds"]) == 1 and len(model.calls[0]["tools"]) == 3


# 工具内部异常不打断循环；模型调用重试后仍失败时整次标记失败，已跑的轮次照样返回。
def test_tool_error_and_model_failure():
    model = ScriptedModel(reply(calls=[tool_call("c1", "lookup_order", order_id="BOOM")]),
        httpx.ConnectError("connection refused"))
    result = run_agent(context(), start(), model, CONFIG)
    first = result["rounds"][0]["tool_results"][0]
    assert first["status"] == "error" and first["content"].startswith("工具执行失败：数据库连接断开")
    assert result["status"] == "failed" and result["stop_reason"] == "model_error"
    assert len(result["rounds"]) == 2 and "connection refused" in result["rounds"][1]["error"]


# 第一轮消息的摆放：system 在前，历史问答在中间，会变的记忆和本轮问题在最后一条。
def test_initial_messages_layout():
    previous = [{"question": "退货政策是什么", "response": {"answer": "签收后七天内可以退货 [S1]。"}},
        {"question": "被拦截的问题", "response": {}}]
    messages = initial_messages("那 A1001 能退吗", previous, profile=[{"content": "用户偏好先给结论"}],
        summary="尚未生成", last_order="A1001")
    assert [message["role"] for message in messages] == ["system", "user", "assistant", "user"]
    assert "今天是 " in messages[0]["content"] and "[O1]" in messages[0]["content"]
    assert messages[-1]["content"] == ("<memory>\n## 用户偏好\n- 用户偏好先给结论\n## 最近查过的订单\nA1001\n</memory>\n"
        "本轮问题：那 A1001 能退吗")
    assert initial_messages("你好")[-1] == {"role": "user", "content": "你好"}


def test_parse_message_and_provider():
    parsed = parse_message(reply("答案 [S1]", reasoning="想一想"))
    assert parsed["content"] == "答案 [S1]" and parsed["reasoning"] == "想一想"
    assert parsed["message"]["reasoning_content"] == "想一想"
    unclosed = parse_message(reply("<think>还没想完"))
    assert unclosed["content"] == "" and unclosed["reasoning"] == "还没想完"

    class Settings:
        llm_provider = "custom"
        llm_base_url = "https://api.minimaxi.com/v1"

    assert is_minimax(Settings())


# 真实调用的参数：MiniMax 才加 reasoning_split；强制回答轮不带 tools；返回原始响应文本和解析结果。
def test_chat_client_params():
    from app.agentic.llm import ChatClient

    class Settings:
        llm_provider = "minimax"
        llm_base_url = "https://api.minimaxi.com/v1"
        llm_api_key = "test-key"
        llm_model = "MiniMax-M3"

    sent = []

    class Raw:
        text = json.dumps(reply("好的"))

    class Completions:
        class with_raw_response:
            @staticmethod
            def create(**params):
                sent.append(params)
                return Raw()

    client = ChatClient(Settings())
    client.client = type("Client", (), {"chat": type("Chat", (), {"completions": Completions})})()
    raw, response = client([{"role": "user", "content": "你好"}], None)
    assert response["choices"][0]["message"]["content"] == "好的" and raw == Raw.text
    assert "tools" not in sent[0] and sent[0]["extra_body"] == {"reasoning_split": True}
    Settings.llm_provider = "deepseek"
    Settings.llm_base_url = "https://api.deepseek.com"
    ChatClient.__call__(type("C", (), {"models": Settings(), "client": client.client})(), [], [{"type": "function"}])
    assert "extra_body" not in sent[1] and sent[1]["tools"] == [{"type": "function"}]
