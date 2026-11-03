import json

from langchain_core.messages import AIMessage

from app import prompts
from app.graph import extract
from app.graph.schemas import DEFAULT_SCHEMA, get_schema, DEFAULT_SCHEMA_ID
from app.mysql.tables import graph_schemas, metadata
from sqlalchemy import create_engine, select


# 假的聊天模型：按顺序返回准备好的回复，记下收到的消息。
class FakeChatModel:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def bind(self, **kwargs):
        self.bound = kwargs
        return self

    def invoke(self, messages):
        self.calls.append(messages)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class FakeModels:
    def __init__(self, *replies):
        self.chat_model = FakeChatModel(*replies)
        self.llm_provider = "fake"
        self.llm_model = "fake-model"


def reply(value, **metadata):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return AIMessage(
        content=text,
        usage_metadata={"input_tokens": 120, "output_tokens": 30, "total_tokens": 150},
        response_metadata=metadata,
    )


CHUNK = {
    "content": "2011 年，阿段买入了苹果公司的股票。",
    "document_title": "段永平投资问答录",
    "heading_path": ["投资", "苹果"],
    "context": "这段讲段永平买入苹果股票。",
}
GOOD = {
    "entities": [
        {
            "name": "阿段",
            "canonical": "段永平",
            "type": "人物",
            "description": "投资人",
        },
        {
            "name": "苹果公司",
            "canonical": "苹果公司",
            "type": "组织",
            "description": "科技公司",
        },
    ],
    "relations": [
        {
            "source": "阿段",
            "target": "苹果公司",
            "category": "投资",
            "description": "段永平在 2011 年买入苹果股票",
            "evidence": "2011 年，阿段买入了苹果公司的股票。",
        }
    ],
}


# 发给模型的内容：系统提示词是可修改的指令加锁定的输出格式，用户消息里填清单、标题、章节、上下文说明和分片原文。
def test_messages_include_schema_and_chunk():
    messages = extract.build_messages(DEFAULT_SCHEMA, CHUNK)
    assert messages[0]["content"] == prompts.compose("graph_extract")
    user = messages[1]["content"]
    assert "- 人物：有名字的人" in user and "- 投资：" in user
    assert "<document>段永平投资问答录</document>" in user
    assert "<heading>投资 / 苹果</heading>" in user
    assert "<context>这段讲段永平买入苹果股票。</context>" in user
    assert "<chunk>\n2011 年，阿段买入了苹果公司的股票。\n</chunk>" in user


# 正常抽取：保留原名和标准名，记下 token 和原始输出。
def test_extract_chunk_success():
    models = FakeModels(reply(GOOD))
    result = extract.extract_chunk(models, DEFAULT_SCHEMA, CHUNK)
    assert result["status"] == "extracted" and result["error"] is None
    assert [
        (item["name"], item["canonical"], item["type"])
        for item in result["result"]["entities"]
    ] == [
        ("阿段", "段永平", "人物"),
        ("苹果公司", "苹果公司", "组织"),
    ]
    assert result["result"]["relations"][0]["category"] == "投资"
    assert result["input_tokens"] == 120 and result["output_tokens"] == 30
    assert result["raw_output"] == json.dumps(GOOD, ensure_ascii=False)


# 推理模型把思考过程写在 <think> 里：去掉之后再解析；原始输出原样保留，方便排查。
def test_think_is_stripped_before_parsing():
    raw = (
        '<think>先找人名……{"entities": []}</think>\n```json\n'
        + json.dumps(GOOD, ensure_ascii=False)
        + "\n```"
    )
    result = extract.extract_chunk(FakeModels(reply(raw)), DEFAULT_SCHEMA, CHUNK)
    assert result["status"] == "extracted"
    assert len(result["result"]["entities"]) == 2
    assert result["raw_output"].startswith("<think>")


# 失败的情况不抛异常：没有 JSON、JSON 写坏了、思考过程被截断、模型调用出错，都记为失败并写明原因。
def test_failures_are_recorded():
    cases = [
        (reply("我没有找到实体"), "模型没有返回 JSON"),
        (reply('{"entities": [}'), "JSON 解析失败"),
        (reply("<think>想了很久", finish_reason="length"), "输出被截断"),
        (RuntimeError("连接超时"), "连接超时"),
    ]
    for value, message in cases:
        result = extract.extract_chunk(FakeModels(value), DEFAULT_SCHEMA, CHUNK)
        assert result["status"] == "failed" and message in result["error"]
        assert result["result"] is None and result["prompt"]


# 没有真实聊天模型（demo 模式）时直接失败，说明原因。
def test_demo_mode_without_chat_model():
    models = FakeModels()
    models.chat_model = None
    result = extract.extract_chunk(models, DEFAULT_SCHEMA, CHUNK)
    assert result["status"] == "failed" and "真实聊天模型未启用" in result["error"]


