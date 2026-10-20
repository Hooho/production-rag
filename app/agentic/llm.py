"""Agent 模式的模型调用：直接用 openai SDK，拿到接口返回的原文。

固定流程用 LangChain 的 ChatOpenAI，它只按 OpenAI 官方格式解析，第三方字段 reasoning_content 会被丢掉；
Agent 的执行链要展示原始响应和推理过程，所以这里绕过 LangChain。
模型地址、密钥、模型名和固定流程用同一份配置（Models 上的 llm_*），设置页切换模型后两边一起生效。
"""
import json
import re

from openai import OpenAI

# 推理模型每轮都要思考，比固定流程的单次调用慢，单次超时放宽到 60 秒；连接失败、超时、429、5xx 自动重试 2 次。
LLM_TIMEOUT = 60
LLM_RETRIES = 2
THINK_BLOCK = re.compile(r"^\s*<think>(.*?)(</think>|$)\s*", re.S)


def is_minimax(models):
    return getattr(models, "llm_provider", "") == "minimax" or "minimax" in (getattr(models, "llm_base_url", "") or "")


class ChatClient:
    """一次调用：发 messages 和 tools，返回 (原始响应文本, 解析后的 dict)。测试里换成按顺序返回固定响应的假模型。"""

    def __init__(self, models):
        self.models = models
        self.client = OpenAI(base_url=models.llm_base_url, api_key=models.llm_api_key,
            timeout=LLM_TIMEOUT, max_retries=LLM_RETRIES)

    def __call__(self, messages, tools):
        params = {"model": self.models.llm_model, "messages": messages, "temperature": 0}
        # 强制回答的那一轮不带 tools：MiniMax 文档没有说明支持 tool_choice="none"，不给工具最稳妥。
        if tools:
            params["tools"] = tools
        # MiniMax 默认把思考过程写在 content 的 <think> 里；reasoning_split 让它单独放进 reasoning_content。
        # 只对 MiniMax 发这个参数，其他厂商不认识的参数可能直接报错。
        if is_minimax(self.models):
            params["extra_body"] = {"reasoning_split": True}
        response = self.client.chat.completions.with_raw_response.create(**params)
        raw = response.text
        return raw, json.loads(raw)


def parse_message(response):
    """从接口返回里取出这一轮的结果。

    返回 dict：message（原样的 assistant 消息，下一轮要原样传回）、content（去掉 <think> 的文字）、
    reasoning（推理过程）、tool_calls、finish_reason、usage。
    """
    choice = (response.get("choices") or [{}])[0]
    message = dict(choice.get("message") or {})
    message["role"] = "assistant"
    content = message.get("content") or ""
    reasoning = message.get("reasoning_content") or ""
    # 没有 reasoning_content、思考过程写在 content 开头的 <think> 里（没开 reasoning_split 的 MiniMax、部分本地模型）：
    # 提取出来当作推理过程展示，答案里去掉；传回给模型的 message 保持原样。
    if not reasoning:
        match = THINK_BLOCK.match(content)
        if match:
            reasoning = match.group(1).strip()
            content = content[match.end():]
    tool_calls = message.get("tool_calls") or []
    # 只保留接口规定的字段传回给模型；值为 None 的字段去掉，有些服务不接受 null。
    kept = {key: value for key, value in message.items()
        if key in ("role", "content", "reasoning_content", "tool_calls", "reasoning_details") and value is not None}
    if "content" not in kept:
        kept["content"] = ""
    return {"message": kept, "content": content.strip(), "reasoning": reasoning.strip(), "tool_calls": tool_calls,
        "finish_reason": choice.get("finish_reason"), "usage": response.get("usage") or {}}


# 缓存命中的 token 数：OpenAI 格式在 prompt_tokens_details.cached_tokens，DeepSeek 是 prompt_cache_hit_tokens。
def cached_tokens(usage):
    details = usage.get("prompt_tokens_details") or {}
    return details.get("cached_tokens") or usage.get("prompt_cache_hit_tokens") or 0
