from sqlalchemy import select

from app.inspection.service import LOCK_KEY, run_inspection
from app.models import Models
from app.mysql.store import inspection_issue_events, inspection_issues, inspection_runs
from app.tools.search import DocumentSearchTool
from test_app import headers, question, session, setup  # noqa: F401  复用 API 测试的内存存储夹具


def ask(client, text, owner="alice"):
    payload = question(session(client, owner), text)
    assert client.post("/chat", headers=headers(owner), json=payload).status_code == 200
    return payload["request_id"]


def upload(client, owner="alice", title="售后", content="退货政策：退货期限 7 天，运费由买家承担。"):
    response = client.post("/documents", headers=headers(owner), json={"title": title, "content": content})
    assert response.status_code == 200
    return response.json()["document_id"]


def issues(store, kind=None):
    query = select(inspection_issues)
    if kind:
        query = query.where(inspection_issues.c.kind == kind)
    with store.engine.connect() as connection:
        return connection.execute(query.order_by(inspection_issues.c.created)).mappings().all()


def inspect(client, store):
    return run_inspection(store, client.app.state.models)["summary"]


# 拒答的问题按语义聚成一个知识缺口，记录次数和人数；重复巡检不重复计数，也不新建问题。
def test_refusals_merge_into_one_gap(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "跨境商品能不能退货")
    ask(client, "跨境商品能不能退货")
    ask(client, "跨境商品能不能退货", owner="bob")
    ask(client, "发票抬头怎么修改")
    summary = inspect(client, store)
    assert summary["scanned_runs"] == 4
    assert summary["created_knowledge_gap"] == 2
    gaps = {row["title"]: row for row in issues(store, "knowledge_gap")}
    crossborder = gaps["跨境商品能不能退货"]
    assert crossborder["occurrences"] == 3 and crossborder["users"] == 2
    assert crossborder["detail"]["signals"] == {"refused": 3}
    assert crossborder["detail"]["questions"] == ["跨境商品能不能退货"]
    # 聚类中心只在服务端使用。
    assert crossborder["vector"]
    again = inspect(client, store)
    assert again.get("created_knowledge_gap", 0) == 0
    with store.engine.connect() as connection:
        assert len(connection.execute(select(inspection_issue_events)).all()) == 4
    assert {row["occurrences"] for row in issues(store, "knowledge_gap")} == {3, 1}


# 标记已处理后又出现同类问答：下次巡检自动重新打开；忽略的问题继续累计但保持忽略。
def test_handled_issue_reopens_and_ignored_stays(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "跨境商品能不能退货")
    ask(client, "发票抬头怎么修改")
    inspect(client, store)
    gaps = {row["title"]: row["id"] for row in issues(store, "knowledge_gap")}
    crossborder, invoice = gaps["跨境商品能不能退货"], gaps["发票抬头怎么修改"]
    assert client.patch(f"/inspection/issues/{crossborder}", headers=headers("admin"),
        json={"status": "handled", "fix_type": "add_content", "note": "补了跨境退货说明"}).status_code == 200
    assert client.patch(f"/inspection/issues/{invoice}", headers=headers("admin"),
        json={"status": "ignored", "close_reason": "out_of_scope"}).status_code == 200
    ask(client, "跨境商品能不能退货")
    ask(client, "发票抬头怎么修改")
    summary = inspect(client, store)
    assert summary["reopened"] == 1
    rows = {row["id"]: row for row in issues(store, "knowledge_gap")}
    assert rows[crossborder]["status"] == "open" and rows[crossborder]["status_by"] == "system"
    assert rows[crossborder]["detail"]["reopened"]["previous_status"] == "handled"
    assert rows[crossborder]["detail"]["reopened"]["new_occurrences"] == 1
    assert rows[crossborder]["note"] == "补了跨境退货说明"
    assert rows[invoice]["status"] == "ignored" and rows[invoice]["occurrences"] == 2


