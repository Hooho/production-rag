from app.evaluation.results import execute_run, start_run
from app.evaluation.suites import attach_previous
from app.models import Models
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401
from test_app import setup  # noqa: F401


# 首次启动时从 eval/seed 导入初始专项：截断（检索）和多轮对话。
def test_seeded_suites(setup):
    client, _ = setup
    listed = client.get("/eval/suites", headers=headers()).json()
    by_name = {suite["name"]: suite for suite in listed["items"]}
    assert by_name["截断"]["method"] == "retrieval" and by_name["截断"]["item_count"] == 9
    assert by_name["多轮对话"]["method"] == "dialogue" and by_name["多轮对话"]["item_count"] == 3
    assert listed["methods"] == {"retrieval": "检索", "answer": "回答", "dialogue": "多轮对话"}
    assert client.get("/eval/suites", headers=headers("alice")).status_code == 403


# 新建、编辑专项和题目：证据必须在评测语料里；同名不行；有题目后不能改评测方式；回答方式必须有参考答案。
def test_suite_crud(setup, eval_dir):
    client, _ = setup
    created = client.post("/eval/suites", headers=headers(), json={"name": "售后专项", "description": "售后规则",
        "method": "retrieval"})
    assert created.status_code == 201, created.text
    suite_id = created.json()["id"]
    assert client.post("/eval/suites", headers=headers(), json={"name": "售后专项", "method": "answer"}).status_code == 422
    url = f"/eval/suites/{suite_id}"
    bad = client.post(f"{url}/items", headers=headers(), json={"question": "能退货吗", "evidence": ["不在语料里的话"]})
    assert bad.status_code == 422 and "不在评测语料" in bad.json()["detail"]
    assert client.post(f"{url}/items", headers=headers(), json={"question": "能退货吗"}).status_code == 422
    added = client.post(f"{url}/items", headers=headers(), json={"question": "耳机几天能退？",
        "evidence": ["耳机签收后七天内可以无理由退货"]})
    assert added.status_code == 201 and added.json()["item_count"] == 1
    item_id = added.json()["items"][0]["id"]
    assert client.put(url, headers=headers(), json={"name": "售后专项", "method": "answer"}).status_code == 422
    renamed = client.put(url, headers=headers(), json={"name": "退货专项", "description": "", "method": "retrieval"})
    assert renamed.json()["name"] == "退货专项" and renamed.json()["description"] == ""
    edited = client.put(f"{url}/items/{item_id}", headers=headers(), json={"question": "耳机签收后几天内能退？",
        "evidence": ["耳机签收后七天内可以无理由退货"]})
    assert edited.json()["items"][0]["question"] == "耳机签收后几天内能退？"
    answer_suite = client.post("/eval/suites", headers=headers(), json={"name": "回答专项", "method": "answer"}).json()
    assert client.post(f"/eval/suites/{answer_suite['id']}/items", headers=headers(),
        json={"question": "耳机保修多久？"}).status_code == 422
    assert client.delete(f"{url}/items/{item_id}", headers=headers()).json()["item_count"] == 0
    assert client.delete(url, headers=headers()).status_code == 200
    assert client.get(url, headers=headers()).status_code == 404


# 检索方式的专项：证据全部被返回算通过，逐题记下向量和关键词各排第几；第二次运行能标出上次是否通过。
def test_special_retrieval_run(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    suite = client.post("/eval/suites", headers=headers(), json={"name": "售后专项", "method": "retrieval"}).json()
    for question, evidence in (("耳机几天内可以退货？", "耳机签收后七天内可以无理由退货"),
            ("付款后多久发货？", "订单付款后四十八小时内发货")):
        client.post(f"/eval/suites/{suite['id']}/items", headers=headers(), json={"question": question, "evidence": [evidence]})
    assert client.post("/eval/runs", headers=headers(), json={"kind": "special", "suite_ids": []}).status_code == 422
    special = {"suites": [{"id": suite["id"], "name": suite["name"]}], "compare_memory": False}
    first = execute_run(store, client.app.state.models, [], start_run("special", None, [], special))
    assert first["status"] == "completed" and first["summary"]["count"] == 2
    section = first["special"][0]
    assert section["method"] == "retrieval" and section["passed"] == first["summary"]["passed"]
    evidence = section["questions"][0]["evidence"][0]
    assert "dense_rank" in evidence and "keyword_rank" in evidence
    assert section["evidence_total"] == 2 and section["dense_found"] >= 1
    second = execute_run(store, client.app.state.models, [], start_run("special", None, [], special))
    attach_previous(second)
    assert second["special"][0]["previous"]["id"] == first["id"]
    assert second["special"][0]["questions"][0]["previous_passed"] == section["questions"][0]["passed"]
    detail = client.get(f"/eval/suites/{suite['id']}", headers=headers()).json()
    assert [run["id"] for run in detail["runs"]] == [second["id"], first["id"]]
    assert detail["runs"][0]["summary"]["count"] == 2


# 证据所在分片：评测语料没导入时按当前分片规则临时切分；导入后用库里的分片，返回证据在正文里的位置。
def test_locate_evidence(setup, eval_dir, monkeypatch):
    client, store = setup
    evidence = "耳机签收后七天内可以无理由退货"
    before = client.post("/eval/evidence", headers=headers(), json={"texts": [evidence, "不存在的话"]}).json()
    assert before["imported"] is False and before["cuts_available"] is False
    chunk = before["items"][0]["chunks"][0]
    start, end = chunk["match"]
    assert chunk["content"][start:end] == evidence and chunk["title"] == "售后"
    assert before["items"][1]["chunks"] == []
    from app.evaluation.retrieval import import_corpus
    import_corpus(store, client.app.state.models)
    after = client.post("/eval/evidence", headers=headers(), json={"texts": ["耳机签收后 七天内可以无理由退货"]}).json()
    found = after["items"][0]["chunks"][0]
    assert after["imported"] is True and found["chunk_id"]
    start, end = found["match"]
    assert found["content"][start:end] == evidence
    # 本地向量模型给出截断位置时，换算成正文里的位置（减去标题路径等前缀）。
    monkeypatch.setattr(Models, "truncation_cuts", lambda self, texts: [
        {"tokens": 600, "cut": len(text) - 5, "max_tokens": 512} for text in texts])
    cut = client.post("/eval/evidence", headers=headers(), json={"texts": [evidence]}).json()["items"][0]["chunks"][0]
    assert cut["truncated"] is True and cut["cut"] == len(cut["content"]) - 5 and cut["max_tokens"] == 512
    assert client.post("/eval/evidence", headers=headers("alice"), json={"texts": [evidence]}).status_code == 403
