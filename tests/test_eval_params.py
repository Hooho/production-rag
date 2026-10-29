# 评测运行参数：发起评测时单独指定的参数只在评测线程里生效，线上请求读到的仍是设置页的值。
import json
import time

import pytest

from app import runtime_config
from app.evaluation import params as eval_params
from app.evaluation.retrieval import import_corpus
from app.models import Models
from test_app import setup  # noqa: F401  pytest 夹具
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401  pytest 夹具


# 复制出来的模型换了配置，原来的模型（线上用的）不变。
def test_models_fork_keeps_original(monkeypatch):
    models = Models()
    models.apply_llm(
        {
            "provider": "deepseek",
            "base_url": "https://a.example/v1",
            "model": "deepseek-chat",
            "api_key": "k1",
        }
    )
    clone = models.fork(
        {
            "provider": "kimi",
            "base_url": "https://b.example/v1",
            "model": "kimi-k3",
            "api_key": "k2",
        }
    )
    assert clone.llm_model == "kimi-k3" and clone.llm_provider == "kimi"
    assert models.llm_model == "deepseek-chat" and models.llm_api_key == "k1"


# 模型只能选设置页保存过的厂商；演示模式不能指定模型。
def test_prepare_llm_choice(setup, monkeypatch):
    client, store = setup
    models = client.app.state.models
    store.save_llm_profile(
        {
            "provider": "kimi",
            "base_url": "https://b.example/v1",
            "model": "kimi-k3",
            "api_key": "k2",
        }
    )
    with pytest.raises(ValueError, match="演示模式"):
        eval_params.prepare(store, models, {"llm": {"provider": "kimi"}})
    monkeypatch.setattr(models, "mode", "openai")
    cleaned, prepared = eval_params.prepare(
        store, models, {"llm": {"provider": "kimi", "model": "kimi-k3-turbo"}}
    )
    assert cleaned == {"llm": {"provider": "kimi", "model": "kimi-k3-turbo"}}
    assert (
        prepared["llm"]["api_key"] == "k2"
        and prepared["llm"]["base_url"] == "https://b.example/v1"
    )
    with pytest.raises(ValueError, match="还没有在设置页保存过"):
        eval_params.prepare(store, models, {"llm": {"provider": "nope"}})
    with pytest.raises(ValueError, match="未知参数"):
        eval_params.prepare(store, models, {"temperature": 1})
    with eval_params.applied(models, prepared) as (run_models, judge_models):
        assert run_models.llm_model == "kimi-k3-turbo" and judge_models is run_models
        assert eval_params.judge(models) is models
    assert models.llm_model != "kimi-k3-turbo"


# 发起评测时带上参数：评测记录存下改了什么（params）和实际生效的配置（effective）；评测结束后设置页的值不变。
def test_eval_run_with_params(setup, eval_dir, monkeypatch, runtime):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    runtime(rerank_min_score=0.3, contextual_retrieval=False)
    options = client.get("/eval/params", headers=headers()).json()
    assert [group["key"] for group in options["groups"]] == ["common", "fixed", "agent"]
    keys = {item["key"]: item for item in options["settings"]}
    assert (
        keys["agent_rerank_min_score"]["eval"] == "agent"
        and keys["rerank_min_score"]["eval"] == "fixed"
    )
    assert "chunk_size" not in keys and keys["return_limit"]["value"] == 6
    assert {item["id"] for item in options["prompts"]} == {
        "intent",
        "sufficiency",
        "answer",
        "agent",
    }
    assert client.get("/eval/params", headers=headers("alice")).status_code == 403

    bad = client.post(
        "/eval/runs",
        headers=headers(),
        json={
            "split": "all",
            "suites": [],
            "params": {"settings": {"chunk_size": 300}},
        },
    )
    assert bad.status_code == 422 and "chunk_size" in bad.json()["detail"]

    import_corpus(store, client.app.state.models)
    started = client.post(
        "/eval/runs",
        headers=headers(),
        json={
            "split": "all",
            "suites": [],
            "params": {"settings": {"return_limit": 1, "rerank_min_score": 0.25}},
        },
    )
    assert started.status_code == 202
    run_id = started.json()["id"]
    for _ in range(100):
        run = client.get(f"/eval/runs/{run_id}", headers=headers()).json()
        if run["status"] != "running":
            break
        time.sleep(0.05)
    assert run["status"] == "completed", run.get("error")
    assert run["params"] == {"settings": {"return_limit": 1, "rerank_min_score": 0.25}}
    assert (
        run["effective"]["settings"]["return_limit"] == 1
        and run["effective"]["settings"]["rerank_min_score"] == 0.25
    )
    assert run["effective"]["prompts"][
        "agent"
    ] == "agent@内置" and "api_key" not in json.dumps(run["effective"])
    # 评测里实际用的就是覆盖后的值：记录下来的全量设置和每题最多返回 1 段。
    assert (
        run["config"]["settings"]["return_limit"] == 1
        and run["config"]["return_limit"] == 1
    )
    assert max(question["returned"] for question in run["questions"]) <= 1
    listing = client.get("/eval/runs", headers=headers()).json()["runs"]
    assert listing[0]["params"] == run["params"]
    # 设置页（线上）的值没变。
    assert (
        runtime_config.value("return_limit") == 6
        and runtime_config.value("rerank_min_score") == 0.3
    )


# 两次评测比较时，评审模型和回答、充分性判断的提示词版本不同也列出来（来自 effective）；Agent 阈值随全量设置一起比。
def test_compare_lists_effective_differences():
    from app.evaluation.results import compare_runs

    def run(judge, answer, threshold):
        return {
            "id": "20261030-000000_x",
            "kind": "retrieval",
            "summary": {},
            "config": {"settings": {"agent_rerank_min_score": threshold}},
            "effective": {
                "judge": {"model": judge},
                "prompts": {"answer": answer, "sufficiency": "sufficiency@内置"},
            },
        }

    diff = compare_runs(
        run("deepseek-chat", "answer@内置", 0.85), run("kimi-k3", "answer@v2", 0.2)
    )["settings_diff"]
    assert {"key": "评审模型", "base": "deepseek-chat", "target": "kimi-k3"} in diff
    assert {
        "key": "回答提示词版本",
        "base": "answer@内置",
        "target": "answer@v2",
    } in diff
    assert {"key": "agent_rerank_min_score", "base": 0.85, "target": 0.2} in diff
    assert not any(item["key"] == "充分性判断提示词版本" for item in diff)
