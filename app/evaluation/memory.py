# 多轮对话评测：给「对话记忆」的两个参数（超过多少 Token 开始压缩、压缩时保留最近几条）提供依据。
# 单题评测里多轮追问是用补全后的完整问题去问的，测不到记忆；这里把一段对话按顺序真的问一遍，
# 最后一问要用到开头几轮的内容（例如「回到我最开始问的那个称号」），看压缩之后还记不记得。
# 和线上一样：意图识别只看最近 3 轮问答和滚动摘要，所以开头的内容只能靠摘要带过来。
# 回答模型用进程内记忆，不写 runs 表和 PostgreSQL。需要真实大模型。
# 题目放在专项评测集里（评测方式选「多轮对话」），由 app/evaluation/suites.py 调用这里按顺序问完。
from datetime import datetime, timezone

from ..agent.response import ResponseAgent
from ..agent.service import Agent
from .retrieval import EVAL_OWNER

# 线上每轮从 MySQL 取最近 6 轮问答作为历史（app/memory/service.py）。
HISTORY_LIMIT = 6


# 要比较的参数组合：当前设置，加上压缩阈值调小 / 调大、保留条数调小 / 调大各一组，每组只改一个因素。
def memory_variants(settings):
    trigger, keep = settings["memory_trigger_tokens"], settings["memory_keep_messages"]
    variants = [{"name": "current", "label": f"当前设置（{trigger} Token / 保留 {keep} 条）", "trigger": trigger, "keep": keep}]
    for value in (max(800, trigger // 2), trigger * 2):
        if value != trigger:
            variants.append({"name": f"trigger_{value}", "label": f"压缩阈值 {value} Token", "trigger": value, "keep": keep})
    for value in (max(2, keep - 4), keep + 4):
        if value != keep:
            variants.append({"name": f"keep_{value}", "label": f"保留最近 {value} 条", "trigger": trigger, "keep": value})
    return variants


def now():
    return datetime.now(timezone.utc).isoformat()


# 按顺序问完一段对话，返回最后一问的回答、来源，以及整段对话里有没有触发压缩、最后一问发给模型的 Token。
def run_dialogue(store, models, run_id, variant, dialogue):
    responder = ResponseAgent(models, use_postgres=False)
    responder.use_memory_settings(variant["trigger"], variant["keep"])
    agent = Agent()
    agent.response_agent = responder
    session_id = f"memory-eval:{run_id}:{variant['name']}:{dialogue['id']}"
    previous = []
    summarized = False
    result = None
    try:
        for question in dialogue["turns"] + [dialogue["question"]]:
            result = agent.run(store, models, EVAL_OWNER, session_id, question, previous[-HISTORY_LIMIT:], None)
            previous.append({"question": question, "response": {"answer": result["answer"]}, "created": now()})
            for step in result["steps"]:
                if step["id"] == "response" and (step.get("result") or {}).get("summary_updated"):
                    summarized = True
    finally:
        agent.close()
    response = next((step.get("result") or {} for step in result["steps"] if step["id"] == "response"), {})
    usage = response.get("token_usage") or {}
    return {"answer": result["answer"], "sources": result.get("sources") or [], "route": result.get("route"),
        "summarized": summarized, "input_tokens": usage.get("input")}


def average(values):
    values = [value for value in values if value is not None]
    return round(sum(values) / len(values), 4) if values else None
