from sqlalchemy import func, select

from app.models import Models
from app.mysql.store import runs
from test_app import headers, setup  # noqa: F401  复用 API 测试的内存存储夹具
from test_inspection import ask, inspect, issues, keyword_rerank, upload


def admin():
    return headers("admin")


def run_set(client, set_id, kind):
    response = client.post(f"/eval/sets/{set_id}/runs", headers=admin(), json={"kind": kind})
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    client.app.state.regression_threads[run_id].join(timeout=60)
    run = client.get(f"/eval/sets/{set_id}/runs/{run_id}", headers=admin()).json()
    assert run["status"] == "completed", run
    return run


def run_count(store):
    with store.engine.connect() as connection:
        return connection.execute(select(func.count()).select_from(runs)).scalar()


# 巡检复测集只允许管理员访问；名字不能重复；从巡检问题加入时预填问法、提问人、期望结果和期望文档。
def test_regression_set_from_inspection_issue(setup, monkeypatch):
    client, store = setup
    document_id = upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]

    assert client.get("/eval/sets", headers=headers("bob")).status_code == 403
    created = client.post("/eval/sets", headers=admin(), json={"name": "退货回归", "description": "售后相关"})
    assert created.status_code == 201
    eval_set = created.json()
    assert client.post("/eval/sets", headers=admin(), json={"name": "退货回归"}).status_code == 422

    candidates = client.get(f"/inspection/issues/{gap['id']}/eval-candidates", headers=admin()).json()
    assert candidates["expect"] == "answer"
    assert candidates["candidates"][0] == {"question": "退货期限是多久", "original": "退货期限是多久", "asker": "bob", "in_sets": []}
    assert candidates["documents"][0]["title"] == "售后"
    doc_key = candidates["documents"][0]["doc_key"]
    item = {"question": "退货期限是多久", "asker": "bob", "expect": "answer", "documents": [doc_key], "issue_id": gap["id"]}
    url = f"/eval/sets/{eval_set['id']}/items"
    assert client.post(url, headers=admin(), json={"items": [item]}).status_code == 201
    # 同一道题不能重复加入；提问人必须存在；应该拒答的题不填期望文档。
    assert client.post(url, headers=admin(), json={"items": [item]}).status_code == 422
    assert client.post(url, headers=admin(), json={"items": [{**item, "asker": "nobody"}]}).status_code == 422
    assert client.post(url, headers=admin(), json={"items": [{**item, "question": "发票怎么开", "expect": "refuse"}]}).status_code == 422
    assert client.post(url, headers=admin(), json={"items": [{"question": "今天天气怎么样", "asker": "alice",
        "expect": "refuse"}]}).status_code == 201
    again = client.get(f"/inspection/issues/{gap['id']}/eval-candidates", headers=admin()).json()
    assert again["candidates"][0]["in_sets"] == ["退货回归"]

    # bob 没有权限：检索评测不通过；应该拒答的闲聊题通过。
    first = run_set(client, eval_set["id"], "retrieval")
    results = {result["question"]: result for result in first["results"]}
    assert results["退货期限是多久"]["passed"] is False and "拒答" in results["退货期限是多久"]["reason"]
    assert results["今天天气怎么样"]["passed"] is True
    assert first["summary"]["passed"] == 1 and first["summary"]["previous"] is None

    # 共享给 bob 之后再跑：变成通过，并标出"新通过"。
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "public", "groups": []}).status_code == 200
    second = run_set(client, eval_set["id"], "retrieval")
    results = {result["question"]: result for result in second["results"]}
    assert results["退货期限是多久"]["passed"] is True and results["退货期限是多久"]["change"] == "fixed"
    assert results["退货期限是多久"]["documents"][0]["title"] == "售后"
    assert second["summary"]["changes"] == {"fixed": 1} and second["summary"]["pass_rate"] == 1.0

    listed = client.get("/eval/sets", headers=admin()).json()["items"][0]
    assert listed["item_count"] == 2 and listed["latest"]["retrieval"]["summary"]["passed"] == 2

    # 生成评测完整问一遍（演示模式直接返回检索原文），不写 runs 表。
    before = run_count(store)
    generation = run_set(client, eval_set["id"], "generation")
    results = {result["question"]: result for result in generation["results"]}
    assert results["退货期限是多久"]["passed"] is True and results["退货期限是多久"]["route"] == "knowledge"
    assert results["今天天气怎么样"]["passed"] is True
    assert run_count(store) == before

    # 编辑题目：可以改问题、提问人、期望结果和期望文档；改成和别的题重复、提问人不存在时拒绝。
    detail = client.get(f"/eval/sets/{eval_set['id']}", headers=admin()).json()
    target = next(item for item in detail["items"] if item["question"] == "今天天气怎么样")
    item_url = f"/eval/sets/{eval_set['id']}/items/{target['id']}"
    edited = client.put(item_url, headers=admin(), json={"question": "退货运费谁出", "asker": "bob", "expect": "answer",
        "documents": [doc_key], "reference_answer": "买家承担"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["documents"] == [{"doc_key": doc_key, "title": "售后"}] and edited.json()["reference_answer"] == "买家承担"
    assert client.put(item_url, headers=admin(), json={"question": "退货期限是多久", "asker": "bob", "expect": "answer"}).status_code == 422
    assert client.put(item_url, headers=admin(), json={"question": "退货运费谁出", "asker": "nobody", "expect": "answer"}).status_code == 422
    assert client.put(f"/eval/sets/{eval_set['id']}/items/nope", headers=admin(), json={"question": "x", "asker": "bob", "expect": "answer"}).status_code == 404
    documents = client.get("/eval/documents", headers=admin()).json()["documents"]
    assert [document["title"] for document in documents] == ["售后"]

    # 删除评测集连同题目和运行记录一起删除。
    assert client.delete(f"/eval/sets/{eval_set['id']}", headers=admin()).status_code == 204
    assert client.get(f"/eval/sets/{eval_set['id']}", headers=admin()).status_code == 404


# 合理拒答的知识缺口加入评测集时，默认期望是"应该拒答"。
def test_reasonable_refusal_candidates_expect_refuse(setup, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.01] * len(documents))
    ask(client, "今天天气怎么样")
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]
    assert client.patch(f"/inspection/issues/{gap['id']}", headers=admin(),
        json={"status": "ignored", "close_reason": "out_of_scope"}).status_code == 200
    candidates = client.get(f"/inspection/issues/{gap['id']}/eval-candidates", headers=admin()).json()
    assert candidates["expect"] == "refuse" and candidates["documents"] == []


