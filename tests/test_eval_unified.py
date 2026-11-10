import copy
from types import SimpleNamespace

import pytest

from app.evaluation import configuration, params
from app.evaluation.flow import item_history
from app.retrieval_policy import selected_methods, use_methods


def test_unified_sources_ignore_legacy_execution_settings():
    suites = [
        {
            "id": "suite-a",
            "name": "投资",
            "method": "retrieval",
            "search_mode": "keyword",
            "items": [
                {
                    "id": "q1",
                    "question": "腾讯？",
                    "evidence": ["公司"],
                    "reference_answer": "公司",
                    "prelude": [
                        {"question": "谈腾讯", "answer": "好的", "confirmed": True}
                    ],
                }
            ],
        }
    ]
    items = configuration.questions([], "dev", suites)
    assert items[0]["reviewed"] is True and items[0]["split"] == "all"
    assert "search_mode" not in items[0] and "method" not in items[0]
    assert configuration.validate_questions(items, "retrieval") == items
    assert item_history(items[0]) == [{"question": "谈腾讯", "answer": "好的"}]
    assert suites[0]["items"][0].get("reviewed") is None


def test_old_dynamic_dialogue_requires_confirmation():
    suites = [
        {
            "id": "s",
            "name": "多轮",
            "items": [{"id": "q", "question": "它呢", "turns": ["谈腾讯"]}],
        }
    ]
    with pytest.raises(ValueError, match="前置问答"):
        configuration.questions([], "dev", suites)
    with pytest.raises(ValueError, match="计分证据"):
        configuration.validate_questions([{"question": "q"}], "retrieval")
    with pytest.raises(ValueError, match="参考答案"):
        configuration.validate_questions([{"question": "q"}], "generation")


def test_methods_are_scoped_and_reset_after_error():
    assert selected_methods() is None
    with pytest.raises(RuntimeError):
        with use_methods(["graph"]):
            assert selected_methods() == ("graph",)
            with use_methods(["dense", "keyword"]):
                assert selected_methods() == ("dense", "keyword")
            assert selected_methods() == ("graph",)
            raise RuntimeError()
    assert selected_methods() is None


def test_freezing_resolves_settings_prompts_and_models(monkeypatch):
    settings = {"test": 1}
    monkeypatch.setattr(params.runtime_config, "snapshot", lambda: dict(settings))
    monkeypatch.setattr(
        params.runtime_config, "SPECS", [{"key": "test", "eval": "common"}]
    )
    monkeypatch.setattr(params.prompts, "EVAL_PROMPTS", {"answer": "fixed"})
    monkeypatch.setattr(params.prompts, "current", lambda _: (2, "original prompt"))
    monkeypatch.setattr(
        params.prompts,
        "resolve_versions",
        lambda _, chosen: {
            key: {"version": value, "text": "original prompt"}
            for key, value in chosen.items()
        },
    )
    models = SimpleNamespace(llm_model="model-a")
    prepared = params.freeze(
        SimpleNamespace(engine=None),
        models,
        {"settings": {}, "prompts": {}, "llm": None, "judge": None},
    )
    settings["test"] = 99
    models.llm_model = "model-b"
    assert prepared["settings"]["test"] == 1
    assert prepared["prompts"]["answer"]["version"] == 2
    assert prepared["base_models"].llm_model == "model-a"
    assert item_history({"history": ["legacy"]}) == [{"question": "legacy"}]


from test_app import setup  # noqa: F401
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401
from test_eval_batch import wait_batch
from app.models import Models


