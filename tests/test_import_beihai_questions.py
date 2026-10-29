"""北海脚本：真实切分、API 校验、断点续导与预检查。"""

from collections import Counter
from copy import deepcopy

import pytest

from app.evaluation.grouped_evidence import fingerprint, validate_groups
from app.evaluation.retrieval import import_corpus
from app.ingestion.chunking import chunk_document_records
from app.tools.search import limit_titles
from scripts.import_beihai_questions import (
    MATERIALS,
    build_items,
    import_questions,
    load_materials,
    make_api,
)
from test_app import setup  # noqa: F401
from test_evaluation import eval_dir, headers  # noqa: F401


def catalog_for(size=400, overlap=40):
    spec, _ = load_materials()
    result = []
    for source in [
        {"title": spec["title"], "file": "corpus/北海慢游指南.md"},
        *spec.get("additional_corpora", []),
    ]:
        records = chunk_document_records(
            (MATERIALS / source["file"]).read_text(encoding="utf-8"),
            chunk_size=size,
            chunk_overlap=overlap,
        )
        result.extend(
            {
                "title": source["title"],
                "position": index,
                "fingerprint": fingerprint(record["content"]),
                "quote": record["content"],
            }
            for index, record in enumerate(records)
        )
    return result


@pytest.mark.parametrize("size,overlap", [(800, 120), (400, 40), (300, 40)])
def test_real_chunks_match_all_questions_and_pass_server_validation(size, overlap):
    spec, sections = load_materials()
    catalog = catalog_for(size, overlap)
    # 位置只是标识，不能按此前展示的固定序号挑片。
    for row in catalog:
        row["position"] += 17
    items = build_items(spec, sections, catalog)
    assert Counter(item["type"] for item in items) == {"多跳": 4, "比较": 4, "汇总": 4}
    for item in items:
        assert (
            validate_groups(item["evidence_groups"], catalog) == item["evidence_groups"]
        )
        assert all(len(group["targets"]) == 1 for group in item["evidence_groups"])
    if size == 300:
        assert (
            len(items[8]["evidence_groups"]) == 7
        )  # 一节两片时两项都必需，不能变成 OR。


def test_missing_fragment_bad_fingerprint_and_limit_fail_before_import():
    spec, sections = load_materials()
    catalog = catalog_for()
    cases = [catalog[2:], deepcopy(catalog)]
    cases[1][1]["fingerprint"] = "0" * 64
    for rows in cases:
        with pytest.raises(ValueError):
            build_items(spec, sections, rows)
    with pytest.raises(ValueError, match="超过 API 上限"):
        build_items(spec, sections, catalog_for(200, 0))


def api_for(client, calls):
    def api(method, path, body=None, *, files=None):
        calls.append((method, path))
        kwargs = (
            {
                "files": [
                    ("files", (name, content, "text/markdown"))
                    for name, content in files
                ]
            }
            if files
            else {"json": body}
        )
        response = client.request(method, path, headers=headers(), **kwargs)
        assert response.status_code < 400, response.text
        return response.json()

    return api


def upload_guide(client, store, supplements=True):
    # 隔离本机 .env 中的模型地址；这里只验证入库和 HTTP API，不调用模型服务。
    client.app.state.models.embedding_mode = "demo"
    client.app.state.models.contextual = False
    spec, _ = load_materials()
    sources = [{"title": spec["title"], "file": "corpus/北海慢游指南.md"}]
    if supplements:
        sources += spec.get("additional_corpora", [])
    response = client.post(
        "/eval/corpus",
        headers=headers(),
        files=[
            (
                "files",
                (
                    source["title"] + ".md",
                    (MATERIALS / source["file"]).read_bytes(),
                    "text/markdown",
                ),
            )
            for source in sources
        ],
    )
    assert response.status_code == 201, response.text
    assert len(response.json()["added"]) == len(sources)
    with limit_titles("eval", [source["title"] for source in sources]):
        import_corpus(store, client.app.state.models)


def test_actual_api_dry_run_partial_failure_resume_and_repeat(setup, eval_dir):
    client, store = setup
    upload_guide(client, store)
    spec, sections = load_materials()
    calls = []
    api = api_for(client, calls)
    name = spec["suite_name"]
    import_questions(api, spec, sections, name, dry_run=True)
    assert all(method == "GET" for method, _ in calls)
    assert not any(row["name"] == name for row in api("GET", "/eval/suites")["items"])

    writes = 0

    def interrupted_api(method, path, body=None):
        nonlocal writes
        if method == "POST" and path.endswith("/items"):
            if writes == 5:
                raise ValueError("模拟网络中断")
            writes += 1
        return api(method, path, body)

    with pytest.raises(ValueError, match="模拟网络中断"):
        import_questions(interrupted_api, spec, sections, name)
    calls.clear()
    import_questions(api, spec, sections, name)
    assert (
        sum(method == "POST" and path.endswith("/items") for method, path in calls) == 7
    )
    suite = next(
        row for row in api("GET", "/eval/suites")["items"] if row["name"] == name
    )
    assert suite["item_count"] == 12
    calls.clear()
    import_questions(api, spec, sections, name)
    assert all(method == "GET" for method, _ in calls)


