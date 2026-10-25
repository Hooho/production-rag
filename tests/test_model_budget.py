import json

import pytest
from langchain_core.messages import AIMessage

from app.evaluation.flow import apply_sufficiency
from app.models import INTENT_MAX_TOKENS, SUFFICIENCY_MAX_TOKENS, Models, TruncatedOutput


class FakeChat:
    def __init__(self, message):
        self.message = message
        self.max_tokens = None

    def bind(self, max_tokens):
        self.max_tokens = max_tokens
        return self

    def invoke(self, messages):
        return self.message


# 推理模型的思考过程用完了额度、正式结果一个字没写：报"输出被截断"，不再只是"模型没有返回 JSON"。
def test_chat_completion_reports_truncated_thinking():
    models = Models()
    models.chat_model = FakeChat(AIMessage(content="<think>想了很多还没想完", response_metadata={"finish_reason": "length"}))
    with pytest.raises(TruncatedOutput, match="思考过程用完了 400 个 token"):
        models.chat_completion([], 400)
    # 截断了但已经写出了结果，照常返回，由调用方自己解析。
    models.chat_model = FakeChat(AIMessage(content="<think>想完了</think>{\"a\": 1", response_metadata={"finish_reason": "length"}))
    assert models.chat_completion([], 400) == "{\"a\": 1"
    models.chat_model = FakeChat(AIMessage(content="<think>想完了</think>{}", response_metadata={"finish_reason": "stop"}))
    assert models.chat_completion([], 400) == "{}"


# 意图识别（改写）和充分性判断用 2000 的额度；失败原因写进记录。
def test_intent_and_sufficiency_budget_and_reason(monkeypatch, runtime):
    monkeypatch.setenv("MODEL_MODE", "openai")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    runtime(intent_local=False)
    models = Models()
    budgets = []

    def truncated(messages, max_tokens):
        budgets.append(max_tokens)
        raise TruncatedOutput(f"输出被截断：思考过程用完了 {max_tokens} 个 token 的额度，没写出结果")

    monkeypatch.setattr(models, "chat_completion", truncated)
    analysis = models.analyze_query("雷曼和 GE 买入前的做法有什么不同？", [], None)
    assert analysis["classifier"] == "fallback"
    llm_step = [step for step in analysis["trace"] if step["stage"] == "llm"][0]
    assert llm_step["result"] == "调用失败（输出被截断：思考过程用完了 2000 个 token 的额度，没写出结果）"
    judgement = models.judge_sufficiency("问题", [{"id": "S1", "text": "资料"}])
    assert judgement["verdict"] == "sufficient" and "输出被截断" in judgement["error"]
    assert budgets == [INTENT_MAX_TOKENS, SUFFICIENCY_MAX_TOKENS] == [2000, 2000]
    # 其他错误带上类型和说明。
    monkeypatch.setattr(models, "chat_completion", lambda messages, max_tokens: "不是 JSON")
    analysis = models.analyze_query("雷曼和 GE 买入前的做法有什么不同？", [], None)
    assert [step for step in analysis["trace"] if step["stage"] == "llm"][0]["result"] == "调用失败（ValueError：模型没有返回 JSON）"


# 评测记录里，判断失败按"资料充分"兜底的那次带上原因，并统计失败次数。
def test_apply_sufficiency_records_judge_error():
    row = {"given_recall": 1.0, "evidence": [{}]}
    check = {"checked": True, "verdict": "sufficient", "missing": "", "retried": False, "retry_query": None, "refused": False,
        "sources": [], "judgements": [{"verdict": "sufficient", "missing": "", "rewrite_query": "",
            "error": "判断失败，按资料充分处理：输出被截断"}]}
    apply_sufficiency(row, check, lambda sources: set(), [], 1, False)
    assert row["sufficiency"]["errors"] == 1
    assert row["sufficiency"]["judgements"][0]["error"] == "判断失败，按资料充分处理：输出被截断"
    check["judgements"] = [{"verdict": "sufficient", "missing": "", "rewrite_query": ""}]
    apply_sufficiency(row, check, lambda sources: set(), [], 1, False)
    assert row["sufficiency"]["errors"] == 0 and "error" not in row["sufficiency"]["judgements"][0]
    assert json.dumps(row, ensure_ascii=False)
