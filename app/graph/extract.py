import hashlib
import json
import re
import time

from langchain_core.messages import HumanMessage, SystemMessage

from .. import prompts
from ..models import TruncatedOutput, strip_think
from .schemas import OTHER_TYPE, category_names, render, type_names

PROMPT_ID = "graph_extract"
# 推理模型先写思考过程再写 JSON，额度给少了会在写完 JSON 之前被截断。
MAX_TOKENS = 4096
NAME_LENGTH = 200
TEXT_LENGTH = 500
OTHER_CATEGORY = "其他"


# 复用抽取结果的键：分片文字、清单（id 和版本）、模型、提示词内容都相同才复用。任何一项变了都会重新抽取。
def cache_key(chunk_key, schema, provider, model, prompt_identity):
    identity = json.dumps(
        [
            chunk_key,
            schema["id"],
            schema["version"],
            schema["entity_types"],
            schema["relation_categories"],
            provider,
            model,
            prompt_identity,
        ],
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


# 发给模型的完整内容，原样存进抽取结果，页面上「发给模型的完整提示词」显示的就是它。
# 清单填在用户消息里：改清单不用改提示词，改提示词也不用改清单。
def build_messages(schema, chunk):
    heading = " / ".join(chunk.get("heading_path") or []) or "根文档"
    user = (
        f"<schema>\n{render(schema)}\n</schema>\n"
        f"<document>{chunk.get('document_title') or ''}</document>\n"
        f"<heading>{heading}</heading>\n"
        f"<context>{chunk.get('context') or ''}</context>\n"
        f"<chunk>\n{chunk['content']}\n</chunk>"
    )
    return [
        {"role": "system", "content": prompts.compose(PROMPT_ID)},
        {"role": "user", "content": user},
    ]


def clean(value, limit):
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


# 解析并校验模型输出。JSON 本身解析不了时抛出 ValueError（这一片记为失败，可以重试）；
# 单个实体、关系不合规时丢掉那一项，原因写进 dropped，页面上能看到。
def parse_output(text, schema):
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        raise ValueError("模型没有返回 JSON")
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON 解析失败：{error.msg}") from None
    if not isinstance(value, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    types = set(type_names(schema))
    categories = set(category_names(schema))
    entities = []
    dropped = []
    names = set()
    for item in value.get("entities") or []:
        if not isinstance(item, dict):
            dropped.append({"kind": "entity", "item": item, "reason": "格式不对"})
            continue
        name = clean(item.get("name"), NAME_LENGTH)
        if not name:
            dropped.append({"kind": "entity", "item": item, "reason": "没有名字"})
            continue
        if name in names:
            dropped.append({"kind": "entity", "item": item, "reason": "同一片里重复"})
            continue
        entity_type = clean(item.get("type"), 32)
        fixed = None
        if entity_type not in types:
            fixed = entity_type
            entity_type = OTHER_TYPE
        names.add(name)
        entities.append(
            {
                "name": name,
                "canonical": clean(item.get("canonical"), NAME_LENGTH) or name,
                "type": entity_type,
                "description": clean(item.get("description"), TEXT_LENGTH),
                # 模型写了清单里没有的类型时记下原来写的，归到「其他」
                "type_fixed_from": fixed,
            }
        )
    relations = []
    for item in value.get("relations") or []:
        if not isinstance(item, dict):
            dropped.append({"kind": "relation", "item": item, "reason": "格式不对"})
            continue
        source = clean(item.get("source"), NAME_LENGTH)
        target = clean(item.get("target"), NAME_LENGTH)
        if source not in names or target not in names:
            missing = [part for part in (source, target) if part not in names]
            dropped.append(
                {
                    "kind": "relation",
                    "item": item,
                    "reason": f"起点或终点不在实体列表里：{'、'.join(missing) or '空'}",
                }
            )
            continue
        if source == target:
            dropped.append(
                {"kind": "relation", "item": item, "reason": "起点和终点相同"}
            )
            continue
        category = clean(item.get("category"), 32)
        relations.append(
            {
                "source": source,
                "target": target,
                "category": category if category in categories else OTHER_CATEGORY,
                "description": clean(item.get("description"), TEXT_LENGTH),
                "evidence": clean(item.get("evidence"), TEXT_LENGTH),
            }
        )
    return {"entities": entities, "relations": relations, "dropped": dropped}


# 调用聊天模型，同时拿到 token 用量。chat_completion 只返回文字，这里要记每片花了多少 token，所以直接调用。
def call_model(models, messages):
    chat_model = getattr(models, "chat_model", None)
    if chat_model is None:
        raise RuntimeError(
            "真实聊天模型未启用（MODEL_MODE 不是 openai），无法抽取实体关系"
        )
    response = chat_model.bind(max_tokens=MAX_TOKENS).invoke(
        [
            SystemMessage(content=messages[0]["content"]),
            HumanMessage(content=messages[1]["content"]),
        ]
    )
    content = response.content
    if not isinstance(content, str):
        raise ValueError("聊天模型没有返回文本")
    text = strip_think(content)
    finish_reason = (getattr(response, "response_metadata", None) or {}).get(
        "finish_reason"
    )
    if finish_reason == "length" and not text.strip():
        raise TruncatedOutput(
            f"输出被截断：思考过程用完了 {MAX_TOKENS} 个 token 的额度，没写出结果"
        )
    usage = getattr(response, "usage_metadata", None) or {}
    return content, text, usage.get("input_tokens"), usage.get("output_tokens")


# 抽取一个分片。不抛异常：失败时返回 status=failed 和原因，这一片可以单独重试，其他分片照常继续。
def extract_chunk(models, schema, chunk):
    messages = build_messages(schema, chunk)
    started = time.monotonic()
    raw = None
    input_tokens = output_tokens = None
    try:
        raw, text, input_tokens, output_tokens = call_model(models, messages)
        result = parse_output(text, schema)
        status, error = "extracted", None
    except Exception as error_value:
        result, status, error = None, "failed", str(error_value)[:500]
    return {
        "status": status,
        "prompt": messages,
        "raw_output": raw,
        "result": result,
        "error": error,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }
