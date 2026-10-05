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
    assert detail["last_order"] == "A1003" and detail["current"]["message_count"] == 0
    assert client.get(f"/memory/sessions/{SESSION}", headers=headers("bob")).status_code == 404


def test_compressed_turns_keeps_recent():
    previous = {"question": "q2", "answer": "a2", "kept_turns": [{"question": "q1", "answer": "a1"}]}
    current = {"kept_turns": [{"question": "q2", "answer": "a2"}]}
    assert compressed_turns(previous, current) == [{"question": "q1", "answer": "a1"}]
    assert compressed_turns(None, current) is None
