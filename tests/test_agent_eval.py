# Agent 检索评测：同一套调参题让 Agent 跑一遍，只看它最后拿到的资料里有没有证据（最后命中）。
import time

from app.agentic.service import AgentMode
from app.evaluation import dataset as dataset_module
from app.evaluation import results as results_module
from app.evaluation.results import execute_run, previous_run, run_brief, start_run
from app.evaluation.retrieval import import_corpus
from app.models import Models
from test_agentic_loop import ScriptedModel, reply, tool_call
from test_app import setup  # noqa: F401  pytest 夹具
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401  pytest 夹具


# dev 集三道题：a1 退货（Agent 检索并命中）、a2 保修（Agent 没检索直接回答，算没命中）、u1 天气（无法回答，Agent 直接回答）。
def scripted_agent(client):
    model = ScriptedModel(
        reply(calls=[tool_call("c1", "search_knowledge", query="耳机签收后几天内可以退货")]),
        reply(calls=[tool_call("c2", "search_knowledge", query="耳机签收后几天内可以退货吗")]),
        reply("签收后七天内可以退货 [S1]。"),
        reply("资料中没有找到保修期。"),
        reply("资料中没有找到天气信息。"))
    return model, AgentMode(client.app.state.agent, client_factory=lambda models: model)


# 一起跑：固定流程照常跑全套，每道题的 agent 部分记下检索日志和最后命中，汇总里有 agent_ 指标和逐题对比的分类。
def test_agent_retrieval_runs_with_fixed(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    model, agent_mode = scripted_agent(client)
    run = start_run("retrieval", "dev", [], modes=["agent", "fixed"])
    assert run["config"]["modes"] == ["fixed", "agent"]
    run = execute_run(store, client.app.state.models, dataset_module.load_dataset(), run, agent_mode=agent_mode)
    assert run["status"] == "completed", run.get("error")
    assert not model.responses
    assert run["config"]["modes"] == ["fixed", "agent"]
    assert run["config"]["agent"]["tool_budget"] >= 1 and run["config"]["agent"]["prompt_version"]
    # 固定流程的结果不变：分阶段命中、漏斗都还在。
    assert run["summary"]["recall_final"] is not None and run["funnel"]["total"] == 2

    first, second, third = run["questions"]
    agent = first["agent"]
    assert agent["recall"] == 1.0 and agent["searches"] == 2 and agent["empty_searches"] == 0
    assert agent["queries"] == ["耳机签收后几天内可以退货", "耳机签收后几天内可以退货吗"]
    # 第二次检索拿回的分块第一次都拿到过：没有新增，算一次无新增检索。
    assert agent["calls"][0]["new_chunks"] > 0 and agent["calls"][1]["new_chunks"] == 0 and agent["wasted_searches"] == 1
    call = agent["calls"][0]
    assert call["name"] == "search_knowledge" and call["arguments"]["query"] == "耳机签收后几天内可以退货"
    assert isinstance(call["duration_ms"], int)
    assert call["results"][0]["evidence_id"] == "S1" and call["results"][0]["hits"] == [0] and call["hits"] == [0]
    assert agent["evidence"][0] == {"text": "耳机签收后七天内可以无理由退货", "found": True,
        "chunk_ids": [call["results"][0]["chunk_id"]], "positions": [call["results"][0]["position"]],
        "where": [{"call": 1, "evidence_id": "S1"}, {"call": 2, "evidence_id": "S1"}]}
    assert isinstance(call["results"][0]["position"], int)
    assert agent["rounds"] == 3 and agent["tool_calls"] == 2 and agent["prompt_tokens"] == 300
    assert agent["answer"] == "签收后七天内可以退货 [S1]。"
    assert second["agent"]["recall"] == 0 and second["agent"]["returned"] == 0 and second["agent"]["calls"] == []
    assert third["agent"]["recall"] is None

    summary = run["summary"]
    assert summary["agent_recall"] == 0.5 and summary["agent_false_reject_rate"] == 0.5
    assert summary["agent_false_accept_rate"] == 0.0 and summary["agent_avg_tool_calls"] == round(2 / 3, 4)
    assert summary["agent_wasted_searches"] == 1 and summary["agent_wasted_rate"] == 0.5
    assert summary["agent_cache_hit_rate"] == 0.8 and summary["agent_failed"] == 0
    assert run["by_type"]["事实"]["agent_recall"] == 1.0 and "recall_final" in run["by_type"]["事实"]
    assert first["compare"] == "both" and second["compare"] == "fixed_only" and "compare" not in third
    assert run["comparison"] == {"both": 1, "fixed_only": 1, "agent_only": 0, "neither": 0}


# 只跑 Agent：逐题只有题目信息和 agent；没有分阶段结果，历史指标说明为空；不和只跑固定流程的评测自动对比。
def test_agent_retrieval_runs_alone(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    fixed = execute_run(store, client.app.state.models, dataset_module.load_dataset(), start_run("retrieval", "dev", []))
    model, agent_mode = scripted_agent(client)
    run = start_run("retrieval", "dev", [], modes=["agent"])
    run = execute_run(store, client.app.state.models, dataset_module.load_dataset(), run, agent_mode=agent_mode)
    assert run["status"] == "completed", run.get("error")
    assert run["progress"] == {"done": 3, "total": 3}
    question = run["questions"][0]
    assert "stages" not in question and question["agent"]["recall"] == 1.0
    assert run["summary"]["count"] == 3 and run["summary"]["agent_recall"] == 0.5
    assert "recall_final" not in run["summary"] and "comparison" not in run
    assert run_brief(run)["history_metrics"] is None
    runs = results_module.list_runs()
    assert previous_run(run, runs) is None and previous_run(fixed, runs) is None


# 一道题 Agent 出错不影响其他题，记下失败原因。
def test_agent_retrieval_records_failure(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    model = ScriptedModel(RuntimeError("模型挂了"), reply("不知道。"), reply("不知道。"))
    agent_mode = AgentMode(client.app.state.agent, client_factory=lambda models: model)
    run = execute_run(store, client.app.state.models, dataset_module.load_dataset(),
        start_run("retrieval", "dev", [], modes=["agent"]), agent_mode=agent_mode)
    assert run["status"] == "completed"
    assert run["questions"][0]["agent"]["status"] == "failed" and run["summary"]["agent_failed"] == 1


# 接口：Agent 只支持检索评测；没有真实大模型时入队前就拒绝；有模型（这里是脚本模型）时正常跑完。
def test_agent_retrieval_api(setup, eval_dir, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    response = client.post("/eval/runs", headers=headers(), json={"split": "dev", "modes": ["agent"]})
    assert response.status_code == 422 and "MODEL_MODE=openai" in response.json()["detail"]
    response = client.post("/eval/runs", headers=headers(), json={"kind": "generation", "split": "dev", "modes": ["agent"]})
    assert response.status_code == 422 and "检索评测" in response.json()["detail"]
    assert client.post("/eval/runs", headers=headers(), json={"split": "dev", "modes": []}).status_code == 422
    assert client.post("/eval/runs", headers=headers(), json={"split": "dev", "modes": ["x"]}).status_code == 422
    model, agent_mode = scripted_agent(client)
    client.app.state.agent_mode.client_factory = lambda models: model
    # 先在主线程导入语料：测试库是多线程共用的一个 SQLite 连接，后台线程导入时和轮询请求交错，偶尔会读不到刚插入的文档
    # （test_evaluation.py::test_eval_api 的偶发失败就是这个原因）。导入过之后后台线程只会判定“未变化”。
    import_corpus(setup[1], client.app.state.models)
    started = client.post("/eval/runs", headers=headers(), json={"split": "dev", "modes": ["fixed", "agent"]})
    assert started.status_code == 202
    for _ in range(100):
        run = client.get(f"/eval/runs/{started.json()['id']}", headers=headers()).json()
        if run["status"] != "running":
            break
        time.sleep(0.05)
    assert run["status"] == "completed", run.get("error")
    assert run["config"]["modes"] == ["fixed", "agent"] and run["summary"]["agent_recall"] == 0.5


# 对比两次评测：Agent 提示词版本、跑的模式不同时，列在“改过的项”里。
def test_compare_lists_agent_prompt_and_modes():
    from app.evaluation.results import compare_runs
    base = {"id": "a", "config": {"modes": ["fixed", "agent"], "agent": {"prompt_version": "agent@内置", "model": "m"}}, "summary": {}}
    target = {"id": "b", "config": {"modes": ["agent"], "agent": {"prompt_version": "agent@v2", "model": "m"}}, "summary": {}}
    diff = {row["key"]: (row["base"], row["target"]) for row in compare_runs(base, target)["settings_diff"]}
    assert diff == {"模式": ("fixed+agent", "agent"), "Agent 提示词版本": ("agent@内置", "agent@v2")}


# 内置提示词改过时版本号还是「内置」，靠内容指纹列出来；旧记录没有指纹时不列。
def test_compare_lists_builtin_prompt_change():
    from app.evaluation.results import compare_runs
    agent = {"prompt_version": "agent@内置", "model": "m"}
    base = {"id": "a", "config": {"modes": ["agent"], "agent": {**agent, "prompt_identity": "aaa"}}, "summary": {}}
    target = {"id": "b", "config": {"modes": ["agent"], "agent": {**agent, "prompt_identity": "bbb"}}, "summary": {}}
    assert compare_runs(base, target)["settings_diff"] == [{"key": "Agent 提示词内容", "base": "aaa", "target": "bbb"}]
    old = {"id": "c", "config": {"modes": ["agent"], "agent": agent}, "summary": {}}
    assert compare_runs(old, target)["settings_diff"] == []
