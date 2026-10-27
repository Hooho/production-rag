"""Agent 循环：调用模型 → 有 tool_calls 就执行工具、把结果放回消息 → 再调用模型，直到模型直接给出回答。

模型决定调用哪些工具、调用几次、什么时候回答；程序负责这几条硬约束：
1. 工具调用预算（设置页 agent_tool_budget）：用完后最后一轮不带 tools，要求模型直接回答；
2. 整体超时（agent_timeout）：每轮开始前检查，超时后同样进入强制回答轮；
3. 重复调用拦截：同一个工具、完全相同的参数只执行一次，再次调用时告诉模型结果见前面；
4. 工具内部出错不打断循环：把“工具执行失败”作为结果交给模型；
5. 引用检查：回答里的编号必须都在资料池里，不通过时让模型重写一次，仍不通过替换成拒答文字。

每一轮都整理成一条记录（rounds），就是执行链上展示的内容：本轮新增的消息、原始响应、推理过程、
工具调用和返回、引用检查、耗时。记录在每轮结束时通过 on_round 交给调用方，接口可以据此流式推送。
"""
import copy
import json
import logging
import time

import httpx
from openai import OpenAIError

from ..business.definitions import DATA_TYPES
from ..models import CITATION_REJECTED
from ..runtime_config import snapshot as runtime_snapshot
from .citations import CITATION, check_citations, fix_prompt, sort_key
from .llm import cached_tokens, parse_message
from .tools import execute_tool, tool_definitions
from .query_explanation import retrieval_arguments

logger = logging.getLogger("production-rag-agentic")

FORCE_REASONS = {"budget": "工具调用次数已经用完", "timeout": "处理时间已经到上限"}
EMPTY_ANSWER = "没能在限定的次数内整理出回答，请换一种问法再试。"


def force_prompt(reason):
    return (f"{FORCE_REASONS[reason]}，不能再调用工具。请根据前面已经拿到的资料直接回答；"
        "资料只能回答一部分时，回答能支持的部分并说明缺什么；完全没有资料时如实说明。")


