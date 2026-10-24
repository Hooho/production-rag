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
    # 后来新增的初始专项：新库直接带上；12 道题，证据都在评测语料里（检索方式的校验规则）。
    late = by_name["Agent 区分题"]
    assert late["method"] == "retrieval" and late["search_mode"] == "hybrid" and late["item_count"] == 12


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
    # 证据命中条数：固定流程看 given，Agent 看 found。
    stats = by_type([{"type": "汇总", "passed": False, "evidence_count": 3,
        "fixed_evidence": [{"given": True}, {"given": True}, {"given": False}],
        "agent": {"evidence": [{"found": True}, {"found": False}, {"found": False}]}}])
    assert stats[0]["evidence_total"] == 3 and stats[0]["fixed_hits"] == 2 and stats[0]["agent_hits"] == 1


# 初始专项的题改过（revision 加 1）：旧库里用户没动过的题换成新版，用户改过的题不动，每个版本只换一次。
def test_late_seed_revision_updates_untouched_items(setup):
    from sqlalchemy import select, update
    from app.evaluation.dataset import LATE_SEED_KEY, seed_late_suites, seed_suites
    from app.mysql.store import settings as settings_table
    from app.mysql.tables import eval_suite_items, eval_suites
    _, store = setup
    seed = next(suite for suite in seed_suites() if suite["name"] == "Agent 区分题")
    assert seed.get("revision", 1) >= 2
    with store.engine.begin() as connection:
        suite_id = connection.execute(select(eval_suites.c.id).where(eval_suites.c.name == "Agent 区分题")).scalar_one()
        rows = connection.execute(select(eval_suite_items.c.id, eval_suite_items.c.created).where(
            eval_suite_items.c.suite_id == suite_id).order_by(eval_suite_items.c.position)).all()
        # 第 1 题是系统原样的旧版，第 2 题用户改过（updated 和 created 不同）。
        connection.execute(update(eval_suite_items).where(eval_suite_items.c.id == rows[0].id).values(data={"question": "旧题", "evidence": ["旧"]}))
        connection.execute(update(eval_suite_items).where(eval_suite_items.c.id == rows[1].id).values(
            data={"question": "用户的题", "evidence": ["改"]}, updated="2099-01-01"))
        value = connection.execute(select(settings_table.c.value).where(settings_table.c.key == LATE_SEED_KEY)).scalar_one()
        connection.execute(update(settings_table).where(settings_table.c.key == LATE_SEED_KEY).values(value={"names": value["names"]}))
    seed_late_suites(store.engine)
    with store.engine.connect() as connection:
        data = connection.execute(select(eval_suite_items.c.data).where(eval_suite_items.c.suite_id == suite_id).order_by(
            eval_suite_items.c.position)).scalars().all()
    assert data[0] == seed["items"][0]
    assert data[1]["question"] == "用户的题"
    # 已经换过这个版本：再把第 1 题改回旧版也不会再换。
    with store.engine.begin() as connection:
        connection.execute(update(eval_suite_items).where(eval_suite_items.c.id == rows[0].id).values(data={"question": "旧题", "evidence": ["旧"]}))
    seed_late_suites(store.engine)
    with store.engine.connect() as connection:
        first = connection.execute(select(eval_suite_items.c.data).where(eval_suite_items.c.id == rows[0].id)).scalar_one()
    assert first["question"] == "旧题"


# 一条证据写几处原文（用 || 隔开）：分片含任意一处就算拿到；保存时每处都要在语料里。
def test_evidence_alternatives():
    import pytest
    from app.evaluation.retrieval import evidence_hits
    from app.evaluation.suites import check_item
    texts = {"a": "甲乙丙", "b": "丁戊己", "c": "庚辛"}
    hits = evidence_hits([{"chunk_id": "a"}, {"chunk_id": "b"}, {"chunk_id": "c"}], ["乙丙 || 戊己", "辛"], texts)
    assert hits == {"a": [0], "b": [0], "c": [1]}
    assert check_item("retrieval", {"question": "问", "evidence": ["甲乙 || 丙丁"]}, "甲乙丙丁")["evidence"] == ["甲乙 || 丙丁"]
    with pytest.raises(ValueError, match="戊己"):
        check_item("retrieval", {"question": "问", "evidence": ["甲乙 || 戊己"]}, "甲乙丙丁")