# 被引用的分片多次收到差评成为可疑内容；文档删除后分片不在当前版本中，巡检自动标记为已解决。
# "资料里有却说找不到"的差评说明没检索到，归入知识缺口而不是可疑内容。
def test_negative_feedback_flags_content_until_it_changes(setup):
    client, store = setup
    document_id = upload(client)
    first = ask(client, "退货政策")
    second = ask(client, "退货运费谁承担")
    missed = ask(client, "退货期限是多久")
    for run_id, reason in ((first, "wrong"), (second, None), (missed, "missed")):
        body = {"request_id": run_id, "rating": -1, "reason": reason}
        assert client.post("/feedback", headers=headers(), json=body).status_code == 200
    summary = inspect(client, store)
    assert summary["created_suspect_content"] == 1
    content = issues(store, "suspect_content")[0]
    assert content["occurrences"] == 2 and content["status"] == "open"
    assert content["detail"]["cited"] == 3
    assert content["detail"]["negative_rate"] == round(2 / 3, 3)
    assert content["detail"]["document_title"] == "售后"
    assert "退货期限" in content["detail"]["preview"]
    assert content["title"].startswith("《售后》")
    gap = issues(store, "knowledge_gap")[0]
    assert gap["detail"]["signals"] == {"feedback_missed": 1}
    assert client.delete(f"/documents/{document_id}", headers=headers()).status_code == 200
    summary = inspect(client, store)
    assert summary["auto_resolved"] == 1
    resolved = issues(store, "suspect_content")[0]
    assert resolved["status"] == "resolved" and resolved["status_by"] == "system"
    assert "当前版本" in resolved["detail"]["resolution"]


# 差评太少不报：一条差评达不到默认阈值（至少 2 条）。
def test_single_negative_feedback_is_not_reported(setup):
    client, store = setup
    upload(client)
    run_id = ask(client, "退货政策")
    assert client.post("/feedback", headers=headers(), json={"request_id": run_id, "rating": -1}).status_code == 200
    summary = inspect(client, store)
    assert summary.get("created_suspect_content", 0) == 0


# 处理失败按出错阶段和错误信息合并成系统问题，错误里的数字不影响合并。
def test_run_errors_merge_into_system_issue(setup, monkeypatch):
    client, store = setup
    calls = {"count": 0}

    def broken(*args, **kwargs):
        calls["count"] += 1
        raise RuntimeError(f"milvus timeout after {calls['count']}s")
    monkeypatch.setattr(DocumentSearchTool, "execute", broken)
    for text in ("退货政策", "运费"):
        assert client.post("/chat", headers=headers(), json=question(session(client), text)).status_code == 503
    summary = inspect(client, store)
    assert summary["scanned_errors"] == 2 and summary["created_system_error"] == 1
    error = issues(store, "system_error")[0]
    assert error["occurrences"] == 2 and error["detail"]["last_step"] == "query"
    # 标题和详情用步骤的中文名，管理员不用对照代码就知道错在哪一步。
    assert error["title"].startswith("处理失败：「改写查询」之后出错")
    assert error["detail"]["last_step_label"] == "改写查询"
    assert "milvus timeout" in error["detail"]["error"]


