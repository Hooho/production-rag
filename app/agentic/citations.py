"""Agent 模式的引用检查：回答里的 [S1]、[O1]、[D1] 必须都能在资料池里找到。

固定流程的 models.check_citations 只认 S 编号，这里单独写一份，原函数不改；判断规则相同：
有资料却一个引用都没有算 no_citation，引用了不存在的编号算 unknown_source。
另外多一条：方括号里不是资料编号的标记（例如 [无资料]、[检索未命中]）算 invented_marker。
提示词里写了“不要加方括号标记”，实测 MiniMax 仍然会写，所以改成程序检查，不通过时交给模型重写。
"""
import re

CITATION = re.compile(r"\[([SOD]\d+)\]")
# 方括号标记：不跨行、不超过 20 字；后面紧跟 ( 的是 Markdown 链接 [文字](网址)，不算；
# 前面是 ! 的是图片，由输出安全检查处理，也不算。
BRACKET = re.compile(r"(?<!!)\[([^\[\]\n]{1,20})\](?!\()")
# Markdown 任务列表的 [ ] 和 [x] 不算标记。
ALLOWED_BRACKETS = {" ", "x", "X"}


def sort_key(evidence_id):
    return ("SOD".index(evidence_id[0]), int(evidence_id[1:]))


def check_citations(answer, allowed):
    allowed = sorted(allowed, key=sort_key)
    cited = sorted(set(CITATION.findall(answer or "")), key=sort_key)
    unknown = [value for value in cited if value not in allowed]
    markers = []
    for value in BRACKET.findall(answer or ""):
        if CITATION.fullmatch(f"[{value}]") or value in ALLOWED_BRACKETS or f"[{value}]" in markers:
            continue
        markers.append(f"[{value}]")
    if not cited:
        reason = "no_citation"
    elif unknown:
        reason = "unknown_source"
    elif markers:
        reason = "invented_marker"
    else:
        reason = None
    return {"passed": reason is None, "reason": reason, "allowed": allowed, "cited": cited, "unknown": unknown,
        "markers": markers}


# 检查不通过时发给 Agent 的修改提示：说清楚哪里不对、可以用哪些编号，让它重写一次。
def fix_prompt(check):
    if not check["allowed"]:
        return (f"引用检查没有通过：回答里出现了资料编号 {'、'.join(check['unknown'])}，但这次问答还没有调用任何工具，"
            "这些编号来自历史消息里之前的回答，这次不能用。\n"
            "历史消息只用来理解上下文，不能当资料。需要事实时，先调用工具查询，再根据查到的资料回答并标出新的编号；"
            "不需要资料的问题直接回答，不要标编号。")
    allowed = "、".join(check["allowed"])
    problems = []
    if check["reason"] == "no_citation":
        problems.append("回答里没有标出资料编号。")
    if check["unknown"]:
        problems.append(f"回答里引用了不存在的资料编号：{'、'.join(check['unknown'])}。")
    if check["markers"]:
        problems.append(f"回答里有不是资料编号的方括号标记：{'、'.join(check['markers'])}，"
            "资料里没有的内容直接写“资料中没有找到……”，不要加任何方括号标记。")
    return (f"引用检查没有通过：{''.join(problems)}可以引用的编号只有：{allowed}。\n"
        "请重写回答：每句事实后标出对应的资料编号，格式为 [S1]、[O1]、[D1]，一个编号一对方括号；"
        "资料里没有的内容不要写。只输出重写后的回答。")
