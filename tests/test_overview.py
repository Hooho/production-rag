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


# 拒答原因和安全检查的分布。
def test_overview_refusals_and_security(setup):
    from app.observability import refusal_reason, summarize_run
    client, store = setup
    traces = {
        "a": {"route": "knowledge", "retrieval": {"returned": 0, "dense_hits": 0, "keyword_hits": 0}},
        "b": {"route": "knowledge", "retrieval": {"returned": 0, "dense_hits": 5, "keyword_hits": 2, "filtered": 7}},
        "c": {"route": "knowledge", "retrieval": {"returned": 3}, "sufficiency": {"verdict": "insufficient", "refused": True}},
        "d": {"route": "knowledge", "retrieval": {"returned": 3}, "citation": {"passed": False, "reason": "unknown_source"},
            "security": {"redacted_sources": 2, "output_issues": [{"type": "link_removed"}]}},
        "e": {"route": "knowledge", "retrieval": {"returned": 3}, "citation": {"passed": False, "reason": "no_citation", "self_refusal": True}},
        "f": {"route": "knowledge", "retrieval": {"returned": 3}, "sufficiency": {"verdict": "partial"}},
        "g": {"route": "blocked", "security": {"blocked": True, "rules": [{"rule": "override"}, {"rule": "override"}]}},
    }
    with store.engine.begin() as connection:
        for key, trace in traces.items():
            connection.execute(runs.insert().values(id=key, session_id="s", owner="alice", question="q", response={},
                created="2026-10-04T02:00:00+00:00", route=trace["route"], refused=key not in ("f", "g"), duration_ms=1,
                top_score=None, trace=trace))
    result = overview(store.engine, 7, now=datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc))
    reasons = {item["reason"]: item["count"] for item in result["refusals"]["reasons"]}
    assert reasons == {"no_hits": 1, "below_threshold": 1, "sufficiency": 1, "unknown_source": 1, "self_refusal": 1}
    assert result["refusals"]["partial"] == 1
    security = result["security"]
    assert security["blocked"] == 1 and security["rules"] == [{"key": "override", "label": "要求忽略原有指令", "count": 1}]
    assert security["redacted_runs"] == 1 and security["redacted"] == 2 and security["issues"][0]["label"] == "来源外链接"
    # 摘要里记下拒答原因；模型原话在说资料没有、又没标引用，算模型自己拒答。
    summary = summarize_run({"route": "knowledge", "answer": "模型没有返回可校验的引用", "steps": [
        {"id": "retrieval", "result": {"stats": {"returned": 2}}},
        {"id": "response", "result": {"citation_check": {"passed": False, "reason": "no_citation", "raw_answer": "资料中没有提及这一点。"}}}]})
    assert summary["refusal_reason"] == "self_refusal"
    assert refusal_reason({"citation": {"passed": False, "reason": "no_citation"}}) == "no_citation"


# 文档导入：结果分布、各步骤耗时、最慢的版本，以及向量复用、上下文缓存、跨用户复制省下的计算；评测账号上传的不算。
def test_overview_imports(setup):
    from app.mysql.tables import document_steps, documents
    client, store = setup
    created = "2026-10-04T02:00:00+00:00"

    def add_doc(connection, doc_id, status, owner="alice", metadata=None, steps=()):
        connection.execute(documents.insert().values(id=doc_id, owner=owner, title=f"doc-{doc_id}", filename="a.md",
            path="x", status=status, document_metadata=metadata or {}, created=created, updated=created,
            doc_key=doc_id, version=1))
        for order, (step_id, duration, detail) in enumerate(steps):
            connection.execute(document_steps.insert().values(document_id=doc_id, step_id=step_id, step_order=order,
                stage=step_id, title=step_id, status="completed", detail=detail, duration_ms=duration, updated=created))

    with store.engine.begin() as connection:
        add_doc(connection, "d1", "ready:3", metadata={"reused_vectors": 2, "embedded_vectors": 1,
            "context_generated": 3, "context_cached": 2},
            steps=[("parsing", 100, "第 2 次尝试（上次写入校验不一致），开始解析"), ("embedding", 900, "ok"), ("scan", 200, "ok")])
        add_doc(connection, "d2", "flagged:2", metadata={"copied_from": "d1", "reused_vectors": 2, "embedded_vectors": 0},
            steps=[("indexing", 50, "ok"), ("scan", 100, "ok")])
        add_doc(connection, "d3", "failed")
        add_doc(connection, "e1", "ready:1", owner="eval", steps=[("embedding", 99999, "ok")])
    imports = overview(store.engine, 7, now=datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc))["imports"]
    assert imports["versions"] == 3 and imports["retried"] == 1
    assert {item["key"]: item["count"] for item in imports["results"]} == {"listed": 1, "flagged": 1, "failed": 1}
    steps = {item["step"]: item for item in imports["steps"]}
    assert steps["embedding"]["avg_ms"] == 900 and steps["scan"]["count"] == 2 and steps["scan"]["avg_ms"] == 150
    assert steps["embedding"]["share"] == round(900 / 1350, 4)
    assert imports["slowest"][0]["document_id"] == "d1" and imports["slowest"][0]["slowest_step"] == "生成向量"
    savings = imports["savings"]
    assert savings["copied"] == 1 and savings["vector_reuse_rate"] == 0.8 and savings["context_cache_rate"] == round(2 / 3, 4)