# 巡检接口只允许管理员调用；详情带关联问答；已解决不能手动设置；页面发起的巡检在后台完成。
def test_inspection_api_is_admin_only(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    run_id = ask(client, "跨境商品能不能退货")
    for method, path in (("get", "/inspection/issues"), ("get", "/inspection/runs"), ("post", "/inspection/runs")):
        assert getattr(client, method)(path, headers=headers()).status_code == 403
    started = client.post("/inspection/runs", headers=headers("admin"), json={"days": 7})
    assert started.status_code == 202
    client.app.state.inspection_thread.join(timeout=10)
    runs = client.get("/inspection/runs", headers=headers("admin")).json()
    assert runs["running"] is False
    assert runs["runs"][0]["status"] == "completed" and runs["runs"][0]["trigger"] == "api"
    assert runs["runs"][0]["triggered_by"] == "admin"
    listed = client.get("/inspection/issues?status=open", headers=headers("admin")).json()
    assert listed["total"] == 1 and listed["status_counts"] == {"open": 1}
    assert listed["last_run"]["id"] == started.json()["id"]
    item = listed["items"][0]
    assert "vector" not in item
    assert client.get(f"/inspection/issues/{item['id']}", headers=headers()).status_code == 403
    detail = client.get(f"/inspection/issues/{item['id']}", headers=headers("admin")).json()
    assert detail["events"][0]["source_id"] == run_id
    assert detail["events"][0]["question"] == "跨境商品能不能退货"
    assert detail["events"][0]["owner"] == "alice"
    assert client.patch(f"/inspection/issues/{item['id']}", headers=headers("admin"),
        json={"status": "resolved"}).status_code == 422
    assert client.patch(f"/inspection/issues/{item['id']}", headers=headers(),
        json={"status": "ignored"}).status_code == 403
    assert client.patch("/inspection/issues/missing", headers=headers("admin"),
        json={"status": "ignored", "close_reason": "out_of_scope"}).status_code == 404
    assert client.get("/inspection/issues?status=bad", headers=headers("admin")).status_code == 422


# 同一时间只允许一次巡检：锁被占用时页面返回 409。
def test_concurrent_inspection_is_rejected(setup):
    client, store = setup
    store.cache.set(LOCK_KEY, "other-run")
    assert client.post("/inspection/runs", headers=headers("admin")).status_code == 409
    store.cache.delete(LOCK_KEY)
    with store.engine.connect() as connection:
        assert connection.execute(select(inspection_runs)).all() == []


# 引用检查区分两种不通过：没有引用任何来源，引用了本轮不存在的来源编号。
def test_check_citations_reasons():
    sources = [{"id": "S1"}, {"id": "S2"}]
    assert Models.check_citations("答案 [S2][S1]", sources) == {"passed": True, "reason": None,
        "source_ids": ["S1", "S2"], "cited": ["S1", "S2"], "unknown": []}
    assert Models.check_citations("没有标注", sources)["reason"] == "no_citation"
    fake = Models.check_citations("答案 [S1] 和 [S3]", sources)
    assert fake["reason"] == "unknown_source" and fake["unknown"] == ["S3"]


# 回答因引用被拦截时保存模型原话和原因；巡检详情据此说明"检索返回了几段、模型没引用 / 编造了编号"。
def test_rejected_answer_is_kept_for_inspection(setup, monkeypatch):
    import time
    from uuid import uuid4
    from datetime import datetime, timezone
    from app.models import CITATION_REJECTED
    from app.mysql.store import runs
    from app.observability import run_columns, summarize_run
    client, store = setup
    agent = client.app.state.agent
    models = client.app.state.models
    monkeypatch.setattr(models, "mode", "openai")
    monkeypatch.setattr(agent.response_agent, "answer", lambda *args, **kwargs: ("今西纮史是一位研究者 [S3]。", {
        "summary": "", "turns": [], "summary_updated": False, "previous_message_count": 0, "message_count": 1}))
    state = {"owner": "admin", "session_id": "s1", "question": "今西纮史 是谁", "ai_memories": [], "models": models,
        "steps": [], "started_at": time.monotonic(),
        "sources": [{"id": "S1", "title": "资料", "text": "内容"}, {"id": "S2", "title": "资料", "text": "内容"}]}
    result = agent.generate_response(state)
    assert result["answer"] == CITATION_REJECTED
    check = state["steps"][-1]["result"]["citation_check"]
    assert check["reason"] == "unknown_source" and check["unknown"] == ["S3"]
    assert check["raw_answer"] == "今西纮史是一位研究者 [S3]。"
    response = {"answer": result["answer"], "route": "knowledge", "steps": state["steps"], "sources": state["sources"]}
    summary = summarize_run(response)
    assert summary["citation"] == {"passed": False, "reason": "unknown_source", "source_count": 2, "unknown": ["S3"]}
    summary["retrieval"] = {"returned": 2, "top_score": 0.99, "candidates": []}
    run_id = str(uuid4())
    with store.engine.begin() as connection:
        connection.execute(runs.insert().values(id=run_id, session_id="s1", owner="admin", question="今西纮史 是谁",
            response=response, created=datetime.now(timezone.utc).isoformat(), **run_columns(summary)))
    inspect(client, store)
    issue = issues(store, "system_error")[0]
    assert issue["title"] == "回答被拦截：模型没有按要求引用检索到的资料"
    event = client.get(f"/inspection/issues/{issue['id']}", headers=headers("admin")).json()["events"][0]
    assert event["returned"] == 2
    assert event["citation"]["raw_answer"] == "今西纮史是一位研究者 [S3]。"
    # 调用摘要：回答模型及用在哪一步、提示词版本。
    assert event["call"]["models"][0]["steps"] == ["生成回答"]
    assert event["call"]["prompt_version"]
    # 交给模型的资料原文也在详情里，页面折叠显示。
    assert [source["id"] for source in event["sources"]] == ["S1", "S2"]
    assert event["sources"][0]["text"] == "内容" and event["sources"][0]["truncated"] is False
    # 这类回答不算知识缺口：资料是找到了的。
    assert issues(store, "knowledge_gap") == []


# 旧版本标题带"知识缺口："前缀，和类型标签重复；再次巡检时去掉。
def test_old_title_prefix_is_removed(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "跨境商品能不能退货")
    inspect(client, store)
    issue_id = issues(store, "knowledge_gap")[0]["id"]
    with store.engine.begin() as connection:
        connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id).values(
            title="知识缺口：跨境商品能不能退货"))
    inspect(client, store)
    assert issues(store, "knowledge_gap")[0]["title"] == "跨境商品能不能退货"


