from app.memory.view import compressed_turns
from app.mysql.tables import runs, sessions
from test_app import headers, setup  # noqa: F401  复用 API 测试的内存存储夹具


def response(question, rewritten, sent_messages=0, compressed=False, summary=None, kept=None, tokens=100):
    steps = [{"id": "query", "result": {"standalone_query": rewritten}},
        {"id": "context", "result": {"estimated_memory_tokens": tokens}}]
    result = {"checkpoint_messages_sent": sent_messages, "checkpoint_messages_before": max(0, sent_messages - 1),
        "summary_updated": compressed}
    if kept is not None:
        result["ai_memory_sent"] = [{"target": "LangChain 回答 Agent", "memory_summary": summary or "", "history_turns": kept}]
    steps.append({"id": "response", "result": result})
    return {"answer": f"{question} 的回答", "steps": steps, "last_order": "A1003"}


def add(connection, run_id, session_id, owner, question, created, body, route="knowledge"):
    connection.execute(runs.insert().values(id=run_id, session_id=session_id, owner=owner, question=question,
        response=body, created=created, route=route, refused=False, duration_ms=10, top_score=0.9, trace={"route": route}))


SESSION = "11111111-2222-4333-8444-555555555555"


# 列表和详情：每一轮问题改写成了什么、有没有进入回答模型、哪一轮压缩了、压掉了哪几轮；只能看自己的会话。
def test_memory_sessions(setup):
    client, store = setup
    with store.engine.begin() as connection:
        connection.execute(sessions.insert().values(id=SESSION, owner="alice"))
        add(connection, "r1", SESSION, "alice", "退货政策是什么", "2026-10-05T01:00:00+00:00",
            response("退货政策是什么", "退货政策是什么", 1, kept=[]))
        add(connection, "r2", SESSION, "alice", "A1003 能退吗", "2026-10-05T01:01:00+00:00",
            response("A1003 能退吗", "订单 A1003 能否退货", 0), route="order")
        add(connection, "r3", SESSION, "alice", "那拆封了呢", "2026-10-05T01:02:00+00:00",
            response("那拆封了呢", "电子产品拆封后能否退货", 3, compressed=True, summary="用户在问退货",
                kept=[], tokens=2600))
    listed = client.get("/memory/sessions", headers=headers("alice")).json()
    item = listed["items"][0]
    assert item["session_id"] == SESSION and item["turns"] == 3 and item["compressions"] == 1
    assert item["title"] == "退货政策是什么" and item["snapshots"] == 0
    assert client.get("/memory/sessions", headers=headers("bob")).json()["items"] == []

    detail = client.get(f"/memory/sessions/{SESSION}", headers=headers("alice")).json()
    timeline = detail["timeline"]
    assert [turn["rewritten"] for turn in timeline] == ["退货政策是什么", "订单 A1003 能否退货", "电子产品拆封后能否退货"]
    assert [turn["entered"] for turn in timeline] == [True, False, True]
    assert timeline[2]["compressed"] and timeline[2]["summary"] == "用户在问退货"
    assert timeline[2]["compressed_turns"] == [{"question": "退货政策是什么", "answer": "退货政策是什么 的回答"}]
    assert timeline[2]["kept_rounds"] == []
    assert detail["last_order"] == "A1003" and detail["current"]["message_count"] == 0
    assert client.get(f"/memory/sessions/{SESSION}", headers=headers("bob")).status_code == 404


def test_compressed_turns_keeps_recent():
    previous = {"question": "q2", "answer": "a2", "kept_turns": [{"question": "q1", "answer": "a1"}]}
    current = {"kept_turns": [{"question": "q2", "answer": "a2"}]}
    assert compressed_turns(previous, current) == [{"question": "q1", "answer": "a1"}]
    assert compressed_turns(None, current) is None


# 按 Token 保留原文时切点对齐到一轮问答开头：落在回答上就往后挪到下一个问题；
# 对齐后连上一轮完整问答都留不下时，强制保留上一轮；摘要消息不算问题。
def test_align_cutoff_keeps_whole_turns():
    from langchain_core.messages import AIMessage, HumanMessage
    from app.memory.framework import align_cutoff
    summary = HumanMessage(content="摘要", additional_kwargs={"lc_source": "summarization"})
    messages = [summary, HumanMessage("问1"), AIMessage("答1"), HumanMessage("问2"), AIMessage("答2"),
        HumanMessage("问3"), AIMessage("答3"), HumanMessage("问4")]
    assert align_cutoff(messages, 0) == 0
    assert align_cutoff(messages, 3) == 3
    assert align_cutoff(messages, 2) == 3
    # 切点落在答3（上一轮回答太长，只留得下本轮问题）：退回保留第 3 轮整轮。
    assert align_cutoff(messages, 6) == 5
    assert align_cutoff(messages, 7) == 5
    # 只有摘要和一轮之前的问答：不压缩。
    assert align_cutoff([summary, HumanMessage("问1"), AIMessage("答1"), HumanMessage("问2")], 3) == 0
    assert align_cutoff([HumanMessage("问1"), AIMessage("答1"), HumanMessage("问2")], 2) == 0


# 早期格式的记录没有保存记忆信息：记为「未记录」（None），不是「未写入记忆」；回答里的思考过程不展示。
def test_unrecorded_turns_and_think(setup):
    client, store = setup
    early = {"answer": "<think>思考</think>早期回答", "steps": [{"id": "query", "result": {"standalone_query": "q1"}}]}
    with store.engine.begin() as connection:
        connection.execute(sessions.insert().values(id=SESSION, owner="alice"))
        add(connection, "r1", SESSION, "alice", "q1", "2026-10-05T01:00:00+00:00", early)
        body = response("q2", "q2", 3, kept=[{"question": "q1", "answer": "<think>想一想</think>早期回答"}])
        add(connection, "r2", SESSION, "alice", "q2", "2026-10-05T01:01:00+00:00", body)
    timeline = client.get(f"/memory/sessions/{SESSION}", headers=headers("alice")).json()["timeline"]
    assert [turn["entered"] for turn in timeline] == [None, True]
    assert timeline[1]["kept_turns"] == [{"question": "q1", "answer": "早期回答"}]
    assert timeline[1]["kept_rounds"] == [1]


# 是否压缩只看对话记忆本身：上一次模型调用报告的总 Token（含检索资料）再大也不触发。
def test_reported_usage_does_not_trigger():
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from app.memory.framework import ThinkFreeSummarizationMiddleware, memory_token_counter
    from langchain.agents.middleware import SummarizationMiddleware
    model = FakeListChatModel(responses=["摘要"])
    answer = AIMessage(content="回答", usage_metadata={"input_tokens": 4800, "output_tokens": 200, "total_tokens": 5000},
        response_metadata={"model_provider": model._get_ls_params().get("ls_provider")})
    messages = [HumanMessage("问1"), answer, HumanMessage("问2")]
    # LangChain 原版：上一次调用报告了 5000 Token，就算记忆只有几个字也会压缩。
    original = SummarizationMiddleware(model=model, trigger=("tokens", 2400), keep=("tokens", 1200))
    assert original._should_summarize(messages, original.token_counter(messages)) is True
    middleware = ThinkFreeSummarizationMiddleware(model=model, trigger=("tokens", 2400), keep=("tokens", 1200),
        token_counter=memory_token_counter)
    total = middleware.token_counter(messages)
    assert total < 100
    assert middleware._should_summarize(messages, total) is False