# 得分：全部找到 100，部分按比例最高 90，一条没找到每条证据扣 10、最多扣 50；无法回答的题拿到资料扣 20。
def test_question_score():
    from app.evaluation.score import question_score, score_band, summarize_scores
    assert question_score(True, 8, 8) == 100
    assert question_score(True, 7, 8) == 87.5
    assert question_score(True, 19, 20) == 90
    assert question_score(True, 1, 2) == 50
    assert question_score(True, 0, 1) == -10
    assert question_score(True, 0, 3) == -30
    assert question_score(True, 0, 8) == -50
    assert question_score(False, 0, 0, 0) == 100 and question_score(False, 0, 0, 3) == -20
    assert question_score(True, 0, 0) is None
    assert [score_band(found, 4) for found in (4, 2, 1, 0)] == ["full", "half", "some", "none"]
    summary = summarize_scores([(True, 2, 2, 0), (True, 0, 1, 0), (False, 0, 0, 0)])
    assert summary == {"score": 63.3, "score_bands": {"full": 1, "half": 0, "some": 0, "none": 1}}


# 专项：每题记两边得分，专项记平均分，按类型也有平均分。
def test_special_scores():
    from app.evaluation.suites import attach_scores, by_type
    section = {"questions": [
        {"type": "汇总", "evidence_count": 4, "fixed_evidence": [{"given": True}, {"given": True}, {"given": False}, {"given": False}],
            "agent": {"evidence": [{"found": True}] * 4}},
        {"type": "汇总", "evidence_count": 2, "fixed_evidence": [{"given": False}, {"given": False}],
            "agent": {"evidence": [{"found": False}, {"found": True}]}}]}
    attach_scores(section)
    assert [question["fixed_score"] for question in section["questions"]] == [50, -20]
    assert [question["agent_score"] for question in section["questions"]] == [100, 50]
    assert section["fixed_score"] == 15 and section["agent_score"] == 75
    assert section["agent_score_bands"] == {"full": 1, "half": 1, "some": 0, "none": 0}
    stats = by_type(section["questions"])
    assert stats[0]["fixed_score"] == 15 and stats[0]["agent_score"] == 75


# 新版初始专项少了题：用户没动过的多余旧题删掉，用户改过的保留；专项里有用户自己加的题时整个专项不动。
def test_late_seed_revision_removes_items(setup):
    from sqlalchemy import insert, select, update
    from app.evaluation.dataset import LATE_SEED_KEY, seed_late_suites, seed_suites
    from app.mysql.store import settings as settings_table
    from app.mysql.tables import eval_suite_items, eval_suites
    _, store = setup
    seed = next(suite for suite in seed_suites() if suite["name"] == "Agent 区分题")

    def reset(extra):
        with store.engine.begin() as connection:
            suite_id = connection.execute(select(eval_suites.c.id).where(eval_suites.c.name == "Agent 区分题")).scalar_one()
            for index, (item_id, created_by, updated) in enumerate(extra):
                connection.execute(insert(eval_suite_items).values(id=item_id, suite_id=suite_id, position=len(seed["items"]) + index,
                    data={"question": item_id, "evidence": ["旧"]}, created_by=created_by, created="2020-01-01", updated=updated))
            value = connection.execute(select(settings_table.c.value).where(settings_table.c.key == LATE_SEED_KEY)).scalar_one()
            connection.execute(update(settings_table).where(settings_table.c.key == LATE_SEED_KEY).values(value={"names": value["names"]}))
        return suite_id

    def ids(suite_id):
        with store.engine.connect() as connection:
            return connection.execute(select(eval_suite_items.c.id).where(eval_suite_items.c.suite_id == suite_id)).scalars().all()

    suite_id = reset([("old-1", "system", "2020-01-01"), ("old-2", "system", "2099-01-01")])
    seed_late_suites(store.engine)
    remaining = ids(suite_id)
    assert "old-1" not in remaining and "old-2" in remaining and len(remaining) == len(seed["items"]) + 1
    # 用户自己加的题：整个专项不动。
    reset([("mine", "admin", "2020-01-01"), ("old-3", "system", "2020-01-01")])
    seed_late_suites(store.engine)
    remaining = ids(suite_id)
    assert "mine" in remaining and "old-3" in remaining


# 交给模型的资料：几段、多少字、约多少 token（中文一个字算 1，其他 4 个字符算 1）。
def test_material_counts():
    from app.evaluation.retrieval import material, material_summary
    assert material([{"text": "耳机保修一年"}, {"text": "abcd"}]) == {"count": 2, "chars": 10, "tokens": 7}
    assert material([]) == {"count": 0, "chars": 0, "tokens": 0}
    summary = material_summary([{"count": 2, "chars": 10, "tokens": 7}, {"count": 4, "chars": 20, "tokens": 13}, None], "agent_")
    assert summary == {"agent_material_avg_count": 3, "agent_material_avg_tokens": 10, "agent_material_avg_chars": 15}
