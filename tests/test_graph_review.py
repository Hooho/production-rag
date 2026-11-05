import copy
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.graph import build, resolve, review
from app.graph.schemas import DEFAULT_SCHEMA
from app.mysql.tables import (
    document_steps,
    graph_builds,
    graph_entities,
    graph_mentions,
)
from test_graph_resolve import engine, entity, extraction


def plan_for(db):
    with db.connect() as connection:
        return resolve.prepare_build(
            connection,
            "online",
            "b1",
            [
                extraction(
                    "e1",
                    "c1",
                    [
                        entity("腾讯", "组织"),
                        entity("腾讯控股", "组织"),
                        entity("腾讯股票", "产品"),
                    ],
                )
            ],
        )


# 测试用向量：名字里有「股票」的指向另一方向，腾讯和腾讯控股几乎重合。
def fake_embed(texts):
    return [[0.0, 1.0] if "股票" in text else [1.0, 0.1] for text in texts]


fake_models = SimpleNamespace(
    embedding_mode="local", embedding_model="bge-test", embed=fake_embed
)


def test_candidates_and_model_validation():
    db = engine()
    items, ids = review.inventory(
        plan_for(db), {"c1": "段永平投资腾讯，持有腾讯股票。"}
    )
    assert review.candidates(items) == (
        [],
        {"same_name": 0, "similar": 0, "similar_total": 0},
    )
    groups, stats = review.candidates(items, fake_embed)
    assert len(groups) == 1 and len(groups[0]["entities"]) == 2
    assert groups[0]["kind"] == "similar" and groups[0]["similarity"] > 0.99
    assert groups[0]["ranks"] == [1, 1] and len(groups[0]["texts"]) == 2
    assert stats == {"same_name": 0, "similar": 1, "similar_total": 1}
    assert len(ids) == 3
    candidate = groups[0]
    keys = [row["id"] for row in candidate["entities"]]
    good = {
        "groups": [
            {"ids": keys[:2], "name": "腾讯控股", "type": "组织", "reason": "公司简称"}
        ]
    }
    assert review.validate(json.dumps(good), candidate, {"组织"}) == good
    for bad in [
        {
            "groups": [
                {
                    "ids": ["foreign", keys[0]],
                    "name": "腾讯",
                    "type": "组织",
                    "reason": "错",
                }
            ]
        },
        {"groups": [{"ids": keys[:2], "name": "腾讯", "type": "未知", "reason": "错"}]},
        {"groups": [good["groups"][0], good["groups"][0]]},
    ]:
        with pytest.raises(ValueError):
            review.validate(json.dumps(bad), candidate, {"组织"})


def test_apply_requires_approval_and_preserves_security_objects_and_provenance():
    db = engine()
    plan = plan_for(db)
    items, ids = review.inventory(plan, {})
    company_ids = [item["id"] for item in items if item["types"] == ["组织"]]
    decision = {
        "ids": company_ids,
        "name": "腾讯控股",
        "type": "组织",
        "reason": "公司别名",
    }
    report = {
        "status": "awaiting_review",
        "judgments": [
            {
                "candidate_id": "1",
                "status": "completed",
                "decision": {"groups": [decision]},
            }
        ],
        "approved_ids": ["1:0"],
        "approved_by": "alice",
    }
    with db.begin() as connection:
        with pytest.raises(ValueError, match="人工确认"):
            review.apply(
                connection,
                plan,
                {"document_id": "doc-a", "space": "online"},
                report,
                ids,
            )
        rejected = copy.deepcopy(plan)
        report["status"] = "confirmed"
        report["approved_ids"] = []
        review.apply(
            connection,
            rejected,
            {"document_id": "doc-a", "space": "online"},
            report,
            ids,
        )
        assert len({row["entity_id"] for row in rejected["mentions"]}) == 3
        report["approved_ids"] = ["1:0"]
        review.apply(
            connection, plan, {"document_id": "doc-a", "space": "online"}, report, ids
        )
        assert len({row["entity_id"] for row in plan["mentions"]}) == 2
        assert {row["name"] for row in plan["mentions"]} == {
            "腾讯",
            "腾讯控股",
            "腾讯股票",
        }
        resolve.write_build(connection, "online", "b1", plan)
        assert connection.execute(select(graph_entities.c.id)).all()
        assert len(connection.execute(select(graph_mentions.c.id)).all()) == 3
        first, first_ids = review.inventory(plan_for(db), {})
        assert set(first_ids) == set(ids)


def test_judge_preserves_raw_failure_and_usage(monkeypatch):
    candidate = {"id": "1", "entities": [{"id": "a"}, {"id": "b"}]}
    monkeypatch.setattr(
        review,
        "call_model",
        lambda *args: ("bad response", "bad response", 12, 3, "stop"),
    )
    result = review.judge(None, DEFAULT_SCHEMA, candidate)
    assert result["status"] == "failed" and result["raw_output"] == "bad response"
    assert result["input_tokens"] == 12 and result["output_tokens"] == 3
    assert result["prompt"][0]["content"] == review.SYSTEM