# 同一次调用的判断：工具名相同、参数解析后完全相同（参数顺序和空格不同也算同一次）。
def call_key(name, arguments):
    try:
        normalized = json.dumps(retrieval_arguments(name, json.loads(arguments or "{}")), ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        normalized = str(arguments)
    return name, normalized


def elapsed_ms(started, clock):
    return round((clock() - started) * 1000)


class AgentLoop:
    def __init__(self, ctx, llm, config=None, clock=time.monotonic, on_round=None):
        self.ctx = ctx
        self.llm = llm
        self.config = config or runtime_snapshot()
        self.clock = clock
        self.on_round = on_round
        self.budget = self.config["agent_tool_budget"]
        self.used = 0
        self.seen = {}
        self.rounds = []

    def run(self, messages):
        started = self.clock()
        deadline = started + self.config["agent_timeout"]
        tools = tool_definitions(self.ctx)
        sent = 0
        kind = "normal"
        stop_reason = None
        retried = False
        while True:
            if kind == "normal":
                if self.used >= self.budget:
                    stop_reason = "budget"
                elif self.clock() >= deadline:
                    stop_reason = "timeout"
                if stop_reason:
                    kind = "forced"
                    messages.append({"role": "user", "content": force_prompt(stop_reason)})
            round_tools = tools if kind == "normal" else None
            # 只记本轮新增的消息：前面的消息上一轮已经记过，执行链上用“同第几轮”引用，避免每轮重复存一份。
            record = {"round": len(self.rounds) + 1, "kind": kind, "message_count": len(messages),
                "new_messages": copy.deepcopy(messages[sent:]), "tools_sent": [tool["function"]["name"] for tool in round_tools or []]}
            call_started = self.clock()
            try:
                raw, response = self.llm(messages, round_tools)
            except (OpenAIError, httpx.HTTPError, ValueError) as error:
                # 重试后仍失败：本次问答标记失败，已经跑完的轮次照样交出去保存。
                record["error"] = str(error)[:500]
                record["duration_ms"] = elapsed_ms(call_started, self.clock)
                self.finish_round(record)
                return self.result("failed", None, "model_error", None, started, error=record["error"])
            sent = len(messages)
            parsed = parse_message(response)
            messages.append(parsed["message"])
            record.update({"raw_response": raw, "reasoning": parsed["reasoning"], "content": parsed["content"],
                "tool_calls": parsed["tool_calls"], "finish_reason": parsed["finish_reason"], "usage": parsed["usage"],
                "cached_tokens": cached_tokens(parsed["usage"]), "model_ms": elapsed_ms(call_started, self.clock)})

            if parsed["tool_calls"] and kind == "normal":
                record["tool_results"] = []
                for call in parsed["tool_calls"]:
                    outcome = self.run_call(call, record["round"])
                    record["tool_results"].append(outcome)
                    messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": outcome["content"]})
                record["duration_ms"] = elapsed_ms(call_started, self.clock)
                self.finish_round(record)
                continue

            answer = parsed["content"] or EMPTY_ANSWER
            stop_reason = stop_reason or "answered"
            citation = None
            allowed = list(self.ctx.evidence.items)
            # 资料池为空、回答里也没有编号（问候、闲聊）时不检查。资料池为空却出现了 [S1] 这类编号，
            # 说明编号是从历史消息里抄来的（历史里有上一次回答的引用），这次问答里根本不存在，同样算不通过。
            if allowed or CITATION.search(answer):
                citation = check_citations(answer, allowed)
                record["citation_check"] = citation
                if not citation["passed"]:
                    if not retried:
                        retried = True
                        prompt = fix_prompt(citation)
                        record["citation_fix_prompt"] = prompt
                        record["duration_ms"] = elapsed_ms(call_started, self.clock)
                        self.finish_round(record)
                        messages.append({"role": "user", "content": prompt})
                        # 有资料时只需要改写，不带工具；一条资料都没有时要先去查，下一轮照常带工具（仍受预算和超时约束）。
                        if allowed:
                            kind = "citation_retry"
                        else:
                            kind = "normal"
                            stop_reason = None
                        continue
                    # 重写后仍不通过：保存模型原话供排查，用户看到固定的拒答文字。
                    citation["raw_answer"] = answer[:4000]
                    answer = CITATION_REJECTED
            record["answer"] = answer
            record["duration_ms"] = elapsed_ms(call_started, self.clock)
            self.finish_round(record)
            return self.result("completed", answer, stop_reason, citation, started, citation_retried=retried)

    def finish_round(self, record):
        self.rounds.append(record)
        if self.on_round:
            self.on_round(record)

    # 执行一次工具调用，返回执行链上的记录；content 是放回消息给模型看的文字。
    def run_call(self, call, round_no):
        function = call.get("function") or {}
        name = function.get("name") or ""
        arguments = function.get("arguments") or "{}"
        key = call_key(name, arguments)
        started = self.clock()
        record = {"id": call.get("id"), "name": name, "arguments": arguments}
        if key in self.seen:
            record.update(status="duplicate", ok=False, content=(
                f"这个调用和第 {self.seen[key]} 轮的调用完全相同，没有重复执行，结果见前面的返回。换一种问法或换一个工具。"))
            return record
        if self.used >= self.budget:
            record.update(status="skipped", ok=False, content="工具调用次数已经用完，这次调用没有执行。")
            return record
        self.used += 1
        self.seen[key] = round_no
        try:
            outcome = execute_tool(self.ctx, name, arguments)
        except Exception as error:  # noqa: BLE001  工具内部任何异常都不打断循环，交给模型决定怎么办
            logger.exception("agent_tool_failed tool=%s", name)
            outcome = {"content": f"工具执行失败：{str(error)[:300]}", "ok": False, "trace": {"error": str(error)[:500]}}
        left = self.budget - self.used
        record.update(status="ok" if outcome["ok"] else "error", ok=outcome["ok"], trace=outcome["trace"],
            content=f"{outcome['content']}\n\n剩余预算：还能调用 {left} 次工具。", budget_left=left,
            duration_ms=elapsed_ms(started, self.clock))
        return record

    def result(self, status, answer, stop_reason, citation, started, **extra):
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
        for record in self.rounds:
            usage["prompt_tokens"] += (record.get("usage") or {}).get("prompt_tokens") or 0
            usage["completion_tokens"] += (record.get("usage") or {}).get("completion_tokens") or 0
            usage["cached_tokens"] += record.get("cached_tokens") or 0
        return {"status": status, "answer": answer, "stop_reason": stop_reason, "rounds": self.rounds,
            "tool_calls_used": self.used, "tool_budget": self.budget, "citation": citation,
            "sources": to_sources(self.ctx.evidence), "usage": usage,
            "duration_ms": elapsed_ms(started, self.clock), **extra}


def run_agent(ctx, messages, llm, config=None, clock=time.monotonic, on_round=None):
    return AgentLoop(ctx, llm, config, clock, on_round).run(messages)


def to_sources(evidence):
    """把资料池转换成现有来源面板的格式（id、title、text、version、page_start、heading），前端不用改。

    订单和业务数据没有文档标题，分别写成“订单 A1001”“业务数据 · 物流单”。按 S、O、D 和编号排序。
    """
    sources = []
    for evidence_id in sorted(evidence.items, key=sort_key):
        item = evidence.items[evidence_id]
        if item["type"] == "knowledge":
            source = {key: item.get(key) for key in ("title", "text", "version", "page_start", "heading",
                "chunk_id", "document_id", "score")}
        elif item["type"] == "order":
            source = {"title": f"订单 {item.get('order_id')}", "text": item.get("answer")}
        else:
            label = DATA_TYPES.get(item.get("data_type"), {}).get("label", "数据")
            source = {"title": f"业务数据 · {label}", "text": item.get("answer")}
        sources.append({"id": evidence_id, "type": item["type"], **source})
    return sources