# 下一次定时巡检时间：从"上次定时巡检"和"保存设置"中较晚的时间算起，关闭时没有下一次。
def test_schedule_next_run(monkeypatch):
    from datetime import datetime, timezone
    from app.inspection import schedule as schedule_module
    monkeypatch.setenv("BUSINESS_TZ", "Asia/Shanghai")
    daily = {"enabled": True, "mode": "daily", "time": "08:00", "interval_hours": 24, "days": 30,
        "updated": "2026-10-02T23:00:00+00:00"}
    # 北京时间 07:00 保存，当天 08:00（UTC 00:00）执行。
    assert schedule_module.next_run(daily) == datetime(2026, 10, 3, 0, 0, tzinfo=timezone.utc)
    # 当天 08:00 已经执行过，下一次是第二天 08:00。
    assert schedule_module.next_run(daily, "2026-10-03T00:00:05+00:00") == datetime(2026, 10, 4, 0, 0, tzinfo=timezone.utc)
    interval = {**daily, "mode": "interval", "interval_hours": 6}
    assert schedule_module.next_run(interval, "2026-10-03T01:00:00+00:00") == datetime(2026, 10, 3, 7, 0, tzinfo=timezone.utc)
    assert schedule_module.next_run({**daily, "enabled": False}) is None


# 定时巡检设置只有管理员能看和改；保存后返回下一次执行时间，不合法的设置返回 422。
def test_schedule_api(setup):
    client, _ = setup
    assert client.get("/inspection/schedule", headers=headers()).status_code == 403
    view = client.get("/inspection/schedule", headers=headers("admin")).json()
    assert view["schedule"]["enabled"] is False and view["next_run"] is None
    body = {"enabled": True, "mode": "interval", "time": "08:00", "interval_hours": 12, "days": 7}
    assert client.put("/inspection/schedule", headers=headers(), json=body).status_code == 403
    saved = client.put("/inspection/schedule", headers=headers("admin"), json=body).json()
    assert saved["schedule"]["interval_hours"] == 12 and saved["schedule"]["updated_by"] == "admin"
    assert saved["next_run"] > saved["schedule"]["updated"]
    for bad in ({**body, "time": "25:00"}, {**body, "mode": "weekly"}, {**body, "interval_hours": 0}, {**body, "days": 400}):
        assert client.put("/inspection/schedule", headers=headers("admin"), json=bad).status_code == 422
    # 手动巡检的扫描范围和定时设置一致。
    started = client.post("/inspection/runs", headers=headers("admin"))
    assert started.status_code == 202
    client.app.state.inspection_thread.join(timeout=10)
    run = client.get("/inspection/runs", headers=headers("admin")).json()["runs"][0]
    from datetime import datetime, timedelta, timezone
    since = datetime.fromisoformat(run["since"])
    assert abs((datetime.now(timezone.utc) - since) - timedelta(days=7)) < timedelta(minutes=5)