def test_conflicting_existing_question_aborts_before_adding_missing(setup, eval_dir):
    client, store = setup
    upload_guide(client, store)
    spec, sections = load_materials()
    calls = []
    api = api_for(client, calls)
    suite = api(
        "POST",
        "/eval/suites",
        {
            "name": spec["suite_name"],
            "method": "retrieval",
            "search_mode": "hybrid",
        },
    )
    item = build_items(spec, sections, api("GET", "/eval/target-chunks")["items"])[-1]
    item["reference_answer"] = "已有的人工修改，不能覆盖"
    api("POST", f"/eval/suites/{suite['id']}/items", item)
    calls.clear()
    with pytest.raises(ValueError, match="冲突"):
        import_questions(api, spec, sections, spec["suite_name"])
    assert all(method == "GET" for method, _ in calls)
    saved = api("GET", f"/eval/suites/{suite['id']}")
    assert len(saved["items"]) == 1
    assert saved["items"][0]["reference_answer"] == "已有的人工修改，不能覆盖"


@pytest.mark.parametrize(
    "change", [{"status": "not_imported"}, {"status": "stale"}, {"sha256": "0" * 64}]
)
def test_not_ready_or_different_corpus_makes_no_write(change):
    spec, sections = load_materials()
    calls = []

    def api(method, path, body=None):
        calls.append((method, path))
        return {
            "items": [
                {
                    "title": spec["title"],
                    "status": "imported",
                    "sha256": spec["corpus_sha256"],
                    **change,
                }
            ]
        }

    with pytest.raises(ValueError):
        import_questions(api, spec, sections, spec["suite_name"])
    assert calls == [("GET", "/eval/corpus")]


def test_api_client_handles_prefix_auth_json_and_rejects_redirects(monkeypatch):
    from io import BytesIO
    from urllib.error import HTTPError

    seen = []

    class Opener:
        def open(self, request, timeout):
            seen.append(request)
            if request.full_url.endswith("/redirect"):
                raise HTTPError(request.full_url, 302, "redirect", {}, BytesIO(b""))
            return BytesIO(b'{"ok": true}')

    monkeypatch.setattr(
        "scripts.import_beihai_questions.build_opener", lambda handler: Opener()
    )
    api = make_api("http://127.0.0.1:8000/api/", "test-token")
    assert api("POST", "/eval/suites", {"name": "北海"}) == {"ok": True}
    assert seen[0].full_url == "http://127.0.0.1:8000/api/eval/suites"
    assert seen[0].get_header("Authorization") == "Bearer test-token"
    assert "北海" in seen[0].data.decode()
    api("POST", "/eval/corpus", files=[("北海补记.md", "正文".encode())])
    assert (
        seen[-1].get_header("Content-type").startswith("multipart/form-data; boundary=")
    )
    assert b'name="files"' in seen[-1].data and "正文" in seen[-1].data.decode()
    with pytest.raises(ValueError, match="302"):
        api("GET", "/redirect")
    with pytest.raises(ValueError, match="API 地址"):
        make_api("http://admin:secret@localhost:8000")


def test_local_defaults_reads_only_port_and_password_without_executing(
    tmp_path, monkeypatch
):
    from scripts import import_beihai_questions as script

    monkeypatch.setattr(script, "MATERIALS", tmp_path / "eval/benchmarks/beihai")
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("API_PORT", "8123")
    (tmp_path / ".env").write_text(
        "export ADMIN_PASSWORD='a password # with spaces'\nAPI_PORT=8111\n"
        "UNUSED=$(touch should-not-exist)\n",
        encoding="utf-8",
    )
    assert script.local_defaults() == {
        "ADMIN_PASSWORD": "a password # with spaces",
        "API_PORT": "8123",
    }
    assert not (tmp_path / "should-not-exist").exists()


