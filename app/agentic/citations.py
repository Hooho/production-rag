"""Agent 模式的引用检查：回答里的 [S1]、[O1]、[D1] 必须都能在资料池里找到。

固定流程的 models.check_citations 只认 S 编号，这里单独写一份，原函数不改；判断规则相同：
有资料却一个引用都没有算 no_citation，引用了不存在的编号算 unknown_source。
"""
import re

CITATION = re.compile(r"\[([SOD]\d+)\]")


def sort_key(evidence_id):
    return ("SOD".index(evidence_id[0]), int(evidence_id[1:]))


def check_citations(answer, allowed):
    allowed = sorted(allowed, key=sort_key)
    cited = sorted(set(CITATION.findall(answer or "")), key=sort_key)
    unknown = [value for value in cited if value not in allowed]
    reason = "no_citation" if not cited else "unknown_source" if unknown else None
    return {"passed": reason is None, "reason": reason, "allowed": allowed, "cited": cited, "unknown": unknown}


# 检查不通过时发给 Agent 的修改提示：说清楚哪里不对、可以用哪些编号，让它重写一次。
def fix_prompt(check):
    allowed = "、".join(check["allowed"])
    if check["reason"] == "unknown_source":
        problem = f"回答里引用了不存在的资料编号：{'、'.join(check['unknown'])}。"
    else:
        problem = "回答里没有标出资料编号。"
    return (f"引用检查没有通过：{problem}可以引用的编号只有：{allowed}。\n"
        "请重写回答：每句事实后标出对应的资料编号，格式为 [S1]、[O1]、[D1]，一个编号一对方括号；"
        "资料里没有的内容不要写。只输出重写后的回答。")
