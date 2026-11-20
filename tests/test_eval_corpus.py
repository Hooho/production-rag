from pathlib import Path
import time

from sqlalchemy import select

from app.evaluation import corpus as corpus_module
from app.evaluation import dataset as dataset_module
from app.evaluation.results import compare_runs
from app.evaluation.retrieval import EVAL_OWNER, import_corpus
from app.models import Models
from app.mysql.store import document_heads
from app.tools.search import DocumentSearchTool, limit_titles, title_limit
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401  复用评测的临时语料夹具
from test_app import setup  # noqa: F401


def eval_titles(store):
    with store.engine.connect() as connection:
        return sorted(
            connection.execute(
                select(document_heads.c.title).where(
                    document_heads.c.owner == EVAL_OWNER
                )
            )
            .scalars()
            .all()
        )


def upload(client, *files):
    return client.post(
        "/eval/corpus", headers=headers(), files=[("files", item) for item in files]
    )


def test_limit_titles_restricts_import_and_search(setup, eval_dir):
    client, store = setup
    models = client.app.state.models
    import_corpus(store, models)
    with limit_titles(EVAL_OWNER, ["售后"]):
        assert title_limit(EVAL_OWNER) == {"售后"} and title_limit("alice") is None
        assert [item["title"] for item in import_corpus(store, models)] == ["售后"]
        retrieval = DocumentSearchTool().execute(
            store, models, EVAL_OWNER, ["订单付款后多久发货"], "订单付款后多久发货"
        )
        assert retrieval["sources"] and {
            source["title"] for source in retrieval["sources"]
        } == {"售后"}
        assert [
            item["title"] for item in retrieval["diagnostics"]["scope"]["documents"]
        ] == ["售后"]
    assert title_limit(EVAL_OWNER) is None
    retrieval = DocumentSearchTool().execute(
        store, models, EVAL_OWNER, ["订单付款后多久发货"], "订单付款后多久发货"
    )
    assert "物流" in {source["title"] for source in retrieval["sources"]}