@pytest.mark.parametrize("remote", [False, True])
def test_one_command_uses_local_config_and_does_not_send_it_to_remote(
    monkeypatch, remote
):
    from scripts import import_beihai_questions as script

    monkeypatch.delenv("BEIHAI_API_TOKEN", raising=False)
    monkeypatch.setattr(
        script,
        "local_defaults",
        lambda: {"ADMIN_PASSWORD": "configured", "API_PORT": "8123"},
    )
    monkeypatch.setattr(script.getpass, "getpass", lambda prompt: "typed")
    argv = ["import_beihai_questions.py"]
    if remote:
        argv += ["--base-url", "https://example.invalid/api"]
    monkeypatch.setattr(script.sys, "argv", argv)
    calls = []

    def factory(base_url, token=""):
        calls.append((base_url, token))

        def login(method, path, body):
            assert body == {
                "username": "admin",
                "password": "typed" if remote else "configured",
            }
            return {"access_token": "test-token"}

        return login

    monkeypatch.setattr(script, "make_api", factory)
    imported = []
    monkeypatch.setattr(script, "import_questions", lambda *args: imported.append(args))
    assert script.main() == 0
    expected = "https://example.invalid/api" if remote else "http://127.0.0.1:8123"
    assert calls == [(expected, ""), (expected, "test-token")]
    assert len(imported) == 1


def test_updates_only_four_previous_comparisons_and_preserves_other_items(
    setup, eval_dir
):
    client, store = setup
    upload_guide(client, store)
    spec, sections = load_materials()
    calls = []
    api = api_for(client, calls)
    suite = api(
        "POST",
        "/eval/suites",
        {"name": spec["suite_name"], "method": "retrieval", "search_mode": "hybrid"},
    )
    for definition, item in zip(
        spec["items"],
        build_items(spec, sections, api("GET", "/eval/target-chunks")["items"]),
    ):
        if definition.get("previous_question"):
            item["question"] = definition["previous_question"]
            item["reference_answer"] = "旧版比较答案"
        api("POST", f"/eval/suites/{suite['id']}/items", item)
    before = api("GET", f"/eval/suites/{suite['id']}")["items"]
    calls.clear()
    import_questions(api, spec, sections, spec["suite_name"], dry_run=True)
    assert all(method == "GET" for method, _ in calls)
    calls.clear()
    import_questions(api, spec, sections, spec["suite_name"])
    assert sum(method == "PUT" for method, _ in calls) == 4
    assert not any(method in {"POST", "DELETE"} for method, _ in calls)
    after = api("GET", f"/eval/suites/{suite['id']}")["items"]
    assert [row["id"] for row in before] == [row["id"] for row in after]
    assert [row for row in before if row["type"] != "比较"] == [
        row for row in after if row["type"] != "比较"
    ]
    calls.clear()
    import_questions(api, spec, sections, spec["suite_name"])
    assert all(method == "GET" for method, _ in calls)


def test_one_command_uploads_and_imports_missing_supplement(
    setup, eval_dir, monkeypatch
):
    # 测试库共享一条 SQLite 连接，后台写入与轮询会互相影响事务；同步执行同一个导入任务。
    class InlineThread:
        def __init__(self, target, daemon):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr("app.api.main.Thread", InlineThread)
    client, store = setup
    upload_guide(client, store, supplements=False)
    spec, sections = load_materials()
    calls = []
    api = api_for(client, calls)
    import_questions(api, spec, sections, spec["suite_name"], dry_run=True)
    assert all(method == "GET" for method, _ in calls)
    calls.clear()
    # 仍调用真实上传和导入 API，模型被隔离为 demo，不访问外部服务。
    import_questions(api, spec, sections, spec["suite_name"])
    assert ("POST", "/eval/corpus") in calls
    assert any(method == "POST" and path.endswith("/import") for method, path in calls)
    saved = api("GET", "/eval/corpus")["items"]
    assert (
        next(row for row in saved if row["title"] == "北海出游条件补记")["status"]
        == "imported"
    )


@pytest.mark.parametrize(
    "mode,qualified",
    [
        ("filtered", True),
        ("all_kept", False),
        ("not_recalled", False),
        ("sub_filtered", False),
    ],
)
def test_verification_requires_recall_and_distinct_rerank_loss(mode, qualified):
    from scripts.verify_beihai_comparisons import verify

    documents = [
        {"section": f"B{i:03}", "title": "补记", "text": f"d{i}"} for i in range(20)
    ]
    item = {
        "id": "C01",
        "question": "full",
        "scoring_items": [
            {"label": "a", "section": "B000", "title": "补记", "query": "q0"},
            {"label": "b", "section": "B001", "title": "补记", "query": "q1"},
        ],
    }

    def rank(query):
        return list(range(1, 20)) + [0] if mode == "not_recalled" else list(range(20))

    def score(query, text):
        return (
            0.1
            if text == "d0"
            and (query == "full" and mode != "all_kept" or mode == "sub_filtered")
            else 0.99
        )

    result = verify(rank, score, [item], documents, 0.85, 12)
    assert result[0]["qualified"] is qualified
