from app import prompts
from test_app import headers, setup  # noqa: F401  复用 API 测试的内存存储夹具


def admin():
    return headers("admin")


# 列表：6 段提示词，分线上问答和文档导入两组，没改过时都用内置版本。
def test_prompt_list(setup):
    client, store = setup
    body = client.get("/prompts", headers=admin()).json()
    assert [item["id"] for item in body["items"]] == ["intent", "sufficiency", "answer", "memory_summary", "data_query", "chunk_context"]
    assert {item["active_label"] for item in body["items"]} == {"内置"}
    assert client.get("/prompts", headers=headers("alice")).status_code == 403


# 保存生成新版本并立即生效；内容没变不保存；回滚到旧版本或内置版本，不删除版本。
def test_prompt_save_and_rollback(setup):
    client, store = setup
    original = prompts.compose("answer")
    saved = client.post("/prompts/answer/versions", headers=admin(), json={"text": "你是客服助手，回答简洁。", "note": "改短"})
    assert saved.status_code == 200
    detail = saved.json()
    assert detail["active_version"] == 1 and [item["label"] for item in detail["versions"]] == ["v1", "内置"]
    assert detail["versions"][0]["note"] == "改短" and detail["versions"][0]["created_by"] == "admin"
    # 发给模型的是新指令 + 锁定部分；锁定部分（引用、防注入）不变。
    assert prompts.compose("answer").startswith("你是客服助手，回答简洁。") and "[S1]" in prompts.compose("answer")
    assert prompts.tag("answer") == "answer@v1"
    same = client.post("/prompts/answer/versions", headers=admin(), json={"text": "你是客服助手，回答简洁。"})
    assert same.status_code == 422

    client.post("/prompts/answer/versions", headers=admin(), json={"text": "第二版"})
    back = client.post("/prompts/answer/activate", headers=admin(), json={"version": 1}).json()
    assert back["active_version"] == 1 and len(back["versions"]) == 3
    assert prompts.instructions("answer") == "你是客服助手，回答简洁。"
    builtin = client.post("/prompts/answer/activate", headers=admin(), json={"version": 0}).json()
    assert builtin["active_label"] == "内置" and prompts.compose("answer") == original
    assert client.post("/prompts/answer/activate", headers=admin(), json={"version": 9}).status_code == 422
    assert client.post("/prompts/nope/versions", headers=admin(), json={"text": "x"}).status_code == 404


# 模板里的花括号：指令里写的花括号原样发给模型，不会被当成占位符；固定部分的 {messages} 保留为占位符。
def test_prompt_template_braces(setup):
    client, store = setup
    from langchain_core.prompts import ChatPromptTemplate
    client.post("/prompts/data_query/versions", headers=admin(), json={"text": "按 {字段} 查询。"})
    template = ChatPromptTemplate.from_messages([("system", prompts.compose("data_query", template=True)), ("human", "{payload}")])
    system = template.format_messages(payload="{}")[0].content
    assert system.startswith("按 {字段} 查询。") and '{"field", "op", "value"}' in system
    summary = prompts.compose("memory_summary", template=True)
    assert summary.endswith("历史消息：\n{messages}") and summary.format(messages="M").endswith("M")


# 分片上下文的缓存指纹：内置版本沿用原来的版本号，改了提示词就变，改回去又一样。
def test_chunk_context_identity(setup):
    client, store = setup
    assert prompts.identity("chunk_context") == 2
    client.post("/prompts/chunk_context/versions", headers=admin(), json={"text": "新的说明要求"})
    changed = prompts.identity("chunk_context")
    assert changed != 2
    client.post("/prompts/chunk_context/activate", headers=admin(), json={"version": 0})
    assert prompts.identity("chunk_context") == 2
