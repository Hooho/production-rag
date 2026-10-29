"""检索调用的简短决策说明：由模型自述，不作为事实或检索参数。"""

import json

RETRIEVAL_TOOLS = {"search_knowledge", "read_context"}
BASIS = ("user_question", "previous_results", "hypothesis")
QUERY_EXPLANATION_SCHEMA = {
    "type": "object",
    "description": "本次查询的简短说明，不是完整思考过程。资料不支持的前提必须标为待验证假设。",
    "properties": {
        "purpose": {"type": "string", "description": "本次想确认什么，简短中文说明。"},
        "basis": {
            "type": "array",
            "items": {"type": "string", "enum": list(BASIS)},
            "description": "查询依据，可多选：用户问题、此前轮次返回资料、待验证假设。",
        },
        "references": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source_id": {
                        "type": "string",
                        "description": "此前已返回的资料编号，如 S1。",
                    },
                    "quote": {
                        "type": "string",
                        "description": "支持本次查询的原文片段，不得编造。",
                    },
                },
                "required": ["source_id", "quote"],
            },
            "description": "没有参考资料时填空数组。不得引用同轮或后续调用的结果。",
        },
        "assumptions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "资料尚未支持、此次需要验证的名称或事实前提；没有则填空数组。",
        },
    },
    "required": ["purpose", "basis", "references", "assumptions"],
}


def query_explanation(arguments):
    value = arguments.get("query_explanation")
    if value is None:
        return None  # 兼容旧记录和旧调用。
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError(
                "query_explanation 返回了字符串，但内容不是有效的 JSON 对象"
            ) from error
    if not isinstance(value, dict):
        raise ValueError(
            "query_explanation 应为对象，包含 purpose、basis、references 和 assumptions"
        )
    if not isinstance(value.get("purpose"), str) or not value["purpose"].strip():
        raise ValueError("query_explanation.purpose 应为非空字符串")
    basis = value.get("basis")
    if (
        not isinstance(basis, list)
        or not basis
        or any(item not in BASIS for item in basis)
    ):
        raise ValueError("query_explanation.basis 应为有效依据类型的非空数组")
    references = value.get("references", [])
    if not isinstance(references, list) or any(
        not isinstance(item, dict)
        or any(
            not isinstance(item.get(key), str) or not item[key].strip()
            for key in ("source_id", "quote")
        )
        for item in references
    ):
        raise ValueError(
            "query_explanation.references 应为数组，每项包含 source_id 和 quote；没有参考资料时填空数组 []"
        )
    assumptions = value.get("assumptions")
    if not isinstance(assumptions, list) or any(
        not isinstance(item, str) or not item.strip() for item in assumptions
    ):
        raise ValueError("query_explanation.assumptions 应为字符串数组")
    if "hypothesis" in basis and not assumptions:
        raise ValueError("依据待验证假设时，请填写 assumptions")
    return {
        "purpose": value["purpose"],
        "basis": basis,
        "references": references,
        "assumptions": assumptions,
    }


def retrieval_arguments(name, arguments):
    """理由不影响检索执行，也不参与重复调用判断。"""
    if name in RETRIEVAL_TOOLS and isinstance(arguments, dict):
        return {
            key: value for key, value in arguments.items() if key != "query_explanation"
        }
    return arguments