def test_review_waits_confirm_then_applies_without_recalling_model(monkeypatch):
    db = engine()
    row = {
        "id": "b1",
        "space": "online",
        "document_id": "doc-a",
        "doc_key": "key",
        "schema_id": "default-v1",
        "provider": "test",
        "model": "test",
        "prompt_tag": "test",
        "prompt_identity": "test",
        "trigger_kind": "manual",
        "status": "running",
        "active": False,
        "created_by": "alice",
        "created": "t",
        "updated": "t",
    }
    with db.begin() as connection:
        connection.execute(graph_builds.insert().values(**row))
    store = SimpleNamespace(engine=db)

    def save(
        _store, document_id, step_id, status, detail, result=None, duration_ms=None
    ):
        values = dict(
            document_id=document_id,
            step_id=step_id,
            step_order=12,
            stage=step_id,
            title="二次检查合并",
            status=status,
            detail=detail,
            result=copy.deepcopy(result),
            updated="t",
        )
        with db.begin() as connection:
            connection.execute(
                document_steps.delete().where(
                    document_steps.c.document_id == document_id,
                    document_steps.c.step_id == step_id,
                )
            )
            connection.execute(document_steps.insert().values(**values))

    monkeypatch.setattr(build, "write_step", save)
    monkeypatch.setattr(
        build, "build_inputs", lambda *_: {"schema_snapshot": DEFAULT_SCHEMA}
    )
    monkeypatch.setattr(
        build,
        "chunk_rows",
        lambda *_: [{"chunk_id": "c1", "content": "腾讯与腾讯控股为公司简称。"}],
    )
    monkeypatch.setattr(build, "models_for", lambda *_: None)
    queue = []
    monkeypatch.setattr(build, "enqueue", lambda _, key: queue.append(key))
    calls = []

    def judge(_, schema, candidate):
        calls.append(candidate)
        ids = [
            item["id"] for item in candidate["entities"] if item["types"] == ["组织"]
        ]
        return {
            "candidate_id": candidate["id"],
            "status": "completed",
            "decision": {
                "groups": [
                    {
                        "ids": ids,
                        "name": "腾讯控股",
                        "type": "组织",
                        "reason": "公司简称",
                    }
                ]
            },
        }

    monkeypatch.setattr(review, "judge", judge)
    report = build.secondary_review(store, fake_models, row, plan_for(db))
    assert report["scan"]["method"]["embedding"]["model"] == "bge-test"
    assert report["scan"]["candidates"][0]["kind"] == "similar"
    build.decide_review(store, "b1", ["1:0"], "approved", "alice")
    build.decide_review(store, "b1", ["1:0"], None, "alice")
    build.decide_review(store, "b1", ["1:0"], "rejected", "alice")
    saved = build.review_report(db, row)
    assert saved["decisions"]["1:0"]["decision"] == "rejected"
    with pytest.raises(build.BuildError):
        build.decide_review(store, "b1", ["9:9"], "approved", "alice")
    assert report["status"] == "awaiting_review"
    with db.connect() as connection:
        assert not connection.execute(select(graph_entities)).all()
    with pytest.raises(build.BuildError):
        build.confirm_review(store, "b1", ["invalid"], "alice")
    build.confirm_review(store, "b1", ["1:0"], "alice")
    with pytest.raises(build.BuildError):
        build.confirm_review(store, "b1", ["1:0"], "alice")
    approved_plan = plan_for(db)
    result = build.secondary_review(store, fake_models, row, approved_plan)
    assert result["status"] == "prepared"
    assert len(calls) == 1 and queue == ["b1"]
    assert len({item["entity_id"] for item in approved_plan["mentions"]}) == 2


def test_review_api_permissions_and_build_identity(monkeypatch):
    from fastapi import FastAPI, Header
    from fastapi.testclient import TestClient
    from app.api import graph_routes

    document_id = "00000000-0000-0000-0000-000000000001"
    build_id = "00000000-0000-0000-0000-000000000002"
    db = engine()
    store = SimpleNamespace(
        engine=db,
        readable_document=lambda username, _: {"owner": "alice"}
        if username in ("alice", "reader")
        else None,
    )
    monkeypatch.setattr(
        graph_routes.graph_query,
        "latest_build",
        lambda *_: {"id": build_id, "document_id": document_id},
    )
    monkeypatch.setattr(
        build,
        "review_report",
        lambda *_: {"build_id": build_id, "status": "awaiting_review"},
    )
    calls = []
    monkeypatch.setattr(
        build, "confirm_review", lambda *args: calls.append(args) or {"id": build_id}
    )

    def current_user(x_user: str = Header("alice")):
        return {"username": x_user, "is_admin": False}

    app = FastAPI()
    app.state.store = store
    app.include_router(
        graph_routes.build_router(current_user, lambda *_: None, lambda *_: None)
    )
    with TestClient(app) as client:
        path = f"/documents/{document_id}/graph/review"
        assert (
            client.get(path, headers={"x-user": "reader"}).json()["can_confirm"]
            is False
        )
        assert client.get(path, headers={"x-user": "outsider"}).status_code == 404
        body = {"build_id": build_id, "approved_ids": []}
        assert (
            client.post(
                path + "/confirm", headers={"x-user": "reader"}, json=body
            ).status_code
            == 403
        )
        assert (
            client.post(
                path + "/confirm", json={**body, "build_id": document_id}
            ).status_code
            == 409
        )
        assert not calls
        assert client.post(path + "/confirm", json=body).status_code == 202
        assert len(calls) == 1 and calls[0][3] == "alice" and calls[0][4] == {}
        decided = []
        monkeypatch.setattr(
            build, "decide_review", lambda *args: decided.append(args) or {}
        )
        decide = {"build_id": build_id, "proposal_ids": ["1:0"], "decision": "approved"}
        assert (
            client.post(
                path + "/decide", headers={"x-user": "reader"}, json=decide
            ).status_code
            == 403
        )
        assert (
            client.post(
                path + "/decide", json={**decide, "decision": "maybe"}
            ).status_code
            == 422
        )
        assert client.post(path + "/decide", json=decide).status_code == 200
        assert decided[0][2:] == (["1:0"], "approved", "alice")


