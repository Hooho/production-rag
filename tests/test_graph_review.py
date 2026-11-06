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


def test_judge_sends_short_codes_and_maps_back(monkeypatch):
    candidate = {"id": "5", "entities": [{"id": "x" * 64}, {"id": "y" * 64}]}
    answers = []

    def fake(_, messages):
        answers.append(json.loads(messages[1]["content"]))
        text = json.dumps(reply)
        return text, text, 1, 1, "stop"

    monkeypatch.setattr(review, "call_model", fake)
    reply = {
        "groups": [
            {"ids": ["e1", "e2"], "name": "甲", "type": "人物", "reason": "同一人"}
        ]
    }
    result = review.judge(None, DEFAULT_SCHEMA, candidate)
    # 组号不发给模型，实体用 e1、e2；返回后换回真正的 id。
    assert answers[0]["candidate"] == {"entities": [{"id": "e1"}, {"id": "e2"}]}
    assert result["status"] == "completed"
    assert result["decision"]["groups"][0]["ids"] == ["x" * 64, "y" * 64]
    # 写成组号或别的编号：判为失败，并说明是哪个编号不对。
    reply = {
        "groups": [
            {"ids": ["5", "e2"], "name": "甲", "type": "人物", "reason": "同一人"}
        ]
    }
    failed = review.judge(None, DEFAULT_SCHEMA, candidate)
    assert failed["status"] == "failed" and "'5'" in failed["error"]


def test_validate_ignores_single_id_groups_but_rejects_contradictions():
    candidate = {"entities": [{"id": "e1"}, {"id": "e2"}, {"id": "e3"}]}
    merge = {"ids": ["e1", "e3"], "name": "ADR", "type": "产品", "reason": "同一证券"}
    alone = {"ids": ["e2"], "name": "腾讯控股", "type": "组织", "reason": "公司"}
    # 实际数据 #41：一条合并 + 一个单独列出的，保留合并、忽略单独的。
    value = review.validate(
        json.dumps({"groups": [merge, alone]}), candidate, {"产品", "组织"}
    )
    assert value["groups"] == [merge] and value["ignored"] == ["e2"]
    # 实际数据 #162：两个都单独列出，等于不合并。
    value = review.validate(
        json.dumps({"groups": [alone, {**alone, "ids": ["e1"]}]}),
        candidate,
        {"组织"},
    )
    assert value["groups"] == [] and value["ignored"] == ["e2", "e1"]
    # 实际数据 #21：同一个编号出现在两个合并组里，结论矛盾，仍然失败。
    with pytest.raises(ValueError, match="重复"):
        review.validate(
            json.dumps({"groups": [merge, {**merge, "ids": ["e1", "e2"]}]}),
            candidate,
            {"产品"},
        )
    with pytest.raises(ValueError, match="既单独列出"):
        review.validate(
            json.dumps({"groups": [merge, {**alone, "ids": ["e1"]}]}),
            candidate,
            {"产品", "组织"},
        )
    with pytest.raises(ValueError, match="不在这一组"):
        review.validate(
            json.dumps({"groups": [{**alone, "ids": ["5"]}]}), candidate, {"组织"}
        )


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
    # 开了自动检查（GRAPH_REVIEW_AUTO=1）时：建图写入后排队二次检查，不改建图状态。
    monkeypatch.setattr(build, "REVIEW_AUTO", True)
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
    # 只重试失败的组：失败的判断去掉、重新排队，其他判断和决定保留。
    with pytest.raises(build.BuildError, match="没有判断失败"):
        build.retry_failed_review(store, "b1")
    broken = build.review_report(db, row)
    broken["judgments"][0] = {
        **broken["judgments"][0],
        "status": "failed",
        "error": "x",
    }
    with db.begin() as connection:
        build._save_report(connection, row, broken)
    queue.clear()
    build.retry_failed_review(store, "b1")
    assert queue == ["b1"]
    build.run_review_job(store, fake_models, "b1")
    retried = build.review_report(db, row)
    assert retried["status"] == "ready" and len(calls) == 2
    assert retried["judgments"][0]["status"] == "completed"
    assert retried["decisions"]["1:0"]["decision"] == "approved"
    # 人工合并：搜全部实体，加一条人工建议（默认批准），撤销即删除。
    hits = build.review_entities(store, "b1", "腾讯控股")
    assert hits[0]["names"] == ["腾讯控股"]
    keys = {
        item["names"][0]: item["id"]
        for item in build.review_entities(store, "b1", "腾讯")
    }
    pair = [keys["腾讯"], keys["腾讯股票"]]
    with pytest.raises(build.BuildError, match="至少"):
        build.add_manual_review(store, "b1", pair[:1], "腾讯", "组织", "", "alice")
    with pytest.raises(build.BuildError, match="类型"):
        build.add_manual_review(store, "b1", pair, "腾讯", "未知", "", "alice")
    manual = build.add_manual_review(store, "b1", pair, "腾讯", "组织", "", "alice")
    assert manual["decisions"]["m1:0"]["decision"] == "approved"
    assert "m1:0" in review.proposals(manual) and len(manual["manual_entities"]) == 2
    removed = build.decide_review(store, "b1", ["m1:0"], None, "alice")
    assert not removed["manual"] and "m1:0" not in removed["decisions"]
    build.add_manual_review(store, "b1", pair, "腾讯", "组织", "人工", "alice")
    # 重新检查：清掉模型判断和对它的决定，保留已应用的合并和人工添加的建议。
    build.retry_review(store, "b1")
    fresh = build.review_report(db, row)
    assert fresh["status"] == "queued" and fresh["applied"]["groups"]
    assert list(fresh["decisions"]) == ["m1:0"] and fresh["manual"][0]["id"] == "m1"


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


