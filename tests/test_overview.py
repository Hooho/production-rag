from datetime import datetime, timezone

from app.mysql.tables import feedback, run_errors, runs
from app.overview import overview
from test_app import headers, setup  # noqa: F401  复用 API 测试的内存存储夹具


def add_run(connection, run_id, created, route="knowledge", refused=False, duration=1000, top=0.9, tokens=100):
    trace = {"route": route, "stage_ms": {"retrieval": duration // 2, "response": duration // 3},
        "generation": {"token_usage": {"input": tokens - 10, "output": 10, "total": tokens}},
        "retrieval": {"returned": 0 if refused else 3, "filtered": 2}}
    connection.execute(runs.insert().values(id=run_id, session_id="s", owner="alice", question="q", response={},
        created=created, route=route, refused=refused, duration_ms=duration, top_score=top, trace=trace))


# 按业务时区（北京时间）分天：UTC 10-03 17:00 是北京时间 10-04 01:00，算在 10-04。
def test_overview_daily_totals(setup):
    client, store = setup
    with store.engine.begin() as connection:
        add_run(connection, "r1", "2026-10-03T17:00:00+00:00", duration=1000)
        add_run(connection, "r2", "2026-10-04T02:00:00+00:00", refused=True, duration=3000, top=0.7)
        add_run(connection, "r3", "2026-10-04T03:00:00+00:00", route="order", duration=500, tokens=0)
        add_run(connection, "old", "2026-09-01T00:00:00+00:00")
        connection.execute(run_errors.insert().values(id="e1", request_id="x", session_id="s", owner="alice", question="q",
            status_code=503, error="boom", last_step="retrieval", steps=[], duration_ms=10, created="2026-10-04T04:00:00+00:00"))
        connection.execute(feedback.insert().values(run_id="r1", owner="alice", session_id="s", rating=-1, reason="wrong",
            comment=None, created="2026-10-04T05:00:00+00:00", updated="2026-10-04T05:00:00+00:00"))
        connection.execute(feedback.insert().values(run_id="r3", owner="alice", session_id="s", rating=1, reason=None,
            comment=None, created="2026-10-04T05:00:00+00:00", updated="2026-10-04T05:00:00+00:00"))
    result = overview(store.engine, 7, now=datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc))
    totals = result["totals"]
    assert result["to"] == "2026-10-04" and len(result["daily"]) == 7
    assert totals["requests"] == 4 and totals["runs"] == 3 and totals["errors"] == 1 and totals["error_rate"] == 0.25
    assert totals["knowledge"] == 2 and totals["refusal_rate"] == 0.5
    assert totals["p50_ms"] == 1000 and totals["p95_ms"] == 3000
    assert totals["tokens"]["total"] == 200 and totals["avg_tokens"] == 100
    assert totals["down_rate"] == 0.5 and result["feedback_reasons"][0]["label"] == "答错了"
    today = result["daily"][-1]
    assert today["requests"] == 4 and today["errors"] == 1 and today["refused"] == 1
    assert {item["stage"] for item in result["stages"]} == {"retrieval", "response"}
    assert result["routes"][0] == {"route": "knowledge", "label": "知识问答", "count": 2}
    assert result["errors"]["stages"][0]["label"] == "检索"
    assert result["retrieval"]["returned_zero"] == 1 and result["retrieval"]["below_threshold"] == 1


def test_overview_api_admin_only(setup):
    client, _ = setup
    assert client.get("/overview", headers=headers("bob")).status_code == 403
    assert client.get("/overview?days=5", headers=headers("admin")).status_code == 422
    assert client.get("/overview?days=30", headers=headers("admin")).json()["days"] == 30


# 意图识别四个环节的命中率：命中 / 到达；占比：命中 / 全部识别。旧记录从完整记录的识别过程里补出路径。
def test_overview_intent_hit_rates(setup):
    from app.observability import intent_path
    client, store = setup
    rule = [{"stage": "rule", "accepted": True}]
    small = [{"stage": "rule", "accepted": False}, {"stage": "small_model", "accepted": True}]
    llm = [{"stage": "rule", "accepted": False}, {"stage": "small_model", "accepted": False}, {"stage": "llm", "accepted": True}]
    fallback = [{"stage": "rule", "accepted": False}, {"stage": "small_model", "accepted": False},
        {"stage": "llm", "accepted": False, "failure": "error"}, {"stage": "fallback", "accepted": True}]
    with store.engine.begin() as connection:
        for index, path in enumerate([rule, rule, small, llm, fallback]):
            connection.execute(runs.insert().values(id=f"i{index}", session_id="s", owner="alice", question="q", response={},
                created="2026-10-04T02:00:00+00:00", route="knowledge", refused=False, duration_ms=1, top_score=None,
                trace={"intent": {"classifier": "x", "path": path}}))
        # 旧记录：摘要里没有 path，从 response 的意图识别步骤里补。
        old_trace = [{"stage": "rule", "result": "未命中", "accepted": False},
            {"stage": "small_model", "result": "x", "accepted": False},
            {"stage": "llm", "result": "输出不符合格式要求", "accepted": False}, {"stage": "fallback", "accepted": True}]
        connection.execute(runs.insert().values(id="old", session_id="s", owner="alice", question="q",
            response={"steps": [{"id": "intent", "result": {"trace": old_trace}}]},
            created="2026-10-04T02:00:00+00:00", route="knowledge", refused=False, duration_ms=1, top_score=None,
            trace={"intent": {"classifier": "fallback"}}))
    view = overview(store.engine, 7, now=datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc))["intent"]
    stages = {item["stage"]: item for item in view["stages"]}
    assert view["runs"] == 6
    assert (stages["rule"]["reached"], stages["rule"]["accepted"], stages["rule"]["hit_rate"]) == (6, 2, 0.3333)
    assert (stages["small_model"]["reached"], stages["small_model"]["accepted"], stages["small_model"]["hit_rate"]) == (4, 1, 0.25)
    assert (stages["llm"]["reached"], stages["llm"]["accepted"], stages["llm"]["hit_rate"]) == (3, 1, 0.3333)
    assert stages["fallback"]["accepted"] == 2 and stages["fallback"]["hit_rate"] is None and stages["fallback"]["share"] == 0.3333
    assert {item["cause"]: item["count"] for item in view["fallback_causes"]} == {"error": 1, "invalid": 1}
    assert intent_path({"trace": old_trace})[2] == {"stage": "llm", "accepted": False, "failure": "invalid"}
