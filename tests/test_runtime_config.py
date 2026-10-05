from app import runtime_config
from app.models import Models
from app.tools.search import DocumentSearchTool
from test_app import headers, setup  # noqa: F401  复用 API 测试的内存存储夹具
from test_inspection import upload


def admin():
    return headers("admin")


def items(response):
    return {item["key"]: item for item in response.json()["items"]}


# 当前值 = 设置页保存的值，没改过用代码默认值；.env 里同名的旧变量不再起作用。保存后立即生效（同一进程清缓存）。
def test_runtime_settings_save_and_reset(setup, monkeypatch):
    client, store = setup
    monkeypatch.setenv("RERANK_MIN_SCORE", "0.5")
    assert client.get("/settings/runtime", headers=headers("bob")).status_code == 403
    current = items(client.get("/settings/runtime", headers=admin()))
    assert current["rerank_min_score"]["value"] == 0.85 and current["rerank_min_score"]["source"] == "default"
    assert "env" not in current["rerank_min_score"]

    saved = client.put("/settings/runtime", headers=admin(), json={"changes": {"rerank_min_score": 0.7, "return_limit": 3}})
    assert saved.status_code == 200, saved.text
    current = {item["key"]: item for item in saved.json()["items"]}
    assert current["rerank_min_score"]["value"] == 0.7 and current["rerank_min_score"]["source"] == "settings"
    assert runtime_config.value("return_limit") == 3
    assert saved.json()["history"][0]["by"] == "admin"
    assert {change["key"] for change in saved.json()["history"][0]["changes"]} == {"rerank_min_score", "return_limit"}

    reset = client.put("/settings/runtime", headers=admin(), json={"changes": {"rerank_min_score": None}})
    current = {item["key"]: item for item in reset.json()["items"]}
    assert current["rerank_min_score"]["value"] == 0.85 and current["rerank_min_score"]["source"] == "default"


# 保存时校验范围和参数之间的约束，不合规整批不保存。
def test_runtime_settings_validation(setup):
    client, store = setup
    bad = [
        {"rerank_min_score": 1.5},
        {"return_limit": 20, "rerank_candidates": 12},
        {"memory_keep_tokens": 3100},
        {"memory_trigger_tokens": 5000},
        {"parent_context": "yes"},
        {"rerank_candidates": 12.5},
        {"business_tz": "Mars/Base"},
        {"nope": 1},
    ]
    for changes in bad:
        response = client.put("/settings/runtime", headers=admin(), json={"changes": changes})
        assert response.status_code == 422, (changes, response.text)
    assert items(client.get("/settings/runtime", headers=admin()))["return_limit"]["source"] == "default"
    assert client.put("/settings/runtime", headers=admin(), json={"changes": {"business_tz": "UTC"}}).status_code == 200


# 检索在运行时读取参数：改了交给模型的段数和父子分块，下一次检索就生效，诊断里记下实际用的值。
def test_search_uses_runtime_settings(setup, monkeypatch):
    client, store = setup
    upload(client, content="退货政策：退货期限 7 天。\n\n退货运费：买家承担。\n\n换货政策：15 天内可换货。")
    monkeypatch.setattr(Models, "rerank", lambda self, query, documents: [0.95] * len(documents))
    assert client.put("/settings/runtime", headers=admin(),
        json={"changes": {"return_limit": 1, "parent_context": False}}).status_code == 200
    result = DocumentSearchTool().execute(store, Models(), "alice", ["退货"], "退货")
    assert len(result["sources"]) == 1
    config = result["diagnostics"]["config"]
    assert config["return_limit"] == 1 and config["parent_context"] is False
    assert result["stats"]["parent_context"] == "off"


# 「交给模型的段数」离线扫描：段数只截掉排在后面的资料，证据排在第 2 名时，段数为 1 就丢一半证据。
def test_return_limit_sweep():
    from app.evaluation.retrieval import return_limit_sweep
    rows = [
        {"answerable": True, "evidence_count": 2, "pool": [{"p": 0.99, "ev": [0]}, {"p": 0.9, "ev": [1]}, {"p": 0.1, "ev": []}]},
        {"answerable": False, "evidence_count": 0, "pool": [{"p": 0.95, "ev": []}, {"p": 0.2, "ev": []}]},
    ]
    points = {point["return_limit"]: point for point in return_limit_sweep(rows, 0.85, 3)}
    assert points[1]["recall_final"] == 0.5 and points[1]["capped"] == 1 and points[1]["multi_evidence_recall"] == 0.5
    assert points[2]["recall_final"] == 1.0 and points[2]["complete"] == 1 and points[2]["avg_returned"] == 1.5
    assert points[3]["capped"] == 0


# 对话记忆参数改了以后，回答 Agent 在下一次提问前重建摘要中间件，不用重启。
def test_memory_settings_rebuild(setup):
    client, store = setup
    agent = client.app.state.agent.response_agent
    assert agent.memory.trigger_tokens == 6000
    assert client.put("/settings/runtime", headers=admin(),
        json={"changes": {"memory_trigger_tokens": 4000, "memory_keep_tokens": 2000}}).status_code == 200
    agent.sync_memory_settings()
    assert (agent.memory.trigger_tokens, agent.memory.keep_tokens) == (4000, 2000)


# 多轮对话（现在是一个专项评测集）：参数组合每组只改一个因素；演示模式下按顺序问完一段对话，不写 runs 表；
# 发起评测要求真实大模型。
def test_memory_eval_dialogue(setup):
    from sqlalchemy import func, select
    from app.evaluation.memory import memory_variants, run_dialogue
    from app.mysql.store import runs
    client, store = setup
    variants = memory_variants({"memory_trigger_tokens": 2400, "memory_keep_tokens": 1200})
    # 阈值减半时保留的 Token 跟着收到一半以内；保留 Token 已经是阈值的一半，只能往小调。
    assert [(variant["trigger"], variant["keep"]) for variant in variants] == [(2400, 1200), (1200, 600), (4800, 1200), (2400, 600)]
    dialogue = {"id": "t1", "turns": ["退货期限是多久"], "question": "那运费呢"}
    outcome = run_dialogue(store, client.app.state.models, "test", variants[0], dialogue)
    assert outcome["route"] == "knowledge" and outcome["summarized"] is False
    with store.engine.connect() as connection:
        assert connection.execute(select(func.count()).select_from(runs)).scalar() == 0
    suites = client.get("/eval/suites", headers=admin()).json()["items"]
    dialogue_suite = next(suite for suite in suites if suite["method"] == "dialogue")
    assert dialogue_suite["item_count"] >= 3
    response = client.post("/eval/runs", headers=admin(), json={"kind": "special", "suite_ids": [dialogue_suite["id"]]})
    assert response.status_code == 422 and "真实大模型" in response.json()["detail"]


# 界面配色：不登录也能读（登录页也要用）；管理员在设置页改了以后立即返回新值，只接受蓝调和绿调。
def test_ui_theme_setting(setup):
    client, store = setup
    assert client.get("/settings/ui").json() == {"theme": "blue"}
    assert client.put("/settings/runtime", headers=admin(), json={"changes": {"ui_theme": "red"}}).status_code == 422
    assert client.put("/settings/runtime", headers=admin(), json={"changes": {"ui_theme": "green"}}).status_code == 200
    assert client.get("/settings/ui").json() == {"theme": "green"}
