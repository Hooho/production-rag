import copy
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app import prompts
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
        {"same_name": 0, "similar": 0, "total": 0},
    )
    groups, stats = review.candidates(items, fake_embed)
    assert len(groups) == 1 and len(groups[0]["entities"]) == 2
    assert groups[0]["kind"] == "similar" and groups[0]["similarity"] > 0.99
    assert len(groups[0]["texts"]) == 2 and groups[0]["pairs"][0][:2] == [0, 1]
    assert stats == {"same_name": 0, "similar": 1, "total": 1}
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


def one_group_report(ids):
    return {
        "judgments": [
            {
                "candidate_id": "1",
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
        ]
    }


def test_apply_only_approved_groups_and_preserves_security_objects():
    db = engine()
    plan = plan_for(db)
    items, ids = review.inventory(plan, {})
    company_ids = [item["id"] for item in items if item["types"] == ["组织"]]
    report = one_group_report(company_ids)
    assert review.resolve_groups(report, []) == []
    groups = review.resolve_groups(report, ["1:0"])
    build_row = {"document_id": "doc-a", "space": "online"}
    with db.begin() as connection:
        untouched = copy.deepcopy(plan)
        review.apply(connection, untouched, build_row, [], ids, "alice")
        assert len({row["entity_id"] for row in untouched["mentions"]}) == 3
        records = review.apply(connection, plan, build_row, groups, ids, "alice")
        assert records[0]["status"] == "completed"
        assert len({row["entity_id"] for row in plan["mentions"]}) == 2
        assert {row["name"] for row in plan["mentions"]} == {
            "腾讯",
            "腾讯控股",
            "腾讯股票",
        }
        # 抽取结果变化后找不到的实体：跳过，不报错。
        missing = review.apply(
            connection,
            copy.deepcopy(untouched),
            build_row,
            [{**groups[0], "ids": ["gone", company_ids[0]]}],
            ids,
            "alice",
        )
        assert missing[0]["status"] == "skipped"
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
    assert result["prompt"][0]["content"] == prompts.compose("graph_review")
    custom = review.judge(None, DEFAULT_SCHEMA, candidate, "自定义提示词")
    assert custom["prompt"][0]["content"] == "自定义提示词"


def test_review_runs_after_write_then_rewrites_with_decisions(monkeypatch):
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
        "status": "completed",
        "active": True,
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
    monkeypatch.setattr(build, "enqueue", lambda _, key, stage=None: queue.append(key))
    calls = []
    prompts_used = []

    def judge(_, schema, candidate, system_prompt=None):
        calls.append(candidate)
        prompts_used.append(system_prompt)
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
    monkeypatch.setattr(build, "extraction_rows", lambda *_: [])
    base_plan = plan_for(db)
    monkeypatch.setattr(
        build.resolve, "prepare_build", lambda *_: copy.deepcopy(base_plan)
    )
    # 建图写入后：排队二次检查，不改建图状态。
    build.after_write(store, row, None, None)
    assert queue == ["b1"]
    build.run_review_job(store, fake_models, "b1")
    report = build.review_report(db, row)
    assert report["status"] == "ready"
    assert report["scan"]["method"]["embedding"]["model"] == "bge-test"
    # 检查开始时定下提示词版本，判断时用报告里存的这一版。
    assert report["prompt_tag"] == "graph_review@内置"
    assert (
        prompts_used == [report["system_prompt"]] == [prompts.compose("graph_review")]
    )
    assert report["scan"]["candidates"][0]["kind"] == "similar"
    with db.connect() as connection:
        assert (
            connection.execute(
                select(graph_builds.c.status).where(graph_builds.c.id == "b1")
            ).scalar_one()
            == "completed"
        )
    # 单条决定：批准、撤销、否决；无效编号报错。
    build.decide_review(store, "b1", ["1:0"], "approved", "alice")
    build.decide_review(store, "b1", ["1:0"], None, "alice")
    build.decide_review(store, "b1", ["1:0"], "rejected", "alice")
    assert build.review_report(db, row)["decisions"]["1:0"]["decision"] == "rejected"
    with pytest.raises(build.BuildError):
        build.decide_review(store, "b1", ["9:9"], "approved", "alice")
    with pytest.raises(build.BuildError, match="还没有批准"):
        build.rewrite_review(store, "b1", "alice")
    build.decide_review(store, "b1", ["1:0"], "approved", "alice")
    queue.clear()
    build.rewrite_review(store, "b1", "alice")
    assert queue == ["b1"]
    saved = build.review_report(db, row)
    assert (
        saved["status"] == "rewriting"
        and saved["applied"]["groups"][0]["name"] == "腾讯控股"
    )
    with pytest.raises(build.BuildError):
        build.decide_review(store, "b1", ["1:0"], None, "alice")
    # 写入时应用已确认的合并，写完回到 ready，不再调用模型、不重新排队检查。
    approved_plan = plan_for(db)
    _, ids = review.inventory(approved_plan, {})
    with db.connect() as connection:
        records = review.apply(
            connection, approved_plan, row, saved["applied"]["groups"], ids, "alice"
        )
    assert len({item["entity_id"] for item in approved_plan["mentions"]}) == 2
    with db.begin() as connection:  # finalize 写完会把建图标回完成
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == "b1")
            .values(status="completed")
        )
    queue.clear()
    build.after_write(store, row, saved, records)
    assert queue == []
    final = build.review_report(db, row)
    assert (
        final["status"] == "ready"
        and final["applied"]["records"][0]["status"] == "completed"
    )
    assert len(calls) == 1
    # 补跑分片后再写入：沿用报告，重新检查时签名不变，不重复调用模型。
    build.after_write(store, row, final, records)
    build.run_review_job(store, fake_models, "b1")
    again = build.review_report(db, row)
    assert again["status"] == "ready" and len(calls) == 1
    assert again["decisions"]["1:0"]["decision"] == "approved"
    # 重新检查：清掉判断和决定，保留已应用的合并。
    build.retry_review(store, "b1")
    fresh = build.review_report(db, row)
    assert fresh["status"] == "queued" and fresh["applied"]["groups"]
    assert "decisions" not in fresh


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
    monkeypatch.setattr(
        graph_routes.graph_query,
        "latest_build",
        lambda *_: {"id": build_id, "document_id": document_id, "status": "completed"},
    )
    calls = []
    monkeypatch.setattr(
        build, "rewrite_review", lambda *args: calls.append(args) or {"id": build_id}
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
        assert client.get(path).json()["report"]["status"] == "ready"
        body = {"build_id": build_id}
        assert (
            client.post(
                path + "/rewrite", headers={"x-user": "reader"}, json=body
            ).status_code
            == 403
        )
        assert (
            client.post(
                path + "/rewrite", json={**body, "build_id": document_id}
            ).status_code
            == 409
        )
        assert not calls
        assert client.post(path + "/rewrite", json=body).status_code == 202
        assert len(calls) == 1 and calls[0][2] == "alice" and calls[0][3] == {}
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
            groups = review.resolve_groups(report, ["1:0"])
            records = review.apply(connection, plan, build_row, groups, ids, "alice")
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


def test_candidates_group_only_when_every_pair_is_similar():
    vectors = {
        "甲": [1.0, 0.0],
        "乙": [0.9, 0.436],
        "丙": [0.5, 0.866],
        "丁": [0.96, 0.28],
    }
    items = [item(key, key) for key in "甲乙丙丁"] + [item("甲2", "甲")]
    groups, stats = review.candidates(
        items, lambda texts: [vectors[text[0]] for text in texts]
    )
    ids = [sorted(e["id"] for e in row["entities"]) for row in groups]
    # 甲、甲2 名字相同；乙、丁和甲两两都 ≥ 0.80，放进同一组。
    # 丙只和乙像（0.83），和甲只有 0.5：进不了这组，也不会把两组串起来，不补查。
    assert ids == [["丁", "乙", "甲", "甲2"]]
    assert groups[0]["kind"] == "similar" and groups[0]["similarity"] >= 0.8
    assert len(groups[0]["pairs"]) == 6
    assert stats == {"same_name": 0, "similar": 1, "total": 1}


def test_candidates_same_name_group_and_size_limit(monkeypatch):
    monkeypatch.setattr(review, "MAX_GROUP_SIZE", 2)
    items = [item("a", "项目A", "其他"), item("b", "项目A", "概念"), item("c", "项目A")]
    groups, _ = review.candidates(items)
    assert [row["kind"] for row in groups] == ["same_name"]
    assert len(groups[0]["entities"]) == 2


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


def test_resolve_groups_requires_choice_for_conflicting_names():
    report = chained_report()
    with pytest.raises(ValueError, match="请先选定"):
        review.resolve_groups(report, ["1:0", "2:0"])
    groups = review.resolve_groups(
        report, ["1:0", "2:0"], {"1:0": {"name": "腾讯控股", "type": "组织"}}
    )
    assert groups[0]["ids"] == ["a", "b", "c"] and groups[0]["name"] == "腾讯控股"
