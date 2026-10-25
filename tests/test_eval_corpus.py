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
        return sorted(connection.execute(select(document_heads.c.title).where(
            document_heads.c.owner == EVAL_OWNER)).scalars().all())


def upload(client, *files):
    return client.post("/eval/corpus", headers=headers(), files=[("files", item) for item in files])


# 语料库：第一次用到时登记仓库里的初始语料；上传只收 UTF-8 的 .md / .txt，同名、内容相同的不收；
# 能看正文、导入情况；删除时评测账号里导入过的文档一起删掉，上传的文件也删掉。
def test_corpus_library_upload_list_delete(setup, eval_dir, upload_dir):
    client, store = setup
    assert client.get("/eval/corpus").status_code == 401
    listed = client.get("/eval/corpus", headers=headers()).json()["items"]
    # 初始语料复制进上传目录，和上传的一样。
    assert [(item["title"], item["created_by"], item["status"]) for item in listed] == [
        ("售后", "system", "not_imported"), ("物流", "system", "not_imported")]
    logistics = (eval_dir / "seed" / "corpus" / "物流.md").read_text(encoding="utf-8")
    seeded = Path(corpus_module.get_entry(store.engine, listed[1]["id"])["path"])
    assert seeded.parent == upload_dir / "eval_corpus" and seeded.read_text(encoding="utf-8") == logistics
    result = upload(client, ("会员.md", "# 会员\n\n会员积分一年内有效。".encode(), "text/markdown"),
        ("手册.pdf", b"%PDF", "application/pdf"), ("售后.txt", "重名".encode(), "text/plain"),
        ("旧编码.txt", "中文".encode("gbk"), "text/plain"), ("副本.md", logistics.encode(), "text/markdown"),
        ("空.txt", b"  \n", "text/plain"))
    assert result.status_code == 201
    body = result.json()
    assert [item["title"] for item in body["added"]] == ["会员"]
    reasons = [item["reason"] for item in body["rejected"]]
    assert "只支持 .md、.txt" in reasons[0] and "同名" in reasons[1] and "UTF-8" in reasons[2]
    assert "完全相同" in reasons[3] and "空的" in reasons[4]
    member = body["added"][0]
    assert client.get(f"/eval/corpus/{member['id']}", headers=headers()).json()["content"] == "# 会员\n\n会员积分一年内有效。"
    stored = Path(corpus_module.get_entry(store.engine, member["id"])["path"])
    assert stored.parent == upload_dir / "eval_corpus" and stored.is_file()
    # 评测语料浏览和证据校验也用语料库。
    assert client.get("/eval/dataset", headers=headers()).json()["corpus"] == ["会员", "售后", "物流"]
    assert "会员积分一年内有效" in dataset_module.corpus_text()
    import_corpus(store, client.app.state.models)
    statuses = {item["title"]: (item["status"], item["chunks"]) for item in
        client.get("/eval/corpus", headers=headers()).json()["items"]}
    assert statuses["会员"] == ("imported", 1) and statuses["售后"][0] == "imported"
    deleted = client.delete(f"/eval/corpus/{member['id']}", headers=headers())
    assert deleted.status_code == 200 and not stored.exists()
    assert eval_titles(store) == ["售后", "物流"]
    assert client.delete(f"/eval/corpus/{member['id']}", headers=headers()).status_code == 404
    # 初始语料删掉后不会再自动登记回来：上传目录里的副本删掉，仓库里的初始文件不动。
    repo_entry = next(item for item in client.get("/eval/corpus", headers=headers()).json()["items"] if item["title"] == "物流")
    client.delete(f"/eval/corpus/{repo_entry['id']}", headers=headers())
    assert [item["title"] for item in client.get("/eval/corpus", headers=headers()).json()["items"]] == ["售后"]
    assert not seeded.exists() and (eval_dir / "seed" / "corpus" / "物流.md").is_file() and eval_titles(store) == ["售后"]