# worker 每轮检查：到点才执行，执行后记录为定时巡检；同一轮里不重复启动。
def test_schedule_runner_runs_when_due(setup):
    from datetime import datetime, timedelta, timezone
    from app.inspection.schedule import SETTING_KEY, ScheduleRunner, save_schedule
    from app.mysql.store import settings
    client, store = setup
    save_schedule(store, {"enabled": True, "mode": "interval", "interval_hours": 1, "days": 30}, "admin")
    runner = ScheduleRunner(store, client.app.state.models)
    assert runner.tick(monotonic=100.0) is False
    # 把保存时间改到两小时前，模拟已经到点。
    with store.engine.begin() as connection:
        connection.execute(settings.update().where(settings.c.key == SETTING_KEY).values(
            updated=(datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()))
    assert runner.tick(monotonic=101.0) is False  # 30 秒内不重复检查
    assert runner.tick(monotonic=200.0) is True
    runner.thread.join(timeout=10)
    with store.engine.connect() as connection:
        triggers = connection.execute(select(inspection_runs.c.trigger, inspection_runs.c.status)).all()
    assert triggers == [("schedule", "completed")]
    # 刚执行过，下一次要再等一小时。
    assert runner.tick(monotonic=300.0) is False


# 按关键词打分的重排替身：问题和资料都提到"退货"时给 score，否则 0.01。
def keyword_rerank(score):
    return lambda self, query, documents: [score if "退货" in query and "退货" in text else 0.01 for text in documents]


# 权限缺口：bob 看不到 alice 的私有文档，全库检索能找到。标记已处理但没改权限，验证不通过并重新打开；
# 改成公开后再标记已处理，验证通过、自动关闭。
def test_permission_gap_and_verification(setup, monkeypatch):
    client, store = setup
    document_id = upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    summary = inspect(client, store)
    assert summary["diagnosed"] == 1
    gap = issues(store, "knowledge_gap")[0]
    diagnosis = gap["detail"]["diagnosis"]
    assert diagnosis["category"] == "permission" and diagnosis["label"] == "权限缺口"
    # 页面用判断门槛把分数解释成"差多少才算相关"。
    assert diagnosis["thresholds"]["min_score"] == 0.85
    question = diagnosis["questions"][0]
    assert question["owner"] == "bob" and question["full_top"] == 0.95
    assert question["documents"][0]["title"] == "售后" and question["documents"][0]["owner"] == "alice"
    assert question["documents"][0]["visibility"] == "private"
    # 只点了已处理、没改权限：验证不通过，重新打开。
    assert client.patch(f"/inspection/issues/{gap['id']}", headers=headers("admin"), json={"status": "handled", "fix_type": "add_content"}).status_code == 200
    summary = inspect(client, store)
    assert summary["verification_failed"] == 1
    reopened = issues(store, "knowledge_gap")[0]
    assert reopened["status"] == "open" and "还有 1 个没解决" in reopened["detail"]["verification"]["message"]
    # 改成公开后验证通过。
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "public", "groups": []}).status_code == 200
    assert client.patch(f"/inspection/issues/{gap['id']}", headers=headers("admin"), json={"status": "handled", "fix_type": "add_content"}).status_code == 200
    summary = inspect(client, store)
    assert summary["verified"] == 1
    resolved = issues(store, "knowledge_gap")[0]
    assert resolved["status"] == "resolved" and resolved["status_by"] == "system"
    assert resolved["detail"]["resolution"].startswith("验证通过") and "《售后》" in resolved["detail"]["resolution"]
    assert "verification" not in resolved["detail"]


# 其余类别：全库得分很低算超出范围，中等算内容缺口，接近阈值算检索缺口；
# 之后补了资料、现在能检索到的，不用管理员操作就自动关闭。
def test_gap_categories_and_auto_resolve(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "退货要多久")
    inspect(client, store)
    expectations = ((0.01, "out_of_scope"), (0.2, "content"), (0.6, "retrieval"))
    for score, category in expectations:
        monkeypatch.setattr(Models, "rerank", lambda self, query, documents, score=score: [score] * len(documents))
        inspect(client, store)
        assert issues(store, "knowledge_gap")[0]["detail"]["diagnosis"]["category"] == category
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    summary = inspect(client, store)
    assert summary["auto_resolved"] == 1
    gap = issues(store, "knowledge_gap")[0]
    assert gap["status"] == "resolved" and gap["detail"]["resolution"].startswith("现在能答")


# 重排不可用时无法按相关度判断，不改变问题状态；主结论按出现次数和优先级取。
def test_diagnosis_without_rerank_and_overall_category(setup, monkeypatch):
    from app.inspection.diagnosis import overall_category
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "退货要多久")
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: None)
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]
    assert gap["status"] == "open" and gap["detail"]["diagnosis"]["category"] == "unknown"
    assert overall_category(["answerable", "answerable"]) == "answerable"
    assert overall_category(["answerable", "content", "permission"]) == "permission"
    assert overall_category(["content", "content", "permission"]) == "content"


