from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.agent.response import ResponseAgent
from app.models import Models


def response_agent(monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    models = Models()
    # 压缩时调用的模型：返回固定的摘要文字（带 <think>，验证中间件照样去掉）。
    models.chat_model = GenericFakeChatModel(messages=iter([AIMessage("<think>想想</think>用户问过订单和退货。")] * 5))
    return ResponseAgent(models, use_postgres=False)


# Agent 模式回答后写入会话记忆：没超过阈值只追加；超过后用同一个摘要中间件压缩，摘要去掉 <think>。
def test_remember_turn_appends_then_compresses(monkeypatch, runtime):
    runtime(memory_trigger_tokens=800, memory_keep_tokens=200)
    agent = response_agent(monkeypatch)
    first = agent.remember_turn("alice", "s1", "订单 A1001 到哪了", "已发货 [O1]。")
    assert first["compressed"] is False and first["message_count"] == 2
    long_answer = "退货规则说明。" * 60
    agent.remember_turn("alice", "s1", "退货要什么条件", long_answer)
    third = agent.remember_turn("alice", "s1", "换货呢", long_answer)
    assert third["compressed"] is True and third["summary_updated"] is True
    assert third["summary"] == "用户问过订单和退货。"
    memory = agent.memory.inspect("alice", "s1")
    assert memory["summary"] == "用户问过订单和退货。"
    # 另一个会话互不影响。
    assert agent.memory.inspect("alice", "s2")["message_count"] == 0


def test_remember_turn_skips_without_model(monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    assert ResponseAgent(Models(), use_postgres=False).remember_turn("alice", "s1", "问题", "回答") is None