# 勾选了几份语料：只导入这几份，评测账号也只检索这几份（别的账号不受影响）；离开后恢复。
def test_limit_titles_restricts_import_and_search(setup, eval_dir):
    client, store = setup
    models = client.app.state.models
    import_corpus(store, models)
    with limit_titles(EVAL_OWNER, ["售后"]):
        assert title_limit(EVAL_OWNER) == {"售后"} and title_limit("alice") is None
        assert [item["title"] for item in import_corpus(store, models)] == ["售后"]
        retrieval = DocumentSearchTool().execute(store, models, EVAL_OWNER, ["订单付款后多久发货"], "订单付款后多久发货")
        assert retrieval["sources"] and {source["title"] for source in retrieval["sources"]} == {"售后"}
        assert [item["title"] for item in retrieval["diagnostics"]["scope"]["documents"]] == ["售后"]
    assert title_limit(EVAL_OWNER) is None
    retrieval = DocumentSearchTool().execute(store, models, EVAL_OWNER, ["订单付款后多久发货"], "订单付款后多久发货")
    assert "物流" in {source["title"] for source in retrieval["sources"]}


# 发起评测时勾选语料：记进评测配置；不存在的编号报错；两次评测语料不同，对比时列出来。
def test_eval_run_records_picked_corpus(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    import_corpus(store, client.app.state.models)
    entries = {item["title"]: item for item in client.get("/eval/corpus", headers=headers()).json()["items"]}
    bad = client.post("/eval/runs", headers=headers(), json={"split": "all", "corpus_ids": ["nope"]})
    assert bad.status_code == 422
    started = client.post("/eval/runs", headers=headers(), json={"split": "all", "corpus_ids": [entries["售后"]["id"]]})
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
    base = {"id": "20260101-000000_a", "kind": "retrieval", "status": "completed", "summary": {},
        "config": {"split": "dev", "corpus": [{"title": "售后", "sha256": "a"}, {"title": "物流", "sha256": "b"}]}}
    target = {"id": "20260102-000000_b", "kind": "retrieval", "status": "completed", "summary": {},
        "config": {"split": "dev", "corpus": [{"title": "售后", "sha256": "c"}]}}
    diff = {item["key"]: item for item in compare_runs(base, target)["settings_diff"]}
    assert diff["评测语料"]["base"] == "《售后》（内容不同）、《物流》" and diff["评测语料"]["target"] == "《售后》（内容不同）"
    same = {**target, "config": {**target["config"], "corpus": [{"title": "售后", "sha256": "c"}]}}
    assert "评测语料" not in {item["key"] for item in compare_runs(target, same)["settings_diff"]}


# 没导入时看不到分片；点「导入」在后台导入（和评测共用一把锁），导入后能分页看分片，格式和知识库文档的分块一样。
def test_corpus_import_and_chunks(setup, eval_dir):
    client, store = setup
    entries = {item["title"]: item for item in client.get("/eval/corpus", headers=headers()).json()["items"]}
    after_sales = entries["售后"]
    assert client.get(f"/eval/corpus/{after_sales['id']}/chunks", headers=headers()).status_code == 404
    started = client.post(f"/eval/corpus/{after_sales['id']}/import", headers=headers())
    assert started.status_code == 202
    for _ in range(100):
        item = next(entry for entry in client.get("/eval/corpus", headers=headers()).json()["items"] if entry["title"] == "售后")
        if item["status"] != "importing":
            break
        time.sleep(0.05)
    assert item["status"] == "imported" and item["chunks"] >= 1 and item["import_error"] is None
    # 只导入了点的那一份。
    assert eval_titles(store) == ["售后"]
    page = client.get(f"/eval/corpus/{after_sales['id']}/chunks", headers=headers()).json()
    assert page["total"] == item["chunks"] and page["stale"] is False
    assert "耳机签收后七天内可以无理由退货" in page["chunks"][0]["content"]
    assert client.post("/eval/corpus/nope/import", headers=headers()).status_code == 404
