from langchain_core.messages import AIMessage
from sqlalchemy import select

from app.agent.response import ResponseAgent
from app.models import Models
from app.mysql.store import feedback, run_errors, runs
from app.observability import run_columns, summarize_run
from app.tools.search import DocumentSearchTool
from test_app import headers, question, session, setup  # noqa: F401  复用 API 测试的内存存储夹具


# 读取 runs 表中某次问答的追踪列。
def saved_run(store, request_id):
    with store.engine.connect() as connection:
        return connection.execute(select(runs).where(runs.c.id == request_id)).mappings().first()


# 成功的知识问答写入追踪列：路由、耗时、最高分，以及改写、候选、提示词版本等摘要。
def test_run_trace_summary_is_saved(setup):
    client, store = setup
    body = {"title": "售后", "content": "退货政策：退货期限 7 天。"}
    assert client.post("/documents", headers=headers(), json=body).status_code == 200
    payload = question(session(client), "退货政策")
    response = client.post("/chat", headers=headers(), json=payload)
    assert response.status_code == 200
    row = saved_run(store, payload["request_id"])
    assert row["route"] == "knowledge"
    assert row["refused"] is False
    assert row["duration_ms"] is not None
    assert row["top_score"] is not None
    trace = row["trace"]
    assert trace["rewrite"]["standalone_query"]
    assert set(trace["stage_ms"]) >= {"intent", "retrieval", "response", "complete"}
    candidate = trace["retrieval"]["candidates"][0]
    assert candidate["status"] == "returned" and candidate["source_id"] == "S1"
    # chunk_key 跨版本稳定，坏例转成评测题时靠它定位原文。
    assert candidate["chunk_key"]
    assert trace["generation"]["prompt_version"] == "answer-v3/answer@内置"
    # 演示模式不调用模型，没有 Token 用量。
    assert trace["generation"]["token_usage"] is None


# 全部来源被阈值过滤时标记为拒答并保留最高分；订单问答不走检索，摘要里没有检索部分。
def test_refusal_and_route_are_flagged(setup, monkeypatch):
    client, store = setup
    body = {"title": "售后", "content": "退货政策：退货期限 7 天。"}
    assert client.post("/documents", headers=headers(), json=body).status_code == 200
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    session_id = session(client)
    refused = question(session_id, "明天东京天气")
    assert client.post("/chat", headers=headers(), json=refused).status_code == 200
    row = saved_run(store, refused["request_id"])
    assert row["refused"] is True
    # 全部被阈值过滤时，最高分仍然记录下来，可以看出离阈值差多少。
    assert row["top_score"] == 0.01
    assert row["trace"]["retrieval"]["returned"] == 0
    order = question(session_id, "订单 A1001")
    assert client.post("/chat", headers=headers(), json=order).status_code == 200
    row = saved_run(store, order["request_id"])
    assert row["route"] == "order" and row["refused"] is False
    assert "retrieval" not in row["trace"]


# 检索阶段出错：客户端只收到通用 503，run_errors 记下错误原因和失败前最后完成的阶段。
def test_failed_run_is_recorded_with_last_step(setup, monkeypatch):
    client, store = setup
    def broken(*args, **kwargs):
        raise RuntimeError("milvus timeout")
    monkeypatch.setattr(DocumentSearchTool, "execute", broken)
    payload = question(session(client), "退货政策")
    response = client.post("/chat", headers=headers(), json=payload)
    assert response.status_code == 503
    assert "milvus" not in response.text
    with store.engine.connect() as connection:
        errors = connection.execute(select(run_errors)).mappings().all()
        assert connection.execute(select(runs)).all() == []
    assert len(errors) == 1
    error = errors[0]
    assert error["request_id"] == payload["request_id"]
    assert error["status_code"] == 503
    assert "RuntimeError: milvus timeout" in error["error"]
    # 失败发生在检索阶段，最后完成的是改写。
    assert error["last_step"] == "query"
    assert [step["id"] for step in error["steps"]][-1] == "query"
    # 同一 request_id 重试成功后正常保存，不受失败记录影响。
    monkeypatch.undo()
    assert client.post("/chat", headers=headers(), json=payload).status_code == 200
    assert saved_run(store, payload["request_id"]) is not None


# 流式接口出错时同样写入 run_errors。
def test_stream_failure_is_recorded(setup, monkeypatch):
    client, store = setup
    def broken(*args, **kwargs):
        raise RuntimeError("rerank down")
    monkeypatch.setattr(DocumentSearchTool, "execute", broken)
    response = client.post("/chat/stream", headers=headers(), json=question(session(client), "退货政策"))
    assert "event: error" in response.text
    with store.engine.connect() as connection:
        errors = connection.execute(select(run_errors)).mappings().all()
    assert len(errors) == 1 and errors[0]["last_step"] == "query"