def test_unified_batch_freezes_common_questions_and_methods(
    setup, eval_dir, monkeypatch, runtime
):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    runtime(rerank_min_score=0.3, contextual_retrieval=False)
    started = client.post(
        "/eval/batches",
        headers=headers(),
        json={
            "configs": [
                {"version": 2, "split": "all", "mode": "fixed", "methods": ["keyword"]},
                {"version": 2, "split": "dev", "mode": "fixed", "methods": ["dense"]},
            ]
        },
    )
    assert started.status_code == 202, started.text
    report = wait_batch(client, started.json()["id"])
    assert [arm["status"] for arm in report["arms"]] == ["completed", "completed"], (
        report
    )
    first, second = report["runs"]
    assert first["question_snapshot"] == second["question_snapshot"]
    assert len(first["questions"]) == len(second["questions"]) == 4
    assert first["config"]["methods"] == ["keyword"]
    assert second["config"]["methods"] == ["dense"]
    assert first["frozen"]["data_scope"] == second["frozen"]["data_scope"]
    assert first["frozen"]["graph_versions"] == second["frozen"]["graph_versions"]
    for run in (first, second):
        for question in run["questions"]:
            assert (
                question["diagnostics"]["config"]["methods"] == run["config"]["methods"]
            )
    assert any(row["key"] == "检索方式" for row in report["config_diff"])
    assert (
        client.post(
            "/eval/batches",
            headers=headers(),
            json={"configs": [{"version": 2, "kind": "generation", "mode": "agent"}]},
        ).status_code
        == 422
    )


def test_retry_stays_inside_report_and_preserves_failure(
    setup, eval_dir, monkeypatch, runtime
):
    import app.api.main as api_main

    client, store = setup
    runtime(contextual_retrieval=False)
    original = api_main.execute_run

    def fail(*args, **kwargs):
        raise RuntimeError("temporary failure")

    monkeypatch.setattr(api_main, "execute_run", fail)
    started = client.post(
        "/eval/batches",
        headers=headers(),
        json={"configs": [{"version": 2, "split": "all", "methods": ["keyword"]}]},
    )
    assert started.status_code == 202, started.text
    report = wait_batch(client, started.json()["id"])
    assert report["arms"][0]["status"] == "failed"
    run_id = report["arms"][0]["id"]
    monkeypatch.setattr(api_main, "execute_run", original)
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    response = client.post(
        f"/eval/batches/{report['id']}/arms/{run_id}/retry", headers=headers()
    )
    assert response.status_code == 202, response.text
    retried = wait_batch(client, report["id"])
    assert retried["arms"][0]["id"] == run_id
    assert retried["arms"][0]["status"] == "completed", retried
    assert retried["arms"][0]["attempts"][0]["status"] == "failed"
    assert "temporary failure" in retried["arms"][0]["attempts"][0]["error"]


def test_prelude_answer_uses_rag_and_requires_confirmed_context(
    setup, eval_dir, monkeypatch, runtime
):
    client, _ = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    runtime(contextual_retrieval=False)
    body = {
        "question": "耳机保修多久？",
        "prelude": [
            {"question": "我问耳机售后", "answer": "请问具体问题", "confirmed": True}
        ],
    }
    response = client.post("/eval/prelude/answer", headers=headers(), json=body)
    assert response.status_code == 200, response.text
    assert response.json()["answer"] and response.json()["sources"]
    body["prelude"][0]["confirmed"] = False
    assert (
        client.post("/eval/prelude/answer", headers=headers(), json=body).status_code
        == 422
    )
    assert (
        client.post(
            "/eval/prelude/answer",
            headers=headers("alice"),
            json={"question": "耳机？"},
        ).status_code
        == 403
    )


def test_graph_worker_inherits_frozen_evaluation_context(
    setup, eval_dir, monkeypatch, runtime
):
    from app.tools.search import DocumentSearchTool
    from app.graph.retrieve import empty
    from app.retrieval_policy import selected_graph_versions, selected_scope

    client, store = setup
    captured = []

    def graph(*args, **kwargs):
        captured.append(
            (selected_methods(), selected_graph_versions(), selected_scope())
        )
        return empty("skipped", "test")

    monkeypatch.setattr(DocumentSearchTool, "graph_recall", staticmethod(graph))
    scope = {"versions": {}, "documents": []}
    with use_methods(["graph"], scope, ["version-a"]):
        DocumentSearchTool().execute(
            store, client.app.state.models, "eval", ["腾讯"], "腾讯", methods=["dense"]
        )
    assert captured == [(("graph",), ("version-a",), scope)]
