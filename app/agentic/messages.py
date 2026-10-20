"""组装 Agent 的第一轮消息。

为了命中模型服务的前缀缓存，按“越不会变的越靠前”摆放：
1. system：工作方式、规则、今天日期，基本不变；
2. 最近几轮问答：写成真实的 user / assistant 消息，只在末尾增加；只放问题和最终回答，不放当时的工具调用；
3. 最后一条 user：会变的记忆（用户偏好、对话摘要、最近订单）放在 <memory> 里，和本轮问题放在一起。
剩余预算不写进 system，附在每次工具返回的末尾，所以同一次问答里 system 每轮都一样。
"""
from .. import prompts
from ..business.service import today

WEEKDAYS = "一二三四五六日"


def system_message():
    current = today()
    text = prompts.compose("agent") + f"\n\n今天是 {current.isoformat()}（星期{WEEKDAYS[current.weekday()]}）。"
    return {"role": "system", "content": text}


# 最近几轮问答（MemoryService.history 读出的 runs 记录）：只取问题和最终回答。
def history_messages(previous):
    messages = []
    for item in previous or []:
        question = item.get("question") or ""
        answer = (item.get("response") or {}).get("answer") or ""
        if not question or not answer:
            continue
        messages.append({"role": "user", "content": question})
        messages.append({"role": "assistant", "content": answer})
    return messages


def memory_block(profile=None, summary=None, last_order=None):
    sections = []
    if profile:
        lines = [f"- {item.get('content')}" for item in profile if item.get("content")]
        if lines:
            sections.append("## 用户偏好\n" + "\n".join(lines))
    if summary and summary != "尚未生成":
        sections.append("## 之前的对话摘要\n" + summary)
    if last_order:
        sections.append("## 最近查过的订单\n" + last_order)
    if not sections:
        return ""
    return "<memory>\n" + "\n".join(sections) + "\n</memory>\n"


def user_message(question, profile=None, summary=None, last_order=None):
    block = memory_block(profile, summary, last_order)
    content = f"{block}本轮问题：{question}" if block else question
    return {"role": "user", "content": content}


def initial_messages(question, previous=None, profile=None, summary=None, last_order=None):
    return [system_message(), *history_messages(previous), user_message(question, profile, summary, last_order)]