def test_review_keeps_other_documents_entities_unchanged_and_is_repeatable():
    db = engine()
    with db.begin() as connection:
        resolve.resolve_build(
            connection,
            "online",
            "other-build",
            [
                extraction(
                    "other-extraction",
                    "other-chunk",
                    [entity("腾讯", "组织")],
                    document_id="doc-b",
                )
            ],
        )
        original = connection.execute(
            select(graph_mentions.c.entity_id).where(
                graph_mentions.c.document_id == "doc-b"
            )
        ).scalar_one()
    build_row = {"document_id": "doc-a", "space": "online"}
    targets = []
    for _ in range(2):
        plan = plan_for(db)
        items, ids = review.inventory(plan, {})
        companies = [item["id"] for item in items if item["types"] == ["组织"]]
        report = {
            "status": "confirmed",
            "approved_ids": ["1:0"],
            "approved_by": "alice",
            "judgments": [
                {
                    "candidate_id": "1",
                    "status": "completed",
                    "decision": {
                        "groups": [
                            {
                                "ids": companies,
                                "name": "腾讯控股",
                                "type": "组织",
                                "reason": "公司简称",
                            }
                        ]
                    },
                }
            ],
        }
        with db.begin() as connection:
            records = review.apply(connection, plan, build_row, report, ids)
            targets.append(records[0]["entity_id"])
            resolve.write_build(connection, "online", "b1", plan)
            assert (
                connection.execute(
                    select(graph_mentions.c.entity_id).where(
                        graph_mentions.c.document_id == "doc-b"
                    )
                ).scalar_one()
                == original
            )
            assert (
                connection.execute(
                    select(graph_entities.c.name).where(graph_entities.c.id == original)
                ).scalar_one()
                == "腾讯"
            )
    assert targets[0] == targets[1] and targets[0] != original


def item(key, name, kind="组织"):
    return {
        "id": key,
        "names": [name],
        "types": [kind],
        "descriptions": [],
        "evidence": [],
    }


def test_candidates_pair_without_chaining_and_same_name_first():
    vectors = {"甲": [1.0, 0.0], "乙": [0.9, 0.436], "丙": [0.5, 0.866]}
    items = [item("a", "甲"), item("b", "乙"), item("c", "丙"), item("d", "甲")]
    groups, stats = review.candidates(
        items, lambda texts: [vectors[text[0]] for text in texts]
    )
    kinds = [(row["kind"], [e["id"] for e in row["entities"]]) for row in groups]
    # 甲、甲 名字相同成组；甲~乙、乙~丙 各成一对，甲和丙（相似度 0.5）不会被串到一起。
    assert kinds[0] == ("same_name", ["a", "d"])
    pairs = sorted(sorted(ids) for kind, ids in kinds[1:])
    assert pairs == [["a", "b"], ["b", "c"], ["b", "d"]]
    assert all(kind == "similar" for kind, _ in kinds[1:])
    assert stats["same_name"] == 1


def chained_report():
    def judgment(candidate_id, ids, name):
        return {
            "candidate_id": candidate_id,
            "status": "completed",
            "decision": {
                "groups": [{"ids": ids, "name": name, "type": "组织", "reason": name}]
            },
        }

    return {
        "status": "awaiting_review",
        "judgments": [
            judgment("1", ["a", "b"], "腾讯控股"),
            judgment("2", ["b", "c"], "腾讯控股有限公司"),
            judgment("3", ["d", "e"], "亚马逊"),
        ],
    }


def test_components_join_shared_entities_and_need_a_choice():
    report = chained_report()
    groups = review.components(report, {"1:0", "2:0", "3:0"})
    assert [row["key"] for row in groups] == ["1:0", "3:0"]
    assert groups[0]["ids"] == ["a", "b", "c"]
    assert [row["name"] for row in groups[0]["options"]] == [
        "腾讯控股",
        "腾讯控股有限公司",
    ]
    assert len(groups[1]["options"]) == 1