def test_merge_record_keeps_review_proposals_for_undo():
    from app.graph import query

    detail = {
        "scope": "document",
        "review": {
            "proposal_id": "41:0",
            "proposal_ids": ["41:0", "108:0"],
            "name": "腾讯控股ADR",
            "type": "产品",
            "reason": "同一证券",
        },
        "approved_by": "alice",
    }
    info = query.review_info(detail)
    assert info["proposal_ids"] == ["41:0", "108:0"] and info["approved_by"] == "alice"
    assert query.review_info({"scope": "new"}) is None


def test_merge_record_label_tells_model_and_manual_apart():
    from app.graph import query

    def label(via, proposal_ids=("41:0", "m1:0")):
        return query.review_label(
            {"review": {"proposal_ids": list(proposal_ids), "via": via}}
        )

    assert label(["41:0"]) == "二次检查合并（人工确认）"
    assert label(["m1:0"]) == "二次检查合并（人工添加）"
    assert label(["41:0", "m1:0"]) == "二次检查合并（人工确认 + 人工添加）"
    # 旧记录没有 via：按整组的建议来源算
    assert label(None) == "二次检查合并（人工确认 + 人工添加）"
    assert query.review_source({"review": {"proposal_ids": ["m1:0"]}}) == "manual"
    assert label(None, ["m2:0"]) == "二次检查合并（人工添加）"


def test_apply_records_which_proposals_brought_each_name():
    report = {
        "judgments": [
            {
                "candidate_id": 41,
                "status": "completed",
                "decision": {
                    "groups": [
                        {
                            "ids": ["a", "b"],
                            "name": "X",
                            "type": "产品",
                            "reason": "模型",
                        }
                    ]
                },
            }
        ],
        "manual": [
            {
                "id": "m1",
                "ids": ["b", "c"],
                "name": "X",
                "type": "产品",
                "reason": "人工",
            }
        ],
    }
    groups = review.resolve_groups(report, ["41:0", "m1:0"])
    assert groups[0]["members"] == {"41:0": ["a", "b"], "m1:0": ["b", "c"]}
    plan = {
        "entities": [],
        "mentions": [
            {
                "id": f"m-{key}",
                "entity_id": f"e-{key}",
                "name": key,
                "type": "产品",
                "resolve_method": "exact",
            }
            for key in "abc"
        ],
        "merges": [{"mention_id": f"m-{key}", "detail": {}} for key in "abc"],
        "relations": [],
        "summary": {},
    }
    ids = {key: f"e-{key}" for key in "abc"}
    db = engine()
    with db.begin() as connection:
        review.apply(
            connection,
            plan,
            {"document_id": "doc-a", "space": "online"},
            groups,
            ids,
            "alice",
        )
    via = {row["mention_id"]: row["detail"]["review"]["via"] for row in plan["merges"]}
    assert via == {"m-a": ["41:0"], "m-b": ["41:0", "m1:0"], "m-c": ["m1:0"]}
    assert "members" not in plan["merges"][0]["detail"]["review"]


def test_review_merge_joins_same_named_entity_of_other_documents():
    # 另一份文档里已有「腾讯控股（组织）」；这份文档把腾讯、腾讯控股合并成「腾讯控股（组织）」，
    # 要归到那个共用实体上，而不是新建一个只属于这份文档的同名实体。
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
                    [entity("腾讯控股", "组织")],
                    document_id="doc-b",
                )
            ],
        )
        shared = connection.execute(
            select(graph_mentions.c.entity_id).where(
                graph_mentions.c.document_id == "doc-b"
            )
        ).scalar_one()
    plan = plan_for(db)
    items, ids = review.inventory(plan, {})
    companies = [item["id"] for item in items if item["types"] == ["组织"]]
    groups = review.resolve_groups(one_group_report(companies), ["1:0"])
    with db.begin() as connection:
        records = review.apply(
            connection,
            plan,
            {"document_id": "doc-a", "space": "online"},
            groups,
            ids,
            "alice",
        )
        resolve.write_build(connection, "online", "b1", plan)
        assert records[0]["entity_id"] == shared
        names = connection.execute(
            select(graph_entities.c.name).where(graph_entities.c.name == "腾讯控股")
        ).all()
        assert len(names) == 1