# 发起评测时勾选语料：记进评测配置；不存在的编号报错；两次评测语料不同，对比时列出来。
def test_eval_run_records_picked_corpus(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    import_corpus(store, client.app.state.models)
    entries = {
        item["title"]: item
        for item in client.get("/eval/corpus", headers=headers()).json()["items"]
    }
    bad = client.post(
        "/eval/runs", headers=headers(), json={"split": "all", "corpus_ids": ["nope"]}
    )
    assert bad.status_code == 422
    started = client.post(
        "/eval/runs",
        headers=headers(),
        json={"split": "all", "corpus_ids": [entries["售后"]["id"]]},
    )
    assert started.status_code == 202
    run_id = started.json()["id"]
    for _ in range(100):
        run = client.get(f"/eval/runs/{run_id}", headers=headers()).json()
        if run["status"] != "running":
            break
        time.sleep(0.05)
    assert run["status"] == "completed", run.get("error")
    assert [item["title"] for item in run["config"]["corpus"]] == ["售后"]
    # 只检索了售后：物流那道题（付款后多久发货）拿不到证据。
    logistics = next(row for row in run["questions"] if row["id"] == "a3")
    assert logistics["given_recall"] == 0
    base = {
        "id": "20260101-000000_a",
        "kind": "retrieval",
        "status": "completed",
        "summary": {},
        "config": {
            "split": "dev",
            "corpus": [
                {"title": "售后", "sha256": "a"},
                {"title": "物流", "sha256": "b"},
            ],
        },
    }
    target = {
        "id": "20260102-000000_b",
        "kind": "retrieval",
        "status": "completed",
        "summary": {},
        "config": {"split": "dev", "corpus": [{"title": "售后", "sha256": "c"}]},
    }
    diff = {item["key"]: item for item in compare_runs(base, target)["settings_diff"]}
    assert (
        diff["评测语料"]["base"] == "《售后》（内容不同）、《物流》"
        and diff["评测语料"]["target"] == "《售后》（内容不同）"
    )
    same = {
        **target,
        "config": {**target["config"], "corpus": [{"title": "售后", "sha256": "c"}]},
    }
    assert "评测语料" not in {
        item["key"] for item in compare_runs(target, same)["settings_diff"]
    }


# 没导入时看不到分片；点「导入」在后台导入（和评测共用一把锁），导入后能分页看分片，格式和知识库文档的分块一样。


from sqlalchemy import select
from app.evaluation import document_refs
from app.mysql.store import documents, document_heads
from app.retrieval_policy import use_methods
from test_app import headers as user_headers


# 引用接口测试按身份显式传递。
def headers(owner="admin"):
    return user_headers(owner)


def test_reference_selection_isolated_and_removal_preserves_documents(setup):
    client, store = setup
    with store.engine.begin() as connection:
        for key in ("a", "b", "c"):
            connection.execute(
                documents.insert().values(
                    id=key,
                    owner="alice",
                    title=key,
                    filename=key,
                    path="",
                    status="ready:0",
                    created="t",
                    updated="t",
                    doc_key=key,
                    version=1,
                )
            )
            connection.execute(
                document_heads.insert().values(
                    doc_key=key,
                    owner="alice",
                    title=key,
                    current_document_id=key,
                    current_version=1,
                    listed=True,
                    updated="t",
                )
            )
    assert (
        client.get("/eval/document-candidates", headers=headers("alice")).status_code
        == 403
    )
    response = client.put(
        "/eval/document-references",
        headers=headers("admin"),
        json={"document_ids": ["a", "b"]},
    )
    assert response.status_code == 200, response.text
    scope = document_refs.scope(store.engine)
    assert set(scope["versions"]) == {"a", "b"}
    document_refs.save(store.engine, ["c"])
    with use_methods(["graph"], scope, []):
        assert set(document_refs.scope(store.engine)["versions"]) == {"a", "b"}
    result = client.delete("/eval/corpus/c", headers=headers("admin"))
    assert result.status_code == 200
    assert document_refs.saved(store.engine) == []
    with store.engine.connect() as connection:
        assert len(connection.execute(select(documents.c.id)).all()) == 3
    assert (
        client.post(
            "/eval/corpus", headers=headers("admin"), files={"files": ("x.txt", b"x")}
        ).status_code
        == 410
    )


def test_reference_scoring_reads_original_chunks_and_frozen_versions(setup):
    from app.mysql.store import chunks, document_chunks
    from app.evaluation.retrieval import current_chunk_texts, import_corpus
    from app.evaluation.evidence import stored_chunk_rows

    client, store = setup
    with store.engine.begin() as connection:
        for key in ("a", "b", "c"):
            connection.execute(
                documents.insert().values(
                    id=key,
                    owner="alice",
                    title=key,
                    filename=key,
                    path="",
                    status="ready:1",
                    created="t",
                    updated="t",
                    doc_key=key,
                    version=1,
                )
            )
            connection.execute(
                document_heads.insert().values(
                    doc_key=key,
                    owner="alice",
                    title=key,
                    current_document_id=key,
                    current_version=1,
                    listed=True,
                    updated="t",
                )
            )
            connection.execute(
                chunks.insert().values(
                    id=key + ":0",
                    owner="alice",
                    title=key,
                    text="证据 " + key,
                    content="证据 " + key,
                )
            )
            connection.execute(
                document_chunks.insert().values(
                    document_id=key, chunk_id=key + ":0", position=0
                )
            )
    document_refs.save(store.engine, ["a", "b"])
    frozen = document_refs.scope(store.engine)
    with use_methods(["keyword"], frozen, []):
        document_refs.save(store.engine, ["c"])
        assert set(current_chunk_texts(store)) == {"a:0", "b:0"}
        assert {row["chunk_id"] for row in stored_chunk_rows(store.engine)} == {
            "a:0",
            "b:0",
        }
        assert {row["document_id"] for row in import_corpus(store, None)} == {"a", "b"}
    assert set(current_chunk_texts(store)) == {"c:0"}


def test_referenced_corpus_batch_freezes_original_documents(
    setup, monkeypatch, runtime
):
    from app.evaluation.dataset import replace_dataset
    from app.models import Models
    from test_evaluation import fake_rerank
    from test_eval_batch import wait_batch

    client, store = setup
    runtime(contextual_retrieval=False, local_intent_enabled=False)
    monkeypatch.setattr(client.app.state.models, "embedding_mode", "demo")
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    store.mysql.create_document(
        "original-a", "alice", "原文", "a.txt", "", {}, doc_key="original-a", version=1
    )
    count = store.ingest(
        "alice",
        "原文",
        "耳机保修期为一年。",
        client.app.state.models,
        "original-a",
        "original-a",
    )
    store.activate_version("original-a", count)
    document_refs.save(store.engine, ["original-a"])
    replace_dataset(
        [
            {
                "id": "q",
                "type": "事实",
                "question": "耳机保修多久？",
                "answerable": True,
                "reviewed": True,
                "split": "dev",
                "evidence": ["耳机保修期为一年"],
                "reference_answer": "一年",
            }
        ],
        store.engine,
    )
    body = {
        "configs": [
            {
                "version": 2,
                "split": "dev",
                "mode": "fixed",
                "methods": ["keyword"],
                "corpus_ids": ["original-a"],
            }
        ]
    }
    response = client.post("/eval/batches", headers=headers("admin"), json=body)
    assert response.status_code == 202, response.text
    report = wait_batch(client, response.json()["id"])
    assert report["arms"][0]["status"] == "completed", report
    run = report["runs"][0]
    assert set(run["frozen"]["data_scope"]["versions"]) == {"original-a"}
    assert run["questions"][0]["stages"]["pool"]["recall"] == 1
    body["configs"][0]["methods"] = ["graph"]
    response = client.post("/eval/batches", headers=headers("admin"), json=body)
    assert response.status_code == 422
    assert "没有生效图谱" in response.text
    with store.engine.connect() as connection:
        assert not connection.execute(
            select(documents.c.id).where(documents.c.owner == "eval")
        ).first()


def test_two_document_graph_scope_pins_versions(setup):
    from app.mysql.store import graph_versions
    from app.graph.retrieve import scope_versions

    _, store = setup
    with store.engine.begin() as connection:
        for key in ("a", "b", "c"):
            connection.execute(
                documents.insert().values(
                    id=key,
                    owner="alice",
                    title=key,
                    filename=key,
                    path="",
                    status="ready:0",
                    created="t",
                    updated="t",
                    doc_key=key,
                    version=1,
                )
            )
            connection.execute(
                document_heads.insert().values(
                    doc_key=key,
                    owner="alice",
                    title=key,
                    current_document_id=key,
                    current_version=1,
                    listed=True,
                    updated="t",
                )
            )
            connection.execute(
                graph_versions.insert().values(
                    id="graph-" + key,
                    build_id=key,
                    space="online",
                    document_id=key,
                    doc_key=key,
                    number=1,
                    active=True,
                    origin="build",
                    created_by="alice",
                    created="t",
                )
            )
    document_refs.save(store.engine, ["a", "b"])
    frozen = document_refs.scope(store.engine)
    ids = [row["version_id"] for row in scope_versions(store.engine, frozen)]
    assert set(ids) == {"graph-a", "graph-b"}
    with store.engine.begin() as connection:
        connection.execute(graph_versions.update().values(active=False))
    with use_methods(["graph"], frozen, ids):
        assert {
            row["version_id"] for row in scope_versions(store.engine, frozen)
        } == set(ids)
