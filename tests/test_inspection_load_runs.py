from sqlalchemy import create_engine, event

from app.inspection.service import Inspector
from app.mysql.store import feedback, runs


def test_load_runs_sorts_only_ids_and_loads_full_content_in_batches():
    engine = create_engine("sqlite://")
    runs.create(engine)
    feedback.create(engine)
    since = "2026-10-01"
    answer = {"answer": "完整回答" * 3000}
    trace = {"details": "诊断信息" * 3000}
    statements = []
    with engine.begin() as connection:
        connection.execute(runs.insert(), [
            {"id": f"{i:04}", "session_id": "session", "owner": "alice", "question": str(i),
             "response": answer, "trace": trace, "created": "2026-10-02" if i % 2 else since}
            for i in range(501)
        ] + [{"id": "old", "session_id": "session", "owner": "alice", "question": "旧问题",
              "response": {}, "trace": {}, "created": "2026-09-30"}])
        connection.execute(feedback.insert().values(run_id="0000", owner="alice", session_id="session",
            rating=-1, reason="wrong", comment="有错误", created=since, updated=since))
        event.listen(engine, "before_cursor_execute",
            lambda conn, cursor, statement, parameters, context, executemany: statements.append(statement))
        rows = Inspector(None, None, since).load_runs(connection)
        assert [row["id"] for row in rows] == [f"{i:04}" for i in sorted(range(501), key=lambda i: (i % 2, i))]
        assert all(row["response"] == answer and row["trace"] == trace for row in rows)
        assert rows[0]["rating"] == -1 and rows[0]["comment"] == "有错误"
        assert rows[1]["rating"] is None
        assert len(statements) == 3
        assert "ORDER BY" in statements[0] and "response" not in statements[0] and "trace" not in statements[0]
        assert all("ORDER BY" not in statement for statement in statements[1:])
        statements.clear()
        assert Inspector(None, None, "2026-11-01").load_runs(connection) == []
        assert len(statements) == 1
    engine.dispose()
