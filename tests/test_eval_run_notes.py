from sqlalchemy import select

from app.evaluation.results import (
    NOTE_PREFIX,
    delete_run,
    list_runs,
    load_run,
    save_run,
    save_run_note,
)
from app.mysql.store import settings
from test_app import headers, setup  # noqa: F401


def test_notes_survive_progress_updates_and_are_isolated(setup):
    client, store = setup
    first = {
        "id": "20261029-120001_test",
        "kind": "special",
        "status": "running",
        "config": {},
        "summary": None,
    }
    second = {**first, "id": "20261029-120002_test"}
    save_run(first, store.engine)
    save_run(second, store.engine)
    result = save_run_note(
        first["id"], "  调低阈值后再比较\n第二行  ", "admin", store.engine
    )
    assert result["note"] == "调低阈值后再比较\n第二行"
    # 后台持有旧快照，继续保存进度不能覆盖备注。
    save_run(
        {**first, "status": "completed", "progress": {"done": 12, "total": 12}},
        store.engine,
    )
    assert load_run(first["id"], store.engine)["note"] == result["note"]
    briefs = {item["id"]: item for item in list_runs(store.engine)}
    assert briefs[first["id"]]["note_updated_by"] == "admin"
    assert "note" not in briefs[second["id"]]
    assert save_run_note(first["id"], "", "admin", store.engine)["note"] == ""
    assert load_run(first["id"], store.engine)["note"] == ""
    assert delete_run(first["id"], store.engine)
    with store.engine.connect() as connection:
        assert (
            connection.execute(
                select(settings.c.key).where(
                    settings.c.key == NOTE_PREFIX + first["id"]
                )
            ).first()
            is None
        )
    assert load_run(second["id"], store.engine) is not None


def test_note_api_permissions_validation_and_reload(setup):
    client, store = setup
    run_id = "20261029-120003_test"
    save_run(
        {
            "id": run_id,
            "kind": "retrieval",
            "status": "completed",
            "config": {},
            "summary": None,
        },
        store.engine,
    )
    url = f"/eval/runs/{run_id}/note"
    assert client.put(url, json={"note": "备注"}).status_code == 401
    assert client.put(url, json={"note": "备注"}, headers=headers()).status_code == 403
    assert (
        client.put(
            url, json={"note": "字" * 1001}, headers=headers("admin")
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/eval/runs/20261029-120004_missing/note",
            json={"note": "不存在"},
            headers=headers("admin"),
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/eval/runs/bad-id/note", json={"note": "不存在"}, headers=headers("admin")
        ).status_code
        == 404
    )
    result = client.put(
        url, json={"note": "本次改了重排阈值"}, headers=headers("admin")
    )
    assert result.status_code == 200 and result.json()["note_updated_by"] == "admin"
    assert (
        next(
            item
            for item in client.get("/eval/runs", headers=headers("admin")).json()[
                "runs"
            ]
            if item["id"] == run_id
        )["note"]
        == "本次改了重排阈值"
    )
    assert (
        client.get(f"/eval/runs/{run_id}", headers=headers("admin")).json()["note"]
        == "本次改了重排阈值"
    )
    assert (
        client.put(url, json={"note": ""}, headers=headers("admin")).json()["note"]
        == ""
    )
