from sqlalchemy import select

from app.graph import vectors as graph_vectors
from app.milvus.graph_store import GraphVectorStore
from app.mysql.tables import graph_versions
from graph_fakes import FakeGraphClient
from test_app import headers, setup  # noqa: F401
from test_graph_build import add_document, build, enable_model, run_graph_jobs


def use_fake_vectors(store, models):
    client = FakeGraphClient()
    store.graph_vectors = GraphVectorStore(client, models.collection, models.dimension)
    return client


def active_version(store, document_id):
    with store.engine.connect() as connection:
        return dict(
            connection.execute(
                select(graph_versions).where(
                    graph_versions.c.document_id == document_id,
                    graph_versions.c.active.is_(True),
                )
            ).mappings().first()
        )


# 写入图谱版本后自动算名字、关系向量：同一实体的同一个名字一行，每条关系一行，都带版本 id 和文档版本 id。
def test_write_indexes_names_and_relations(setup):
    client, store = setup
    models = enable_model(client)
    fake = use_fake_vectors(store, models)
    document_id = add_document(client)
    assert build(client, document_id).status_code == 202
    run_graph_jobs(store, models)
    version = active_version(store, document_id)
    names = fake.rows(store.graph_vectors.names)
    relations = fake.rows(store.graph_vectors.relations)
    assert sorted(row["name"] for row in names) == ["步步高", "段永平", "苹果公司", "阿段"]
    assert len(relations) == 2
    assert {row["version_id"] for row in names + relations} == {version["id"]}
    assert {row["document_id"] for row in names + relations} == {document_id}
    # 「段永平」和「阿段」是同一个实体的两个名字，各算一行。
    by_name = {row["name"]: row for row in names}
    assert by_name["段永平"]["entity_id"] == by_name["阿段"]["entity_id"]
    mark = version["summary"]["vectors"]
    assert mark["status"] == "done" and mark["names"] == 4 and mark["relations"] == 2
    assert mark["collection"] == models.collection


# 名字和关系的文字：名字带类型和描述，关系用原名写起点、终点。
def test_vector_texts(setup):
    client, store = setup
    models = enable_model(client)
    use_fake_vectors(store, models)
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    version = active_version(store, document_id)
    with store.engine.connect() as connection:
        names = {row["name"]: row["text"] for row in graph_vectors.name_rows(connection, version["id"])}
        relations = sorted(row["text"] for row in graph_vectors.relation_rows(connection, version["id"]))
    assert names["阿段"] == "阿段（人物）：投资人"
    assert relations == ["段永平 → 步步高（创办）：段永平创办步步高", "阿段 → 苹果公司（投资）：2011 年买入苹果"]


# 算向量失败不影响建图：版本照常写入、生效，标记为失败，补算时会再算。
def test_index_failure_does_not_break_build(setup):
    client, store = setup
    models = enable_model(client)
    fake = use_fake_vectors(store, models)

    def broken(*args, **kwargs):
        raise ConnectionError("milvus down")

    fake.upsert = broken
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    version = active_version(store, document_id)
    assert version["summary"]["vectors"]["status"] == "failed"
    graph = client.get(f"/documents/{document_id}/graph", headers=headers()).json()
    assert graph["build"]["status"] == "completed"


# 补算向量：只排缺向量的生效版本，worker 算完后状态变成全部已算。
def test_backfill(setup):
    client, store = setup
    models = enable_model(client)
    fake = use_fake_vectors(store, models)
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    version = active_version(store, document_id)
    # 模拟旧图谱：没有向量、没有标记。
    store.graph_vectors.delete_versions([version["id"]])
    summary = dict(version["summary"])
    summary.pop("vectors")
    with store.engine.begin() as connection:
        connection.execute(
            graph_versions.update().where(graph_versions.c.id == version["id"]).values(summary=summary)
        )
    assert fake.rows(store.graph_vectors.names) == []
    status = client.get("/graph/vectors", headers=headers("admin")).json()
    assert status == {"active": 1, "indexed": 0, "missing": 1, "failed": 0}
    assert client.get("/graph/vectors", headers=headers()).status_code == 403
    response = client.post("/graph/vectors/backfill", headers=headers("admin"))
    assert response.status_code == 202 and response.json()["queued"] == 1
    assert run_graph_jobs(store, models) == 1
    assert len(fake.rows(store.graph_vectors.names)) == 4
    assert client.get("/graph/vectors", headers=headers("admin")).json()["missing"] == 0
    # 已经算好的不再排队。
    assert client.post("/graph/vectors/backfill", headers=headers("admin")).json()["queued"] == 0


# 文档出了新版本、旧版本被清理时，旧文档版本的图向量一起删掉。
def test_remove_document_vectors(setup):
    client, store = setup
    models = enable_model(client)
    fake = use_fake_vectors(store, models)
    document_id = add_document(client)
    build(client, document_id)
    run_graph_jobs(store, models)
    assert fake.rows(store.graph_vectors.names)
    store.remove_version_data(document_id)
    assert fake.rows(store.graph_vectors.names) == [] and fake.rows(store.graph_vectors.relations) == []