# 单个实体、关系不合规时只丢掉那一项：类型不在清单里归到「其他」，关系的起点对不上实体时丢掉，分类不认识归到「其他」。
def test_invalid_items_are_dropped_or_fixed():
    value = {
        "entities": [
            {"name": "段永平", "type": "人物"},
            {"name": "段永平", "type": "人物"},
            {"name": "", "type": "人物"},
            {"name": "本分", "type": "价值观"},
            "乱写的",
        ],
        "relations": [
            {
                "source": "段永平",
                "target": "本分",
                "category": "主张",
                "description": "提倡本分",
            },
            {"source": "段永平", "target": "步步高", "category": "创办"},
            {"source": "段永平", "target": "段永平", "category": "其他"},
        ],
    }
    result = extract.parse_output(json.dumps(value, ensure_ascii=False), DEFAULT_SCHEMA)
    assert [
        (item["name"], item["canonical"], item["type"], item["type_fixed_from"])
        for item in result["entities"]
    ] == [
        ("段永平", "段永平", "人物", None),
        ("本分", "本分", "其他", "价值观"),
    ]
    assert [
        (item["source"], item["target"], item["category"])
        for item in result["relations"]
    ] == [("段永平", "本分", "其他")]
    reasons = [item["reason"] for item in result["dropped"]]
    assert reasons == [
        "同一片里重复",
        "没有名字",
        "格式不对",
        "起点或终点不在实体列表里：步步高",
        "起点和终点相同",
    ]


# 复用的键：分片、清单、模型、提示词任何一项变了都不一样。
def test_cache_key_changes_with_each_input():
    base = extract.cache_key("k1", DEFAULT_SCHEMA, "minimax", "M3", "p1")
    assert base == extract.cache_key("k1", DEFAULT_SCHEMA, "minimax", "M3", "p1")
    others = {
        extract.cache_key("k2", DEFAULT_SCHEMA, "minimax", "M3", "p1"),
        extract.cache_key(
            "k1", {**DEFAULT_SCHEMA, "version": 2}, "minimax", "M3", "p1"
        ),
        extract.cache_key("k1", DEFAULT_SCHEMA, "deepseek", "M3", "p1"),
        extract.cache_key("k1", DEFAULT_SCHEMA, "minimax", "M4", "p1"),
        extract.cache_key("k1", DEFAULT_SCHEMA, "minimax", "M3", "p2"),
    }
    assert base not in others and len(others) == 5


def test_in_place_schema_change_invalidates_cache():
    changed = {
        **DEFAULT_SCHEMA,
        "entity_types": [{"name": "方法", "description": "流程", "examples": []}],
    }
    assert extract.cache_key("k", changed, "p", "m", "v") != extract.cache_key(
        "k", DEFAULT_SCHEMA, "p", "m", "v"
    )
    changed = {
        **DEFAULT_SCHEMA,
        "relation_categories": [{"name": "依赖", "description": "依赖关系"}],
    }
    assert extract.cache_key("k", changed, "p", "m", "v") != extract.cache_key(
        "k", DEFAULT_SCHEMA, "p", "m", "v"
    )


def test_default_v1_updates_existing_row():
    db = create_engine("sqlite://")
    metadata.create_all(db)
    original = get_schema(db, DEFAULT_SCHEMA_ID)
    with db.begin() as connection:
        connection.execute(
            graph_schemas.update()
            .where(graph_schemas.c.id == DEFAULT_SCHEMA_ID)
            .values(entity_types=[{"name": "人物", "examples": ["旧示例"]}])
        )
    updated = get_schema(db, DEFAULT_SCHEMA_ID)
    assert updated["id"] == DEFAULT_SCHEMA_ID and updated["version"] == 1
    assert updated["entity_types"] == DEFAULT_SCHEMA["entity_types"]
    assert updated["created"] == original["created"]
    assert get_schema(db, DEFAULT_SCHEMA_ID) == updated
    with db.connect() as connection:
        assert len(connection.execute(select(graph_schemas)).all()) == 1


def test_graph_preview_matches_generic_template():
    preview = prompts.boxes("graph_extract")
    assert isinstance(preview[1]["parts"][0], dict)
    assert "段永平" not in prompts.compose("graph_extract")
    assert "苹果" not in str(preview)


def test_graph_request_has_own_timeout_and_preserves_shared_model():
    models = FakeModels(reply(GOOD))
    result = extract.extract_chunk(models, DEFAULT_SCHEMA, CHUNK)
    assert result["status"] == "extracted"
    assert models.chat_model.bound["timeout"] == 120
    assert not hasattr(models.chat_model, "request_timeout")


def test_graph_timeout_is_explained():
    import httpx
    from openai import APITimeoutError

    models = FakeModels(
        APITimeoutError(request=httpx.Request("POST", "https://example.test"))
    )
    result = extract.extract_chunk(models, DEFAULT_SCHEMA, CHUNK)
    assert result["status"] == "failed"
    assert "120 秒" in result["error"] and "超时" in result["error"]


def test_timeout_override_reaches_http_request_without_changing_chat_default():
    import httpx
    from types import SimpleNamespace
    from langchain_openai import ChatOpenAI

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "id": "test",
                "object": "chat.completion",
                "created": 0,
                "model": "test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": json.dumps(GOOD)},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        chat = ChatOpenAI(
            model="test",
            api_key="test-key",
            base_url="https://example.test/v1",
            timeout=20,
            max_retries=0,
            http_client=client,
        )
        result = extract.extract_chunk(
            SimpleNamespace(chat_model=chat), DEFAULT_SCHEMA, CHUNK
        )
        assert result["status"] == "extracted"
        assert requests[0].extensions["timeout"]["read"] == 120
        assert chat.request_timeout == 20