# 详情页的"重新检索"：只诊断这一个缺口，记录是谁手动验证的；诊断结果带上重新检索到的资料和提问人能否看到。
def test_manual_verify(setup, monkeypatch):
    client, store = setup
    document_id = upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    run_inspection(store, client.app.state.models)
    gap = issues(store, "knowledge_gap")[0]
    assert client.post(f"/inspection/issues/{gap['id']}/verify", headers=headers()).status_code == 403
    assert client.post("/inspection/issues/missing/verify", headers=headers("admin")).status_code == 404
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    verified = client.post(f"/inspection/issues/{gap['id']}/verify", headers=headers("admin")).json()
    diagnosis = verified["detail"]["diagnosis"]
    assert diagnosis["category"] == "permission" and diagnosis["trigger"] == "manual" and diagnosis["checked_by"] == "admin"
    # 只保留得分最高的一段：bob 能看到的里面没有，全库里这段最高。
    assert len(diagnosis["questions"][0]["chunks"]) == 1
    chunk = diagnosis["questions"][0]["chunks"][0]
    assert chunk["scope"] == "all" and chunk["visible"] is False and chunk["passed"] is True
    assert "退货期限" in chunk["text"] and chunk["score"] == 0.95
    assert verified["status"] == "open"
    # 改成公开后再验证：现在能答，自动关闭。
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "public", "groups": []}).status_code == 200
    verified = client.post(f"/inspection/issues/{gap['id']}/verify", headers=headers("admin")).json()
    assert verified["status"] == "resolved" and verified["verify_result"]["auto_resolved"] == 1
    assert verified["detail"]["diagnosis"]["questions"][0]["chunks"][0]["visible"] is True
    # 已解决的问题也能再验证，只更新诊断，不改状态。
    again = client.post(f"/inspection/issues/{gap['id']}/verify", headers=headers("admin")).json()
    assert again["status"] == "resolved"



# 标记"无需处理"必须选原因，"其他"要写备注；推荐原因按诊断结论给出；列表能按原因筛选，顶部统计区分合理拒答。
def test_close_reason_and_gap_summary(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "发票抬头怎么修改")
    ask(client, "发票抬头怎么修改")
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    inspect(client, store)
    listed = client.get("/inspection/issues?status=open&kind=knowledge_gap", headers=headers("admin")).json()
    gaps = {item["title"]: item for item in listed["items"]}
    permission, invoice = gaps["退货期限是多久"], gaps["发票抬头怎么修改"]
    assert permission["suggested_close_reason"] == "by_design_permission"
    assert invoice["suggested_close_reason"] == "out_of_scope"
    assert listed["gap_summary"]["total"] == 3 and listed["gap_summary"]["pending"] == 3
    url = f"/inspection/issues/{permission['id']}"
    assert client.patch(url, headers=headers("admin"), json={"status": "ignored"}).status_code == 422
    assert client.patch(url, headers=headers("admin"), json={"status": "ignored", "close_reason": "nope"}).status_code == 422
    assert client.patch(url, headers=headers("admin"), json={"status": "ignored", "close_reason": "other"}).status_code == 422
    closed = client.patch(url, headers=headers("admin"), json={"status": "ignored", "close_reason": "by_design_permission"}).json()
    assert closed["status_label"] == "无需处理" and closed["close_reason_label"] == "权限限制，按设计保密"
    assert client.patch(f"/inspection/issues/{invoice['id']}", headers=headers("admin"),
        json={"status": "ignored", "close_reason": "other", "note": "测试数据"}).status_code == 200
    ignored = client.get("/inspection/issues?status=ignored", headers=headers("admin")).json()
    assert ignored["reason_counts"] == {"by_design_permission": 1, "other": 1}
    filtered = client.get("/inspection/issues?status=ignored&reason=by_design_permission", headers=headers("admin")).json()
    assert [item["id"] for item in filtered["items"]] == [permission["id"]]
    summary = filtered["gap_summary"]
    assert summary["reasonable"] == 1 and summary["reasonable_by_reason"] == {"by_design_permission": 1}
    assert summary["other_ignored"] == 2 and summary["pending"] == 0
    # 重新打开后原因清空。
    reopened = client.patch(url, headers=headers("admin"), json={"status": "open"}).json()
    assert reopened["close_reason"] is None and reopened["close_reason_label"] is None


