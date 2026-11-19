from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, select, func

from app.graph import experiments, resolve
from app.mysql.tables import metadata, graph_entities, graph_mentions, graph_relations


@pytest.fixture
def experiment(monkeypatch):
    engine = create_engine("sqlite://")
    metadata.create_all(engine)
    store = SimpleNamespace(engine=engine, cache=SimpleNamespace(rpush=Mock()))
    models = SimpleNamespace(llm_provider="test", llm_model="test")
    monkeypatch.setattr(experiments.build, "models_for", lambda *args: models)
    monkeypatch.setattr(experiments.prompts, "current", lambda _: (0, "test prompt"))
    return store, models


def extracted():
    return {
        "status": "extracted",
        "result": {
            "entities": [
                {"name": "苹果公司", "canonical": "苹果公司", "type": "组织"},
                {"name": "苹果", "canonical": "苹果", "type": "组织"},
            ],
            "relations": [{"source": "苹果公司", "target": "苹果", "category": "其他"}],
            "dropped": [],
        },
    }


def test_dry_run_and_retry_keep_completed_model_output(experiment, monkeypatch):
    store, models = experiment
    mock = Mock(return_value=extracted())
    monkeypatch.setattr(experiments, "extract_chunk", mock)
    run = experiments.create(store, models, {"text": "苹果公司也叫苹果"}, "admin")
    original = resolve.prepare_build
    monkeypatch.setattr(
        resolve, "prepare_build", Mock(side_effect=RuntimeError("merge failed"))
    )
    experiments.run(store, models, run["id"])
    failed = experiments.get(store.engine, run["id"])
    assert failed["status"] == "failed"
    assert failed["data"]["steps"][0]["status"] == "completed"
    experiments.retry(store, run["id"])
    monkeypatch.setattr(resolve, "prepare_build", original)
    experiments.run(store, models, run["id"])
    complete = experiments.get(store.engine, run["id"])
    assert complete["status"] == "completed"
    assert mock.call_count == 1
    assert complete["data"]["steps"][1]["output"]["summary"]["entity_count"] == 1
    with store.engine.connect() as connection:
        for table in (graph_entities, graph_mentions, graph_relations):
            assert connection.scalar(select(func.count()).select_from(table)) == 0
    with pytest.raises(ValueError):
        experiments.retry(store, run["id"])


def test_restricted_reference_resolves_only_snapshot(experiment):
    store, _ = experiment
    mention = {"name": "GE", "canonical": "GE", "type": "组织"}
    reference = {
        "entities": {},
        "aliases": {resolve.merge_key("组织", "GE"): "existing-ge"},
    }
    with store.engine.connect() as connection:
        plan = resolve.prepare_build(
            connection,
            "online",
            "test",
            [
                {
                    "id": "test",
                    "document_id": "test",
                    "chunk_id": "test",
                    "result": {"entities": [mention], "relations": []},
                }
            ],
            reference=reference,
        )
    assert plan["mentions"][0]["entity_id"] == "existing-ge"
    assert plan["mentions"][0]["resolve_method"] == "alias"
    assert plan["entities"] == []
    assert reference["entities"] == {}


def test_duplicate_queue_delivery_does_not_repeat_model(experiment, monkeypatch):
    store, models = experiment
    mock = Mock(return_value=extracted())
    monkeypatch.setattr(experiments, "extract_chunk", mock)
    run = experiments.create(store, models, {"text": "苹果"}, "admin")
    experiments.run(store, models, run["id"])
    experiments.run(store, models, run["id"])
    assert mock.call_count == 1


def test_api_admin_scope_and_saved_records(monkeypatch):
    from test_app import setup, headers

    fixture = setup.__wrapped__(monkeypatch)
    client, store = next(fixture)
    try:
        assert (
            client.get("/graph/experiments", headers=headers("alice")).status_code
            == 403
        )
        admin = headers("admin")
        response = client.post(
            "/graph/experiments", headers=admin, json={"text": "苹果公司也叫苹果"}
        )
        assert response.status_code == 200, response.text
        experiment_id = response.json()["id"]
        assert (
            client.get(f"/graph/experiments/{experiment_id}", headers=admin).json()[
                "data"
            ]["text"]
            == "苹果公司也叫苹果"
        )
        assert (
            client.get("/graph/experiments", headers=admin).json()["items"][0]["id"]
            == experiment_id
        )
        assert (
            client.post(
                f"/graph/experiments/{experiment_id}/retry", headers=admin
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/graph/experiments", headers=admin, json={"text": "  "}
            ).status_code
            == 400
        )
    finally:
        try:
            next(fixture)
        except StopIteration:
            pass


def test_migration_creates_experiment_table_without_existing_graph_tables():
    import importlib
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect

    migration = importlib.import_module("migrations.versions.0026_graph_experiments")
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
        assert inspect(connection).get_table_names() == ["graph_experiments"]


def test_queue_dispatch_and_recovery(experiment):
    import json

    store, models = experiment
    run = experiments.create(store, models, {"text": "苹果"}, "admin")
    payload = json.loads(store.cache.rpush.call_args.args[1])
    assert payload["type"] == "graph"
    assert payload["stage"] == "experiment"
    store.cache.lrange = Mock(return_value=[])
    store.cache.rpush.reset_mock()
    assert experiments.recover(store) == 1
    assert json.loads(store.cache.rpush.call_args.args[1])["experiment_id"] == run["id"]
    store.cache.lrange = Mock(return_value=[store.cache.rpush.call_args.args[1]])
    store.cache.rpush.reset_mock()
    experiments.recover(store)
    store.cache.rpush.assert_not_called()