# 关联记录上的"重新提问"：以提问人身份完整再问一遍，结果按记录保存在问题详情里，不产生新的问答记录。
def test_replay_event(setup, monkeypatch):
    client, store = setup
    document_id = upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]
    event = client.get(f"/inspection/issues/{gap['id']}", headers=admin()).json()["events"][0]
    url = f"/inspection/issues/{gap['id']}/events/{event['source']}/{event['source_id']}/replay"
    assert client.post(url, headers=headers("bob")).status_code == 403
    before = run_count(store)
    first = client.post(url, headers=admin()).json()
    assert first["owner"] == "bob" and first["refused"] is True and first["by"] == "admin"
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "public", "groups": []}).status_code == 200
    second = client.post(url, headers=admin()).json()
    assert second["refused"] is False and second["sources"][0]["title"] == "售后"
    assert run_count(store) == before
    detail = client.get(f"/inspection/issues/{gap['id']}", headers=admin()).json()["detail"]
    assert detail["replays"][f"{event['source']}:{event['source_id']}"]["refused"] is False
    assert client.post(f"/inspection/issues/{gap['id']}/events/run/nope/replay", headers=admin()).status_code == 404


# 标记"权限限制，按设计保密"的缺口在巡检时复查：权限放开后自动解决；资料被删后重新打开。
def test_permission_close_is_rechecked(setup, monkeypatch):
    client, store = setup
    document_id = upload(client)
    monkeypatch.setattr(Models, "rerank", keyword_rerank(0.95))
    ask(client, "退货期限是多久", owner="bob")
    inspect(client, store)
    gap = issues(store, "knowledge_gap")[0]
    url = f"/inspection/issues/{gap['id']}"
    assert client.patch(url, headers=admin(), json={"status": "ignored", "close_reason": "by_design_permission"}).status_code == 200
    # 仍然没有权限：保持无需处理。
    summary = inspect(client, store)
    assert summary["diagnosed"] == 1 and not summary.get("recheck_resolved") and not summary.get("recheck_reopened")
    assert client.get(url, headers=admin()).json()["status"] == "ignored"
    # 权限放开：自动解决。
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "public", "groups": []}).status_code == 200
    summary = inspect(client, store)
    resolved = client.get(url, headers=admin()).json()
    assert summary["recheck_resolved"] == 1
    assert resolved["status"] == "resolved" and resolved["close_reason"] is None
    assert resolved["detail"]["resolution"].startswith("权限已调整")

    # 另一种情况：资料被删除，保密的理由不成立，重新打开。
    assert client.put(f"/documents/{document_id}/permission", headers=headers(),
        json={"visibility": "private", "groups": []}).status_code == 200
    assert client.patch(url, headers=admin(), json={"status": "ignored", "close_reason": "by_design_permission"}).status_code == 200
    assert client.delete(f"/documents/{document_id}", headers=headers()).status_code == 200
    summary = inspect(client, store)
    reopened = client.get(url, headers=admin()).json()
    assert summary["recheck_reopened"] == 1
    assert reopened["status"] == "open" and reopened["close_reason"] is None
    assert "保密的理由不成立" in reopened["detail"]["verification"]["message"]