# 标记"已处理"必须选修复方式，"其他"要写备注；推荐修复方式按诊断结论给出；验证失败重新打开时保留修复方式，手动重新打开时清空。
def test_fix_type(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "发票抬头怎么修改")
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    inspect(client, store)
    listed = client.get("/inspection/issues?status=open&kind=knowledge_gap", headers=headers("admin")).json()
    gaps = {item["title"]: item for item in listed["items"]}
    permission, invoice = gaps["退货期限是多久"], gaps["发票抬头怎么修改"]
    assert permission["suggested_fix_type"] == "grant_permission"
    assert invoice["suggested_fix_type"] == "add_content"
    assert listed["fix_types"]["add_content"] == "补了资料"
    url = f"/inspection/issues/{invoice['id']}"
    assert client.patch(url, headers=headers("admin"), json={"status": "handled"}).status_code == 422
    assert client.patch(url, headers=headers("admin"), json={"status": "handled", "fix_type": "nope"}).status_code == 422
    assert client.patch(url, headers=headers("admin"), json={"status": "handled", "fix_type": "other"}).status_code == 422
    handled = client.patch(url, headers=headers("admin"), json={"status": "handled", "fix_type": "add_content"}).json()
    assert handled["fix_type"] == "add_content" and handled["fix_type_label"] == "补了资料"
    # 没有真的补资料，验证不通过，重新打开但保留上次的修复方式。
    inspect(client, store)
    reopened = client.get(url, headers=headers("admin")).json()
    assert reopened["status"] == "open" and reopened["detail"]["verification"]["passed"] is False
    assert reopened["fix_type"] == "add_content"
    # 改成无需处理时清空修复方式。
    ignored = client.patch(url, headers=headers("admin"), json={"status": "ignored", "close_reason": "out_of_scope"}).json()
    assert ignored["fix_type"] is None and ignored["fix_type_label"] is None


# 分错了路：问题提到了业务数据（库存），却被分到知识库检索，诊断为"分错了路"而不是内容缺口；
# 补上分流规则后重新检索，现在会分到数据查询，自动关闭。
def test_misrouted_data_question(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "库存够不够")
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]
    diagnosis = gap["detail"]["diagnosis"]
    assert diagnosis["category"] == "routing" and diagnosis["label"] == "分错了路"
    routing = diagnosis["questions"][0]["routing"]
    assert routing["data_types"] == ["库存"] and routing["route"] == "knowledge" and routing["route_label"] == "知识库检索"
    issue = client.get(f"/inspection/issues/{gap['id']}", headers=headers("admin")).json()
    assert issue["suggested_fix_type"] == "tune_routing"
    # 问制度的问题即使提到了数据关键词，也不算分错了路。
    from app.inspection.diagnosis import data_types_in
    assert data_types_in("库存管理制度是什么") == [] and data_types_in("库存够不够") == ["inventory"]
    # 补上分流规则后，重新检索判断为现在会分到数据查询，自动关闭。
    import app.tools.data_query as data_query
    monkeypatch.setattr(data_query, "QUERY_WORDS", data_query.QUERY_WORDS + ["够不够"])
    verified = client.post(f"/inspection/issues/{gap['id']}/verify", headers=headers("admin")).json()
    assert verified["status"] == "resolved"
    assert verified["detail"]["diagnosis"]["questions"][0]["rerouted"] is True
    assert "现在都会分到数据查询" in verified["detail"]["resolution"]


# 按拒答分类结论筛选知识缺口，并按结论计数；未知结论返回 422。
def test_filter_by_diagnosis(setup, monkeypatch):
    client, store = setup
    upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    ask(client, "今天天气怎么样")
    inspect(client, store)
    listed = client.get("/inspection/issues?kind=knowledge_gap", headers=headers("admin")).json()
    assert listed["diagnosis_counts"] == {"permission": 1, "out_of_scope": 1}
    assert listed["diagnoses"]["permission"] == "权限缺口"
    filtered = client.get("/inspection/issues?diagnosis=permission", headers=headers("admin")).json()
    assert [item["title"] for item in filtered["items"]] == ["退货期限是多久"]
    assert client.get("/inspection/issues?diagnosis=nope", headers=headers("admin")).status_code == 422