def test_rename_moves_only_chosen_mentions_and_updates_name_and_type():
    # 拆分：同一个实体里只把其中几处名字改成新名字，它们归到新实体，其余不动；改回已有的名字就并回去。
    db = engine()
    with db.connect() as connection:
        plan = resolve.prepare_build(
            connection,
            "online",
            "b1",
            [
                extraction("e1", "c1", [entity("苹果", "组织")]),
                extraction("e2", "c2", [entity("苹果", "组织")]),
                extraction("e3", "c3", [entity("苹果", "组织")]),
            ],
        )
        apple = {row["entity_id"] for row in plan["mentions"]}
        assert len(apple) == 1
        fruit = [row["id"] for row in plan["mentions"] if row["chunk_id"] == "c3"]
        target, affected = review.rename(
            connection, plan, "online", fruit, "苹果（水果）", "产品", "一种水果"
        )
        assert affected == fruit and target not in apple
        moved = next(row for row in plan["mentions"] if row["id"] == fruit[0])
        assert (moved["canonical"], moved["type"], moved["resolve_method"]) == (
            "苹果（水果）",
            "产品",
            "review",
        )
        assert {
            row["entity_id"] for row in plan["mentions"] if row["chunk_id"] != "c3"
        } == apple
        # 改成和已有实体同样的名字和类型：并进那个实体，不新建。
        back, _ = review.rename(connection, plan, "online", fruit, "苹果", "组织")
        assert back in apple


def review_env(monkeypatch):
    """一份已写入图谱的建图记录 + 记录到 document_steps 的检查报告 + 假的模型判断。"""
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
        with db.begin() as connection:
            connection.execute(
                document_steps.delete().where(
                    document_steps.c.document_id == document_id,
                    document_steps.c.step_id == step_id,
                )
            )
            connection.execute(
                document_steps.insert().values(
                    document_id=document_id,
                    step_id=step_id,
                    step_order=12,
                    stage=step_id,
                    title="图谱检查",
                    status=status,
                    detail=detail,
                    result=copy.deepcopy(result),
                    updated="t",
                )
            )

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

    def judge(_, schema, candidate, system_prompt=None):
        calls.append(candidate["id"])
        ids = [
            item["id"] for item in candidate["entities"] if item["types"] == ["组织"]
        ]
        return {
            "candidate_id": candidate["id"],
            "status": "completed",
            "decision": {
                "groups": [
                    {"ids": ids, "name": "腾讯控股", "type": "组织", "reason": "简称"}
                ]
            },
        }

    monkeypatch.setattr(review, "judge", judge)
    monkeypatch.setattr(build, "extraction_rows", lambda *_: [])
    base_plan = plan_for(db)
    monkeypatch.setattr(
        build.resolve, "prepare_build", lambda *_: copy.deepcopy(base_plan)
    )
    return db, store, row, queue, calls


def test_review_starts_manually_can_stop_continue_and_decide_while_running(
    monkeypatch,
):
    db, store, row, queue, calls = review_env(monkeypatch)
    # 默认不自动开始：写入后报告是「未开始」，不排队。
    assert build.REVIEW_AUTO is False
    build.after_write(store, row, None, None)
    assert queue == [] and build.review_report(db, row)["status"] == "idle"
    # 点开始检查后排队；排队中可以停止，停止后任务不再判断。
    build.retry_review(store, "b1")
    assert queue == ["b1"]
    build.stop_review(store, "b1")
    assert build.review_report(db, row)["status"] == "stopped"
    with pytest.raises(build.BuildError, match="没有在进行"):
        build.stop_review(store, "b1")
    build.run_review_job(store, fake_models, "b1")
    assert calls == []
    # 继续检查：只判断还没判断的。
    queue.clear()
    build.continue_review(store, "b1")
    assert queue == ["b1"]
    build.run_review_job(store, fake_models, "b1")
    report = build.review_report(db, row)
    assert report["status"] == "ready" and len(calls) == 1 and report["started"]
    # 模型判断进行中也能先决定；检查任务保存进度时不会把决定冲掉。
    with db.begin() as connection:
        build._save_report(connection, row, {**report, "status": "running"})
    build.decide_review(store, "b1", ["1:0"], "approved", "alice")
    stale = copy.deepcopy(report)
    stale["status"] = "running"
    assert build._save_progress(store, row, stale, "进度") is False
    assert build.review_report(db, row)["decisions"]["1:0"]["decision"] == "approved"
    # 写入后（例如补跑分片）再次变成「未开始」，但模型判断和决定保留；再点开始检查时抽取结果没变，不再调用模型。
    with db.begin() as connection:
        build._save_report(connection, row, {**report, "status": "ready"})
    build.after_write(store, row, build.review_report(db, row), None)
    idle = build.review_report(db, row)
    assert idle["status"] == "idle" and idle["judgments"]
    build.retry_review(store, "b1")
    build.run_review_job(store, fake_models, "b1")
    again = build.review_report(db, row)
    assert again["status"] == "ready" and len(calls) == 1