# 点踩、在历史和反馈列表中查看、改成点赞后覆盖原记录并清掉原因。
def test_feedback_flow(setup):
    client, store = setup
    session_id = session(client)
    payload = question(session_id, "订单 A1001")
    assert client.post("/chat", headers=headers(), json=payload).status_code == 200
    run_id = payload["request_id"]
    down = client.post("/feedback", headers=headers(), json={"request_id": run_id, "rating": -1,
        "reason": "wrong", "comment": "应该是后天到"})
    assert down.status_code == 200
    assert down.json()["reason_label"] == "答错了"
    history = client.get("/history", headers=headers()).json()["messages"]
    assert history[-1]["feedback"]["rating"] == -1
    assert history[-1]["feedback"]["comment"] == "应该是后天到"
    listed = client.get("/feedback", headers=headers()).json()
    assert [item["request_id"] for item in listed["items"]] == [run_id]
    assert listed["items"][0]["question"] == "订单 A1001"
    assert listed["items"][0]["trace"]["route"] == "order"
    assert listed["reasons"]["missed"] == "资料里有却说找不到"
    # 改成点赞：覆盖原记录并清掉点踩原因，默认列表只看点踩，因此不再出现。
    up = client.post("/feedback", headers=headers(), json={"request_id": run_id, "rating": 1, "reason": "wrong"})
    assert up.status_code == 200 and up.json()["reason"] is None
    with store.engine.connect() as connection:
        assert len(connection.execute(select(feedback)).all()) == 1
    assert client.get("/feedback", headers=headers()).json()["items"] == []
    assert len(client.get("/feedback?rating=0", headers=headers()).json()["items"]) == 1


# 不能评价别人的回答；评分只能是 1 或 -1，原因必须是固定选项，回答不存在时返回 404。
def test_feedback_validation_and_owner_boundary(setup):
    client, _ = setup
    payload = question(session(client), "订单 A1001")
    assert client.post("/chat", headers=headers(), json=payload).status_code == 200
    run_id = payload["request_id"]
    assert client.post("/feedback", headers=headers("bob"), json={"request_id": run_id, "rating": -1}).status_code == 404
    assert client.get("/feedback", headers=headers("bob")).json()["items"] == []
    assert client.post("/feedback", headers=headers(), json={"request_id": run_id, "rating": 0}).status_code == 422
    assert client.post("/feedback", headers=headers(), json={"request_id": run_id, "rating": -1,
        "reason": "unknown"}).status_code == 422
    missing = question(session(client), "x")["request_id"]
    assert client.post("/feedback", headers=headers(), json={"request_id": missing, "rating": 1}).status_code == 404


# LangChain 的 usage_metadata 转成统一字段；模型没返回用量时为 None。
def test_token_usage_is_normalized():
    message = AIMessage(content="答", usage_metadata={"input_tokens": 120, "output_tokens": 30, "total_tokens": 150})
    assert ResponseAgent.token_usage(message) == {"input": 120, "output": 30, "total": 150}
    assert ResponseAgent.token_usage(AIMessage(content="答")) is None


# 结果缺少阶段记录时摘要仍能生成，不抛异常。
def test_summary_tolerates_minimal_result():
    summary = summarize_run({"route": "greeting", "answer": "你好", "steps": []})
    assert summary["route"] == "greeting" and summary["refused"] is False
    assert summary["duration_ms"] is None


# 补充检索和充分性判断分别记录，最高分取两次检索中较高的一次。
def test_summary_records_sufficiency_and_retry():
    def retrieval(score):
        return {"stats": {"returned": 1}, "diagnostics": {"config": {"reranked": True},
            "candidates": [{"chunk_id": "v1:0", "chunk_key": "k", "source_id": "S1", "status": "returned",
                "rrf_rank": 1, "rerank_probability": score}]}}
    steps = [
        {"id": "retrieval", "duration_ms": 10, "result": retrieval(0.4)},
        {"id": "retrieval_retry", "duration_ms": 12, "result": retrieval(0.7)},
        {"id": "sufficiency", "duration_ms": 30, "result": {"checked": True, "verdict": "partial",
            "retried": True, "retry_query": "护城河 定义", "refused": False, "missing": ["定义"]}},
    ]
    summary = summarize_run({"route": "knowledge", "answer": "答 [S1]", "steps": steps})
    assert summary["sufficiency"]["verdict"] == "partial"
    assert summary["retrieval_retry"]["top_score"] == 0.7
    assert run_columns(summary)["top_score"] == 0.7
