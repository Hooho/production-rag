from sqlalchemy import select

from app.graph import build as graph_build
from app.graph import query, resolve, versions
from app.mysql.tables import (
    document_heads,
    documents,
    graph_builds,
    graph_chunk_extractions,
    graph_mentions,
    graph_versions,
)
from test_app import setup  # noqa: F401
from test_graph_resolve import engine, entity, extraction


def add_build(db, build_id, document_id="doc-a", doc_key="key-a", active=False):
    row = {
        "id": build_id,
        "space": "online",
        "document_id": document_id,
        "doc_key": doc_key,
        "schema_id": "default-v1",
        "provider": "test",
        "model": "test",
        "prompt_tag": "test",
        "prompt_identity": "test",
        "trigger_kind": "manual",
        "status": "completed",
        "active": active,
        "total": 1,
        "created_by": "alice",
        "created": "t",
        "updated": "t",
    }
    with db.begin() as connection:
        connection.execute(graph_builds.insert().values(**row))
        connection.execute(
            graph_chunk_extractions.insert().values(
                id=f"{build_id}-e",
                build_id=build_id,
                document_id=document_id,
                chunk_id=f"{document_id}-c",
                chunk_key="k",
                position=0,
                cache_key="ck",
                status="extracted",
                created="t",
            )
        )
        if not connection.execute(
            select(documents.c.id).where(documents.c.id == document_id)
        ).first():
            connection.execute(
                documents.insert().values(
                    id=document_id,
                    owner="alice",
                    title=document_id,
                    filename="a.txt",
                    path="a.txt",
                    status="ready",
                    doc_key=doc_key,
                    created="t",
                    updated="t",
                )
            )
        if not connection.execute(
            select(document_heads.c.doc_key).where(document_heads.c.doc_key == doc_key)
        ).first():
            connection.execute(
                document_heads.insert().values(
                    doc_key=doc_key,
                    owner="alice",
                    title=document_id,
                    current_document_id=document_id,
                    current_version=1,
                    updated="t",
                )
            )
    return row


# 用一组名字写入一个新版本，返回版本信息。
def write(db, build, names, origin="build", active=True):
    with db.begin() as connection:
        plan = resolve.prepare_build(
            connection,
            "online",
            build["id"],
            [
                extraction(
                    f"{build['id']}-e",
                    f"{build['document_id']}-c",
                    [entity(name, "组织") for name in names],
                    document_id=build["document_id"],
                )
            ],
        )
        version = versions.create(
            connection,
            build,
            origin,
            graph_build.version_summary(plan["summary"]),
            "alice",
        )
        resolve.write_build(connection, "online", version["id"], plan)
        if active:
            versions.activate(connection, version["id"])
        versions.prune(connection, build["document_id"])
    return version


def names_of(db, document_id, version_id=None):
    result = query.document_graph(
        db, document_id, view="entities", version_id=version_id
    )
    return sorted(item["name"] for item in result["entities"]["items"]), result


def test_versions_are_kept_apart_and_switching_changes_what_is_read():
    db = engine()
    build = add_build(db, "b1")
    first = write(db, build, ["腾讯"])
    # 第一个版本的 id 就是建图 id，旧数据不用改。
    assert first == {"id": "b1", "number": 1}
    second = write(db, build, ["腾讯", "网易"], origin="check", active=False)
    assert second["number"] == 2 and second["id"] != "b1"
    # 没设为生效：文档页签默认、全局图谱都还是第一个版本。
    names, result = names_of(db, "doc-a")
    assert names == ["腾讯"] and result["version"]["number"] == 1
    assert [row["number"] for row in result["versions"]] == [2, 1]
    with db.connect() as connection:
        assert [row["id"] for row in query.visible_builds(connection)] == ["b1"]
    # 指定版本可以查看；不属于这份文档的版本报错。
    assert names_of(db, "doc-a", second["id"])[0] == ["网易", "腾讯"]
    try:
        names_of(db, "doc-a", "nope")
        raise AssertionError("应当报错")
    except ValueError:
        pass
    # 设为生效后，默认显示和全局图谱都换成第二个版本；建图记录上的数量跟着换。
    with db.begin() as connection:
        versions.activate(connection, second["id"])
        assert [row["id"] for row in query.visible_builds(connection)] == [second["id"]]
        assert (
            connection.execute(
                select(graph_builds.c.entity_count).where(graph_builds.c.id == "b1")
            ).scalar_one()
            == 2
        )
    assert names_of(db, "doc-a")[0] == ["网易", "腾讯"]
    # 回滚：旧版本重新设为生效。
    with db.begin() as connection:
        versions.activate(connection, "b1")
    assert names_of(db, "doc-a")[0] == ["腾讯"]


def test_only_latest_five_versions_are_kept_but_active_one_survives():
    db = engine()
    build = add_build(db, "b1")
    write(db, build, ["腾讯"])  # v1，生效
    for index in range(6):
        write(db, build, ["腾讯", f"公司{index}"], origin="check", active=False)
    with db.connect() as connection:
        rows = versions.listing(connection, "doc-a")
        kept = [row["number"] for row in rows]
        assert kept == [7, 6, 5, 4, 3, 1]
        assert [row["number"] for row in rows if row["active"]] == [1]
        # 删掉的版本，名字一起删掉；没人用的实体也清理掉。
        alive = set(connection.execute(select(graph_mentions.c.build_id)).scalars())
        assert alive == {row["id"] for row in rows}
        assert names_of(db, "doc-a")[0] == ["腾讯"]


