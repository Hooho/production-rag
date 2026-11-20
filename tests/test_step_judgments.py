"""图谱检查的 AI 判断逐项存表：保存进度只写变了的行，document_steps 里不再存整份判断。"""

import json

from sqlalchemy import event, select

from app.graph import checks
from app.mysql import step_judgments
from app.mysql.tables import document_steps, graph_step_judgments
from test_app import headers, setup  # noqa: F401
from test_graph_build import add_document, build, enable_model, run_graph_jobs
from test_graph_resolve import engine

STEP = "graph_check_glean"


def judgment(item_id, decision="d"):
    return {
        "item_id": item_id,
        "status": "completed",
        "decision": {"suggest": decision},
        "prompt": [{"role": "system", "content": "很长的提示词" * 200}],
        "raw_output": "模型原始输出" * 50,
        "input_tokens": 10,
    }


def report(judgments, build_id="b1"):
    return {"build_id": build_id, "status": "running", "judgments": judgments}


def writes(db):
    """记录对 graph_step_judgments 的写入语句（INSERT / UPDATE / DELETE）和各自的行数。"""
    seen = []

    @event.listens_for(db, "before_cursor_execute")
    def record(conn, cursor, statement, parameters, context, executemany):
        head = statement.lstrip().split(None, 1)[0].upper()
        if (
            head in ("INSERT", "UPDATE", "DELETE")
            and "graph_step_judgments" in statement
        ):
            seen.append((head, len(parameters) if executemany else 1))

    return seen


def saved(db, value):
    with db.begin() as connection:
        return step_judgments.detach(connection, "doc", STEP, value)


def loaded(db, value, trace=True):
    with db.connect() as connection:
        return step_judgments.attach(connection, "doc", STEP, value, trace)


def test_progress_writes_only_the_new_judgment():
    db = engine()
    judgments = {f"c{index}": judgment(f"c{index}") for index in range(30)}
    stored = saved(db, report(judgments))
    assert "judgments" not in stored
    seen = writes(db)
    # 再判断完一项：只插入这一行，已有的 30 行不动。
    judgments["c30"] = judgment("c30")
    saved(db, report(judgments))
    assert [row for row in seen if row[0] == "INSERT"] == [("INSERT", 1)]
    assert not [row for row in seen if row[0] == "UPDATE"]
    back = loaded(db, stored)
    assert list(back["judgments"]) == [f"c{index}" for index in range(31)]
    assert back["judgments"]["c3"] == judgment("c3")


def test_light_read_omits_trace_and_writing_it_back_keeps_trace():
    db = engine()
    saved(db, report({"c1": judgment("c1")}))
    light = loaded(db, {"build_id": "b1", "status": "ready"}, trace=False)
    assert "prompt" not in light["judgments"]["c1"]
    # 不带 prompt 的判断改了决定再写回：库里的 prompt 和原始输出保留。
    light["judgments"]["c1"]["decision"] = {"suggest": "changed"}
    saved(db, light)
    full = loaded(db, {"build_id": "b1"})
    assert full["judgments"]["c1"]["decision"] == {"suggest": "changed"}
    assert full["judgments"]["c1"]["prompt"] == judgment("c1")["prompt"]


def test_missing_key_keeps_judgments_and_empty_clears_them():
    db = engine()
    saved(db, report({"c1": judgment("c1"), "c2": judgment("c2")}))
    saved(db, {"build_id": "b1", "status": "stopped"})
    assert list(loaded(db, {"build_id": "b1"})["judgments"]) == ["c1", "c2"]
    saved(db, report({"c2": judgment("c2")}))
    assert list(loaded(db, {"build_id": "b1"})["judgments"]) == ["c2"]
    saved(db, report({}))
    assert loaded(db, {"build_id": "b1"})["judgments"] == {}


def test_new_build_replaces_old_rows_and_legacy_report_is_returned_as_is():
    db = engine()
    saved(db, report({"c1": judgment("c1")}, "old"))
    saved(db, report({"c9": judgment("c9")}, "new"))
    with db.connect() as connection:
        rows = connection.execute(
            select(graph_step_judgments.c.build_id, graph_step_judgments.c.item_id)
        ).all()
    assert [tuple(row) for row in rows] == [("new", "c9")]
    # 升级前存的报告：judgments 还在 result 里，原样返回。
    legacy = report({"c1": judgment("c1")}, "old")
    assert loaded(db, legacy) is legacy


def test_merge_review_judgments_keep_list_order():
    db = engine()
    rows = [{"candidate_id": key, "status": "completed"} for key in ("3", "1", "2")]
    with db.begin() as connection:
        step_judgments.detach(
            connection, "doc", "graph_review", {"build_id": "b1", "judgments": rows}
        )
    with db.connect() as connection:
        back = step_judgments.attach(
            connection, "doc", "graph_review", {"build_id": "b1"}
        )
    assert back["judgments"] == rows


# 端到端：判断过程中 document_steps 里没有判断；详情接口带 prompt，处理流程不带。
def test_check_reports_store_judgments_outside_document_steps(setup, monkeypatch):
    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    assert build(client, document_id).status_code == 202
    run_graph_jobs(store, models)
    build_id = client.get(f"/documents/{document_id}/graph", headers=headers()).json()[
        "build"
    ]["id"]

    def fake(_, messages):
        return (
            "raw",
            json.dumps({"verdict": "supported", "reason": "r"}),
            5,
            3,
            "stop",
        )

    monkeypatch.setattr(checks.extract, "call_model", fake)
    url = f"/documents/{document_id}/graph/check/relation"
    response = client.post(
        f"{url}/start",
        headers=headers(),
        json={"build_id": build_id, "params": {"sample": 100}},
    )
    assert response.status_code == 202, response.text
    run_graph_jobs(store, models)
    client.post(f"{url}/judge", headers=headers(), json={"build_id": build_id})
    run_graph_jobs(store, models)
    with store.engine.connect() as connection:
        result = connection.execute(
            select(document_steps.c.result).where(
                document_steps.c.document_id == document_id,
                document_steps.c.step_id == "graph_check_relation",
            )
        ).scalar_one()
        count = len(
            connection.execute(
                select(graph_step_judgments.c.item_id).where(
                    graph_step_judgments.c.document_id == document_id
                )
            ).all()
        )
    assert "judgments" not in result and count == len(result["items"]) == 2
    detail = client.get(url, headers=headers()).json()["report"]
    assert detail["status"] == "ready"
    assert all(row["prompt"] for row in detail["judgments"].values())
    steps = client.get(f"/documents/{document_id}", headers=headers()).json()["steps"]
    listed = next(row for row in steps if row["step_id"] == "graph_check_relation")
    assert len(listed["result"]["judgments"]) == 2
    assert all("prompt" not in row for row in listed["result"]["judgments"].values())
    summary = client.get(
        f"/documents/{document_id}/graph/check", headers=headers()
    ).json()["steps"]["relation"]
    assert summary["judged"] == 2
