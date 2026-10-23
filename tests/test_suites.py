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
    # 后来新增的初始专项：新库直接带上；24 道题，证据都在评测语料里（检索方式的校验规则）。
    late = by_name["Agent 区分题"]
    assert late["method"] == "retrieval" and late["search_mode"] == "hybrid" and late["item_count"] == 24


# 已经初始化过的库：启动时补加后来新增的初始专项，只加一次；用户删掉后不会再加回来。
def test_late_seed_suites(setup):
    from app.evaluation.dataset import seed_late_suites, seed_suites
    from app.evaluation.suites import check_item
    client, store = setup
    for suite in seed_suites():
        if suite.get("late"):
            for item in suite["items"]:
                check_item(suite["method"], item)
    listed = client.get("/eval/suites", headers=headers()).json()["items"]
    late = next(suite for suite in listed if suite["name"] == "Agent 区分题")
    assert seed_late_suites(store.engine) == []
    assert client.delete(f"/eval/suites/{late['id']}", headers=headers()).status_code == 200
    assert seed_late_suites(store.engine) == []
    names = [suite["name"] for suite in client.get("/eval/suites", headers=headers()).json()["items"]]
    assert "Agent 区分题" not in names


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


# 检索方式选「只用向量」时只跑向量检索：关键词名次为空；改检索方式不受「有题目后不能改评测方式」的限制。
def test_special_search_mode(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    created = client.post("/eval/suites", headers=headers(), json={"name": "向量专项", "method": "retrieval",
        "search_mode": "dense"}).json()
    assert created["search_mode"] == "dense" and created["search_mode_label"] == "只用向量"
    client.post(f"/eval/suites/{created['id']}/items", headers=headers(), json={"question": "耳机几天内可以退货？",
        "evidence": ["耳机签收后七天内可以无理由退货"]})
    special = {"suites": [{"id": created["id"], "name": created["name"]}], "compare_memory": False}
    run = execute_run(store, client.app.state.models, [], start_run("special", None, [], special))
    section = run["special"][0]
    assert section["search_mode"] == "dense"
    assert all(item["keyword_rank"] is None for question in section["questions"] for item in question["evidence"])
    updated = client.put(f"/eval/suites/{created['id']}", headers=headers(), json={"name": "向量专项",
        "method": "retrieval", "search_mode": "keyword"})
    assert updated.status_code == 200 and updated.json()["search_mode"] == "keyword"
    assert client.put(f"/eval/suites/{created['id']}", headers=headers(), json={"name": "向量专项",
        "method": "retrieval", "search_mode": "nope"}).status_code == 422


# 旧的评测结果文件在首次启动时导入数据库：只导入一次，格式不对的文件跳过，已有同编号的不覆盖。
def test_import_result_files(setup, tmp_path, monkeypatch):
    import json
    from app.evaluation import results as results_module
    from app.mysql.store import settings as settings_table
    client, store = setup
    monkeypatch.setattr(results_module, "RESULTS_DIR", tmp_path)
    old = {"id": "20260101-120000_abc", "kind": "retrieval", "status": "completed", "created": "2026-01-01T12:00:00",
        "config": {"split": "dev", "suites": []}, "summary": {"recall_pool": 1.0}, "questions": []}
    (tmp_path / "20260101-120000_abc.json").write_text(json.dumps(old), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{", encoding="utf-8")
    with store.engine.begin() as connection:
        connection.execute(settings_table.delete().where(settings_table.c.key == results_module.IMPORT_KEY))
    assert results_module.import_result_files(store.engine) == 1
    assert results_module.import_result_files(store.engine) == 0
    listing = client.get("/eval/runs", headers=headers()).json()["runs"]
    assert [run["id"] for run in listing] == ["20260101-120000_abc"]
    assert client.get("/eval/runs/20260101-120000_abc", headers=headers()).json()["summary"] == {"recall_pool": 1.0}
    assert client.delete("/eval/runs/20260101-120000_abc", headers=headers()).status_code == 200
    assert client.get("/eval/runs/20260101-120000_abc", headers=headers()).status_code == 404


# 检索方式的专项也能跑 Agent：和固定流程一起跑时逐题记两边是否通过和对比分类；
# 第二次运行时，固定流程和 Agent 各自找上一次跑过这个模式的评测，标出新通过 / 新失败。
def test_special_retrieval_with_agent(setup, eval_dir, monkeypatch):
    from app.agentic.service import AgentMode
    from test_agentic_loop import ScriptedModel, reply, tool_call
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    suite = client.post("/eval/suites", headers=headers(), json={"name": "区分题", "method": "retrieval"}).json()
    for question, evidence in (("耳机几天内可以退货？", "耳机签收后七天内可以无理由退货"),
            ("付款后多久发货？", "订单付款后四十八小时内发货")):
        client.post(f"/eval/suites/{suite['id']}/items", headers=headers(), json={"question": question, "evidence": [evidence]})
    special = {"suites": [{"id": suite["id"], "name": suite["name"]}], "compare_memory": False}

    def agent(*responses):
        model = ScriptedModel(*responses)
        return AgentMode(client.app.state.agent, client_factory=lambda models: model)

    # 第一次：Agent 只查了第一题，第二题直接回答（没拿到证据）。
    first_agent = agent(reply(calls=[tool_call("c1", "search_knowledge", query="耳机签收后几天内可以退货")]),
        reply("七天 [S1]。"), reply("资料中没有找到。"))
    first = execute_run(store, client.app.state.models, [], start_run("special", None, [], special, ["fixed", "agent"]),
        agent_mode=first_agent)
    assert first["status"] == "completed", first.get("error")
    assert first["progress"]["total"] == 4
    section = first["special"][0]
    assert section["modes"] == ["fixed", "agent"] and section["agent_passed"] == 1
    one, two = section["questions"]
    assert one["agent_passed"] is True and two["agent_passed"] is False
    assert one["fixed_passed"] == one["passed"] and two["compare"] in ("fixed_only", "neither")
    assert one["sources"] and one["queries"] and isinstance(one["latency_ms"], int) and one["fixed_evidence"][0]["status"]
    assert first["summary"]["suites"][suite["id"]]["agent_passed"] == 1 and first["summary"]["agent_passed"] == 1

    # 第二次只跑 Agent，两题都查到：第二题 Agent 新通过；固定流程没跑，不标。
    second_agent = agent(reply(calls=[tool_call("c1", "search_knowledge", query="耳机签收后几天内可以退货")]),
        reply("七天 [S1]。"), reply(calls=[tool_call("c2", "search_knowledge", query="订单付款后多久发货")]),
        reply("四十八小时 [S1]。"))
    second = execute_run(store, client.app.state.models, [], start_run("special", None, [], special, ["agent"]),
        agent_mode=second_agent)
    attach_previous(second)
    section = second["special"][0]
    assert section["modes"] == ["agent"] and section["passed"] == 2
    assert section["previous_agent"]["id"] == first["id"] and section["previous"]["passed"] == 1
    assert [question["previous_agent_passed"] for question in section["questions"]] == [True, False]
    assert [question["previous_passed"] for question in section["questions"]] == [True, False]
    assert "fixed_passed" not in section["questions"][0]

    # 接口：演示模式下没有大模型，不能选 Agent。
    response = client.post("/eval/runs", headers=headers(), json={"kind": "special", "suite_ids": [suite["id"]],
        "modes": ["agent"]})
    assert response.status_code == 422 and "MODEL_MODE=openai" in response.json()["detail"]


# 旧库（初始化时还没有这个专项、也没有补加记录）：启动时补加一次。
def test_late_seed_adds_to_existing_database(setup):
    from sqlalchemy import delete
    from app.evaluation.dataset import LATE_SEED_KEY, seed_late_suites
    from app.mysql.store import settings as settings_table
    client, store = setup
    late = next(suite for suite in client.get("/eval/suites", headers=headers()).json()["items"] if suite["name"] == "Agent 区分题")
    client.delete(f"/eval/suites/{late['id']}", headers=headers())
    with store.engine.begin() as connection:
        connection.execute(delete(settings_table).where(settings_table.c.key == LATE_SEED_KEY))
    assert seed_late_suites(store.engine) == ["Agent 区分题"]
    assert seed_late_suites(store.engine) == []
    names = [suite["name"] for suite in client.get("/eval/suites", headers=headers()).json()["items"]]
    assert names.count("Agent 区分题") == 1


# 题目类型：编辑时保留（以前保存会丢掉），结果按类型统计通过数，两种模式一起跑时各记一列。
def test_item_type_is_kept_and_counted():
    from app.evaluation.suites import by_type, check_item
    corpus = "耳机保修期为一年"
    cleaned = check_item("retrieval", {"question": "保修多久？", "evidence": ["耳机保修期为一年"], "type": " 多跳 "}, corpus)
    assert cleaned["type"] == "多跳"
    assert "type" not in check_item("retrieval", {"question": "保修多久？", "evidence": ["耳机保修期为一年"], "type": ""}, corpus)
    stats = by_type([{"type": "多跳", "passed": True, "fixed_passed": True, "agent_passed": True},
        {"type": "比较", "passed": False, "fixed_passed": False, "agent_passed": True},
        {"type": "多跳", "passed": False, "fixed_passed": False, "agent_passed": False}, {"type": None, "passed": True}])
    assert stats == [{"type": "多跳", "count": 2, "passed": 1, "fixed_passed": 1, "agent_passed": 1},
        {"type": "比较", "count": 1, "passed": 0, "fixed_passed": 0, "agent_passed": 1}]
    assert by_type([{"passed": True}]) is None
