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
        json={"status": "handled", "note": "补了跨境退货说明"}).status_code == 200
    assert client.patch(f"/inspection/issues/{invoice}", headers=headers("admin"),
        json={"status": "ignored"}).status_code == 200
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
        json={"status": "ignored"}).status_code == 404
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