def test_only_one_active_version_per_document_across_builds():
    db = engine()
    old = add_build(db, "b1")
    write(db, old, ["腾讯"])
    new = add_build(db, "b2")
    second = write(db, new, ["腾讯", "网易"])
    with db.connect() as connection:
        active = (
            connection.execute(
                select(graph_versions.c.id).where(graph_versions.c.active.is_(True))
            )
            .scalars()
            .all()
        )
        assert active == [second["id"]]
        flags = dict(
            connection.execute(select(graph_builds.c.id, graph_builds.c.active)).all()
        )
        assert flags == {"b1": False, "b2": True}
    # 把旧建图的版本设为生效：生效的建图也跟着换回去。
    with db.begin() as connection:
        versions.activate(connection, "b1")
        flags = dict(
            connection.execute(select(graph_builds.c.id, graph_builds.c.active)).all()
        )
        assert flags == {"b1": True, "b2": False}


def test_cross_document_scope_only_counts_active_versions():
    db = engine()
    other = add_build(db, "b9", document_id="doc-b", doc_key="key-b")
    hidden = write(db, other, ["腾讯"], origin="check", active=False)
    assert hidden["id"] == "b9"
    build = add_build(db, "b1")
    with db.connect() as connection:
        plan = resolve.prepare_build(
            connection,
            "online",
            "b1",
            [
                extraction(
                    "b1-e", "doc-a-c", [entity("腾讯", "组织")], document_id="doc-a"
                )
            ],
        )
    # 另一份文档里的「腾讯」所在版本没生效：不算跨文档合并。
    assert plan["summary"]["scope_counts"]["global"] == 0
    with db.begin() as connection:
        versions.activate(connection, "b9")
        plan = resolve.prepare_build(
            connection,
            "online",
            "b1",
            [
                extraction(
                    "b1-e", "doc-a-c", [entity("腾讯", "组织")], document_id="doc-a"
                )
            ],
        )
    assert plan["summary"]["scope_counts"]["global"] == 1
    write(db, build, ["腾讯"])


def test_remove_documents_drops_all_versions():
    db = engine()
    build = add_build(db, "b1")
    write(db, build, ["腾讯"])
    write(db, build, ["网易"], origin="check", active=False)
    with db.begin() as connection:
        graph_build.remove_documents(connection, ["doc-a"])
        assert not connection.execute(select(graph_versions.c.id)).first()
        assert not connection.execute(select(graph_mentions.c.id)).first()


# 完整流程：建图写入 v1 直接生效；图谱检查确认写入存成 v2，不生效；通过接口设为生效后，文档页签和全局图谱都换成 v2。
def test_check_write_saves_inactive_version_until_activated(setup):
    from test_app import headers
    from test_graph_build import (
        add_document,
        build as start_build,
        enable_model,
        run_graph_jobs,
    )

    client, store = setup
    models = enable_model(client)
    document_id = add_document(client)
    assert start_build(client, document_id).status_code == 202
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert [row["number"] for row in graph["versions"]] == [1]
    assert graph["version"]["active"] is True and graph["version"]["origin"] == "build"
    build_row = graph_build.get_build(store.engine, graph["build"]["id"])
    # 模拟第 5 步「确认，写入图谱」：报告标成 rewriting，建图任务重新写入一次。
    report = {
        "build_id": build_row["id"],
        "status": "rewriting",
        "applied": {"groups": [], "approved_ids": [], "by": "alice", "at": "t"},
    }
    graph_build._review_step(store, build_row, report, "running", "重写中")
    with store.engine.begin() as connection:
        connection.execute(
            graph_builds.update()
            .where(graph_builds.c.id == build_row["id"])
            .values(status="queued")
        )
    graph_build.enqueue(store, build_row["id"])
    run_graph_jobs(store, models)
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    numbers = {row["number"]: row for row in graph["versions"]}
    assert set(numbers) == {1, 2}
    assert numbers[2]["origin"] == "check" and numbers[2]["active"] is False
    # 默认还是显示生效的 v1；可以指定查看 v2。
    assert graph["version"]["number"] == 1
    second = numbers[2]["id"]
    viewed = client.get(
        f"/documents/{document_id}/graph?version={second}", headers=headers()
    ).json()
    assert viewed["version"]["number"] == 2 and viewed["version"]["active"] is False
    # 只有上传者和管理员可以设为生效。
    assert client.post(
        f"/documents/{document_id}/graph/versions/{second}/activate",
        headers=headers("bob"),
    ).status_code in (403, 404)
    response = client.post(
        f"/documents/{document_id}/graph/versions/{second}/activate",
        headers=headers(),
    )
    assert response.status_code == 200, response.text
    assert [row["number"] for row in response.json()["versions"] if row["active"]] == [
        2
    ]
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert graph["version"]["number"] == 2
    with store.engine.connect() as connection:
        assert [row["id"] for row in query.visible_builds(connection)] == [second]
    # 备注。
    assert (
        client.post(
            f"/documents/{document_id}/graph/versions/{second}/note",
            headers=headers(),
            json={"note": "检查后"},
        ).status_code
        == 200
    )
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert graph["version"]["note"] == "检查后"