# 系统问题的自动验证：巡检时用原问题重新提问。仍然出错时，已处理的重新打开；恢复后自动标为已解决。
# 管理员也可以在详情里手动验证；设置页把条数设为 0 时巡检不再自动验证。
def test_system_error_recheck(setup, monkeypatch):
    client, store = setup
    original = DocumentSearchTool.execute

    def broken(*args, **kwargs):
        raise RuntimeError("milvus timeout")
    monkeypatch.setattr(DocumentSearchTool, "execute", broken)
    assert client.post("/chat", headers=headers(), json=question(session(client), "退货政策")).status_code == 503
    summary = inspect(client, store)
    error = issues(store, "system_error")[0]
    assert summary["system_rechecked"] == 1 and summary["system_failed"] == 1
    assert error["status"] == "open" and error["detail"]["recheck"]["passed"] is False
    assert "milvus timeout" in error["detail"]["recheck"]["error"]
    url = f"/inspection/issues/{error['id']}"
    assert client.patch(url, headers=headers("admin"), json={"status": "handled", "fix_type": "fix_system"}).status_code == 200
    inspect(client, store)
    reopened = issues(store, "system_error")[0]
    assert reopened["status"] == "open" and "仍然出错" in reopened["detail"]["verification"]["message"]
    # 关掉自动验证后巡检不再重问。
    assert client.put("/settings/runtime", headers=headers("admin"), json={"changes": {"system_recheck_limit": 0}}).status_code == 200
    assert "system_rechecked" not in inspect(client, store)
    # 修好以后手动验证：恢复了，自动标为已解决。
    monkeypatch.setattr(DocumentSearchTool, "execute", original)
    verified = client.post(f"{url}/verify", headers=headers("admin")).json()
    assert verified["status"] == "resolved" and verified["verify_result"]["system_resolved"] == 1
    assert verified["detail"]["resolution"].startswith("已恢复") and verified["detail"]["recheck"]["by"] == "admin"


# 解析质量：纯规则检查每份文档当前版本的分片文字。
def test_check_document_rules():
    from app.inspection.scans import check_document
    normal = ["退货政策：自签收之日起 7 天内可以无理由退货，商品需保持完好，运费由买家承担。" * 2] * 5
    assert check_document(normal) == []
    assert [item["code"] for item in check_document(["  "])] == ["empty"]
    garbled = ["退货政策��：自签收之日起�� 7 天内可以��无理由退货。" * 2]
    assert [item["code"] for item in check_document(garbled)] == ["garbled"]
    spaced = ["退 货 政 策 说 明。售 后 服 务 流 程。换 货 申 请 规 则。其余正文内容正常，用来凑够长度。"]
    assert [item["code"] for item in check_document(spaced)] == ["spaced"]
    footer = ["某某公司内部资料 严禁外传\n" + text for text in normal]
    found = check_document(footer)
    assert [item["code"] for item in found] == ["repeated"] and found[0]["examples"][0] == "某某公司内部资料 严禁外传"
    pieces = ["第一章", "第二章", "第三章"] + normal[:2]
    assert [item["code"] for item in check_document(pieces)] == ["fragments"]


# 巡检时发现有乱码的文档；标记已处理后上传的新版本仍有问题就重新打开，新版本正常后自动解决；手动「重新检查」只查这一份。
def test_parse_quality_issue_lifecycle(setup):
    from test_app import import_text
    client, store = setup
    import_text(client, "正常文档", "退货政策：自签收之日起 7 天内可以无理由退货，商品需保持完好。")
    bad = import_text(client, "乱码文档", "退货��政策��：签收��后 7 天��内可以退货。")
    summary = inspect(client, store)
    assert summary["parse_checked"] == 2 and summary["created_parse_quality"] == 1
    issue = issues(store, "parse_quality")[0]
    assert issue["title"] == "《乱码文档》有乱码" and issue["detail"]["problems"][0]["code"] == "garbled"
    url = f"/inspection/issues/{issue['id']}"
    assert client.get(url, headers=headers("admin")).json()["suggested_fix_type"] == "fix_parsing"
    assert client.patch(url, headers=headers("admin"), json={"status": "handled", "fix_type": "fix_parsing"}).status_code == 200
    # 没有新版本时保持已处理。
    inspect(client, store)
    assert issues(store, "parse_quality")[0]["status"] == "handled"
    second = import_text(client, "乱码文档", "退货��政策��：签收��后 15 天��内可以退货。",
        replace=bad["document_id"])
    inspect(client, store)
    reopened = issues(store, "parse_quality")[0]
    assert reopened["status"] == "open" and "第 2 版" in reopened["detail"]["verification"]["message"]
    import_text(client, "乱码文档", "退货政策：签收后 15 天内可以退货，运费由买家承担。", replace=second["document_id"])
    verified = client.post(f"{url}/verify", headers=headers("admin")).json()
    assert verified["status"] == "resolved" and verified["detail"]["resolution"] == "第 3 版解析正常"
    assert verified["verify_result"]["parse_checked"] == 1 and "verification" not in verified["detail"]
