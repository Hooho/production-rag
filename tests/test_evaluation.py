import json
import time

import pytest

from app.evaluation import dataset as dataset_module
from app.evaluation import results as results_module
from app.evaluation import retrieval as retrieval_module
from app.evaluation.dataset import (QUESTION_TYPES, corpus_files, load_dataset, normalize, replace_dataset,
    seed_items, select_split, validate_dataset)
from app.evaluation.generation import judge_answer, summarize_generation
from app.evaluation.results import compare_runs, execute_run, previous_run, start_run
from app.evaluation.retrieval import import_corpus, score_question, summarize_paraphrase_pairs, threshold_sweep
from app.models import Models
from app.ingestion.chunking import chunk_document_records
from app.tools.search import DocumentSearchTool
from test_app import headers as user_headers, setup  # noqa: F401  复用 API 测试的内存存储夹具


# 评测接口只允许管理员调用，本文件的请求默认用管理员身份。
def headers(owner="admin"):
    return user_headers(owner)


# 读取仓库里的全部语料原文。
def corpus_text():
    parts = []
    for path in corpus_files():
        parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


# 初始调参评测集（eval/seed/dataset.jsonl）字段完整、证据都能在语料里找到，无法回答题约占两成，并且五种题型都有。
def test_dataset_is_valid():
    items = seed_items()
    assert 30 <= len(items) <= 50
    assert validate_dataset(items, corpus_text()) == []
    unanswerable = 0
    types = set()
    for item in items:
        types.add(item["type"])
        if not item["answerable"]:
            unanswerable += 1
    assert types == set(QUESTION_TYPES)
    assert 0.15 <= unanswerable / len(items) <= 0.25
    approved = [item for item in items if item.get("reviewed") is True]
    assert any(item.get("split") == "holdout" for item in items)
    # 待审核题仍保留在题库中供人工检查，但不能计入任一实际评测范围。
    assert len(select_split(items, "dev")) + len(select_split(items, "holdout")) == len(approved)


# 按当前分块参数切分语料后，每条证据都完整落在某一个分片里。
# 如果证据正好跨在两个分片的边界上，任何检索都无法"命中"它，这类题需要改短证据或调整分块。
def test_every_evidence_fits_in_one_chunk():
    chunks = []
    for path in corpus_files():
        for record in chunk_document_records(path.read_text(encoding="utf-8")):
            chunks.append(normalize(record["embedding_text"]))
    for item in seed_items():
        for evidence in item["evidence"]:
            target = normalize(evidence)
            found = False
            for chunk in chunks:
                if target in chunk:
                    found = True
                    break
            assert found, f"{item['id']} 的证据跨分片或不存在：{evidence}"


# 规范化统一全角半角并去掉空白，OCR 或换行造成的差异不影响命中判断。
def test_normalize_ignores_width_and_whitespace():
    assert normalize("ＰＥＧ 等于 １\n的时候") == normalize("PEG等于1的时候")
    problems = validate_dataset([{"id": "x", "type": "事实", "answerable": True, "evidence": ["不存在的句子"]}], "语料")
    assert problems == ["x：证据不在语料中：不存在的句子"]


# ---------- 检索评测 ----------

# 用临时目录代替仓库的 eval 目录：两份小语料、四道题（一道无法回答），结果也写到临时目录。
@pytest.fixture
def eval_dir(setup, tmp_path, monkeypatch):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "售后.md").write_text("# 退货\n\n耳机签收后七天内可以无理由退货。\n\n# 保修\n\n耳机保修期为一年，人为损坏不在保修范围。",
        encoding="utf-8")
    (corpus / "物流.md").write_text("# 配送\n\n订单付款后四十八小时内发货，偏远地区需要五天送达。", encoding="utf-8")
    rows = [
        {"id": "a1", "question": "耳机几天内可以退货？", "type": "事实", "answerable": True,
            "evidence": ["耳机签收后七天内可以无理由退货"], "reference_answer": "七天", "split": "dev", "reviewed": True},
        {"id": "a2", "question": "耳机保修多久？", "type": "同义改写", "answerable": True,
            "evidence": ["耳机保修期为一年"], "reference_answer": "一年", "split": "dev", "reviewed": True},
        {"id": "a3", "question": "付款后多久发货？", "type": "关键词", "answerable": True,
            "evidence": ["订单付款后四十八小时内发货"], "reference_answer": "48 小时", "split": "holdout", "reviewed": True},
        {"id": "u1", "question": "明天东京天气怎么样？", "type": "无法回答", "answerable": False,
            "evidence": [], "reference_answer": "拒答", "split": "dev", "reviewed": True},
    ]
    replace_dataset(rows, setup[1].engine)
    monkeypatch.setattr(dataset_module, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(retrieval_module, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(results_module, "RESULTS_DIR", tmp_path / "results")
    return tmp_path


# 确定性的"重排模型"：问题和文档共有的字越多，概率越高；天气题和语料没有共同的关键字，概率很低。
def fake_rerank(self, query, documents):
    scores = []
    for document in documents:
        common = 0
        for character in set(query):
            if character in document and character not in "？?的":
                common += 1
        scores.append(min(0.95, common / 8))
    return scores


# 评测集接口只允许证据来自语料，AI 起草在演示模型下应明确拒绝，避免误以为生成成功。
def test_eval_dataset_manual_entry_and_generation_guard(setup, eval_dir):
    client, _ = setup
    response = client.post("/eval/dataset/items", headers=headers(), json={
        "question": "耳机的保修期是多久？", "type": "事实", "answerable": True,
        "evidence": ["耳机保修期为一年"], "reference_answer": "一年", "split": "dev",
    })
    assert response.status_code == 201
    item = response.json()
    assert item["origin"] == "manual" and item["reviewed"] is True and item["id"].startswith("q")
    invalid = client.post("/eval/dataset/items", headers=headers(), json={
        "question": "不存在的证据", "type": "事实", "answerable": True,
        "evidence": ["这段话不在语料里"], "reference_answer": "未知", "split": "dev",
    })
    assert invalid.status_code == 422
    generation = client.post("/eval/dataset/generate", headers=headers(), json={"count": 1})
    assert generation.status_code == 422 and "MODEL_MODE=openai" in generation.json()["detail"]


# 同义改写在编辑器里一次提交两个问法，但接口落盘后应是两条独立题目并共享题对编号、证据和答案。
def test_eval_dataset_paraphrase_pair(setup, eval_dir):
    client, _ = setup
    response = client.post("/eval/dataset/pairs", headers=headers(), json={
        "original_question": "耳机保修期是多久？", "paraphrase_question": "耳机坏了还能保修多长时间？",
        "answerable": True, "evidence": ["耳机保修期为一年"], "reference_answer": "一年", "split": "dev",
    })
    assert response.status_code == 201
    body = response.json()
    assert body["pair_id"] == "pair_001"
    assert [item["pair_role"] for item in body["items"]] == ["original", "paraphrase"]
    assert len({item["id"] for item in body["items"]}) == 2
    assert body["items"][0]["evidence"] == body["items"][1]["evidence"]


# 成对统计复用单题检索结果，只新增原问题和改写问题之间的变化与保持率。
def test_summarize_paraphrase_pairs():
    def row(item_id, role, final_recall):
        stages = {stage: {"recall": final_recall if stage == "final" else 1.0, "rr": 1.0, "rank": 1} for stage in ("pool", "top", "final")}
        return {"id": item_id, "pair_id": "pair_001", "pair_role": role, "question": item_id,
            "type": "同义改写", "answerable": True, "evidence_count": 1, "stages": stages,
            "returned": 1, "latency_ms": 1, "pool": [], "evidence": []}

    result = summarize_paraphrase_pairs([row("q01", "original", 1.0), row("q02", "paraphrase", 0.0)])
    assert result["pair_count"] == 1 and result["question_count"] == 2
    assert result["metrics"]["recall_final"]["delta"] == -1.0
    assert result["retention"]["final"] == 0.0


# AI 生成成功后写入的题目应保留审核标记和服务端编号，且不会绕过证据校验。
def test_eval_dataset_ai_generation(setup, eval_dir):
    client, _ = setup
    client.app.state.models.mode = "openai"
    client.app.state.models.chat_completion = lambda messages, max_tokens: json.dumps({"items": [{
        "type": "多轮追问", "answerable": True, "question": "那它保修多久？",
        "history": ["耳机有什么售后政策？"], "evidence": ["耳机保修期为一年"],
        "reference_answer": "一年",
    }]}, ensure_ascii=False)
    response = client.post("/eval/dataset/generate", headers=headers(), json={"count": 1, "type": "多轮追问"})
    assert response.status_code == 201
    item = response.json()["items"][0]
    assert item["origin"] == "ai" and item["reviewed"] is False and item["history"] == ["耳机有什么售后政策？"]
    assert item["id"] not in [candidate["id"] for candidate in select_split(load_dataset(), "dev")]
    reviewed = client.post(f"/eval/dataset/items/{item['id']}/review", headers=headers())
    assert reviewed.status_code == 200 and reviewed.json()["reviewed"] is True
    assert item["id"] in [candidate["id"] for candidate in select_split(load_dataset(), "dev")]


# AI 同义改写允许模型把单条证据返回为字符串，并自动落盘为共享题对的两条独立题目。
def test_eval_dataset_ai_paraphrase_generation(setup, eval_dir):
    client, _ = setup
    client.app.state.models.mode = "openai"
    client.app.state.models.chat_completion = lambda messages, max_tokens: json.dumps({"items": [{
        "type": "同义改写", "answerable": True, "question": "耳机保修期是多久？",
        "paraphrase_question": "耳机坏了还能保修多长时间？", "evidence": "耳机保修期为一年",
        "reference_answer": "一年",
    }]}, ensure_ascii=False)
    response = client.post("/eval/dataset/generate", headers=headers(), json={"count": 1, "type": "同义改写"})
    assert response.status_code == 201
    items = response.json()["items"]
    assert len(items) == 2
    assert {item["pair_role"] for item in items} == {"original", "paraphrase"}
    assert len({item["pair_id"] for item in items}) == 1
    assert items[0]["evidence"] == ["耳机保修期为一年"]


# 语料导入走正常的版本流程，内容不变时第二次直接跳过，不重复向量化。
def test_import_corpus_is_idempotent(setup, eval_dir):
    client, store = setup
    first = import_corpus(store, client.app.state.models)
    assert [item["status"] for item in first] == ["imported", "imported"]
    second = import_corpus(store, client.app.state.models)
    assert [item["status"] for item in second] == ["unchanged", "unchanged"]
    # 评测用户的数据与真实用户隔离：alice 的文档列表里看不到评测语料。
    assert client.get("/documents", headers=headers()).json()["documents"] == []


# 完整跑一次检索评测：三个阶段的指标、按题型分组、漏斗、阈值扫描、消融变体和结果文件都齐全。
def test_retrieval_run_end_to_end(setup, eval_dir, monkeypatch):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    run = start_run("retrieval", "dev", ["ablation", "params"])
    run = execute_run(store, client.app.state.models, dataset_module.load_dataset(), run)
    assert run["status"] == "completed"
    assert run["config"]["dataset_size"] == 3
    assert run["config"]["reranked"] is True
    summary = run["summary"]
    assert summary["answerable_count"] == 2 and summary["unanswerable_count"] == 1
    assert summary["recall_pool"] == 1.0
    assert 0 < summary["mrr_pool"] <= 1
    assert summary["false_accept_rate"] == 0.0
    assert set(run["by_type"]) == {"事实", "同义改写", "无法回答"}
    assert run["funnel"]["total"] == 2
    assert len(run["sweep"]) == 18
    names = [variant["name"] for variant in run["variants"]]
    assert names == ["dense_only", "keyword_only", "hybrid_no_rerank", "pool_12", "pool_30", "fusion_best"]
    no_rerank = run["variants"][2]["summary"]
    # 不重排就没有阈值过滤，无法回答的题一定会留下来源，漏放率是 100%。
    assert no_rerank["false_accept_rate"] == 1.0
    question = run["questions"][0]
    assert question["diagnostics"]["config"]["reranked"] is True
    assert question["evidence"][0]["rrf_rank"] >= 1
    assert run["progress"] == {"done": 21, "total": 21}
    saved = results_module.load_run(run["id"])
    assert saved["summary"] == summary


# 构造一道题的检索诊断：证据所在分片 c2 进了候选池，但重排概率低于阈值被过滤，应判定为"被阈值误杀"。
def diagnostics_with(statuses):
    candidates = []
    for chunk_id, rrf_rank, rerank_rank, probability, status, source_id in statuses:
        candidates.append({"chunk_id": chunk_id, "rrf_rank": rrf_rank, "rerank_rank": rerank_rank,
            "rerank_probability": probability, "status": status, "source_id": source_id})
    return {"diagnostics": {"config": {"return_limit": 2, "reranked": True, "min_score": 0.3},
        "candidates": candidates}, "stats": {"returned": 1, "recall_ms": 3, "rerank_ms": 7}}


def test_score_question_finds_lost_stage():
    retrieval = diagnostics_with([
        ("c1", 2, 1, 0.8, "returned", "S1"),
        ("c2", 1, 2, 0.2, "filtered_low_score", None),
        ("c3", 3, None, None, "not_in_pool", None),
    ])
    texts = {"c1": "无关内容", "c2": "耳机签收后七天内可以无理由退货", "c3": "其他"}
    item = {"id": "a1", "question": "q", "type": "事实", "answerable": True, "evidence": ["耳机签收后七天内可以无理由退货"]}
    row = score_question(item, retrieval, texts, pool_size=2)
    assert row["stages"]["pool"] == {"recall": 1.0, "rr": 1.0, "rank": 1}
    assert row["stages"]["top"] == {"recall": 1.0, "rr": 0.5, "rank": 2}
    assert row["stages"]["final"]["recall"] == 0.0
    assert row["lost_stage"] == "threshold"
    assert row["evidence"][0]["status"] == "filtered_low_score"
    # 离线扫描：阈值降到 0.2 以下时证据就能保留下来，误杀消失；阈值越高误杀越多。
    row["latency_ms"] = 10
    sweep = threshold_sweep([row], 2)
    by_threshold = {point["threshold"]: point for point in sweep}
    assert by_threshold[0.2]["recall_final"] == 1.0
    assert by_threshold[0.3]["recall_final"] == 0.0
    assert by_threshold[0.85]["false_reject_rate"] == 1.0


# 两次评测对比：召回上升算变好，误杀率上升算变差；previous_run 只找同类型、同 split 的更早一次。
def test_compare_runs_marks_direction():
    base = {"id": "20260101-000000_a", "kind": "retrieval", "status": "completed", "config": {"split": "dev"},
        "summary": {"recall_pool": 0.5, "false_reject_rate": 0.1}}
    target = {"id": "20260102-000000_b", "kind": "retrieval", "status": "completed", "config": {"split": "dev"},
        "summary": {"recall_pool": 0.8, "false_reject_rate": 0.2}}
    rows = {}
    for row in compare_runs(base, target)["metrics"]:
        rows[row["key"]] = row
    assert rows["recall_pool"]["change"] == "better"
    assert rows["false_reject_rate"]["change"] == "worse"
    other = dict(base, id="20260101-120000_c", config={"split": "holdout"})
    assert previous_run(target, [target, other, base])["id"] == base["id"]


# 界面接口：浏览评测集、发起评测、轮询进度、读取结果和对比；同时只能有一次评测在运行。
def test_eval_api(setup, eval_dir, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    assert client.get("/eval/dataset").status_code == 401
    dataset = client.get("/eval/dataset", headers=headers()).json()
    assert len(dataset["items"]) == 4 and dataset["corpus"] == ["售后", "物流"]
    started = client.post("/eval/runs", headers=headers(), json={"split": "all", "suites": []})
    assert started.status_code == 202
    run_id = started.json()["id"]
    for _ in range(100):
        run = client.get(f"/eval/runs/{run_id}", headers=headers()).json()
        if run["status"] != "running":
            break
        time.sleep(0.05)
    assert run["status"] == "completed"
    assert len(run["questions"]) == 4
    listing = client.get("/eval/runs", headers=headers()).json()
    assert listing["runs"][0]["id"] == run_id and "questions" not in listing["runs"][0]
    history_metrics = listing["runs"][0]["history_metrics"]
    assert history_metrics["answerable_questions"] == run["summary"]["answerable_count"]
    assert history_metrics["unanswerable_questions"] == run["summary"]["unanswerable_count"]
    evidence_total = 0
    for question in run["questions"]:
        if question["answerable"]:
            evidence_total += question["evidence_count"]
    assert history_metrics["evidence_total"] == evidence_total
    assert listing["suites"][0]["key"] == "ablation"
    assert client.get("/eval/runs/..%2Fsecret", headers=headers()).status_code == 404
    assert client.post("/eval/runs", headers=headers(), json={"suites": ["unknown"]}).status_code == 422
    # 测试环境没有真实大模型，生成评测应在入队前给出明确提示，不能误启动付费任务。
    generation = client.post("/eval/runs", headers=headers(), json={"kind": "generation", "split": "dev", "suites": []})
    assert generation.status_code == 422 and "MODEL_MODE=openai" in generation.json()["detail"]
    compare = client.get(f"/eval/compare?base={run_id}&target={run_id}", headers=headers()).json()
    assert compare["metrics"][0]["change"] == "same"
    deleted = client.delete(f"/eval/runs/{run_id}", headers=headers())
    assert deleted.status_code == 200 and deleted.json() == {"id": run_id, "deleted": True}
    assert client.get(f"/eval/runs/{run_id}", headers=headers()).status_code == 404
    assert client.delete(f"/eval/runs/{run_id}", headers=headers()).status_code == 404


# ---------- 生成评测 ----------

# 评审模型的输出被限制在 0 / 0.5 / 1；固定拒答文本不调用评审，按是否可回答直接判定。
def test_judge_and_generation_summary():
    class FakeJudge:
        def chat_completion(self, messages, max_tokens):
            self.prompt = messages[-1].content
            return json.dumps({"refused": False, "faithfulness": 0.8, "correctness": 1,
                "citation": 0.4, "faithfulness_reason": "大部分有依据"}, ensure_ascii=False)

        parse_json = staticmethod(Models.parse_json)

    judge = FakeJudge()
    answerable = {"id": "a1", "question": "耳机几天能退？", "answerable": True, "reference_answer": "七天"}
    result = judge_answer(judge, answerable, "七天内可以退 [S1]", [{"id": "S1", "text": "七天内可以无理由退货"}])
    assert result["faithfulness"] == 1.0 and result["citation"] == 0.5 and result["judge"] == "llm"
    assert "七天内可以无理由退货" in judge.prompt
    refusal = judge_answer(judge, {"id": "u1", "answerable": False}, "知识库中没有足够资料，请补充文档或具体问题。", [])
    assert refusal == {**refusal, "refused": True, "correctness": 1.0, "judge": "rule"}
    rows = [{"answerable": True, "judgement": result},
        {"answerable": False, "judgement": refusal},
        {"answerable": True, "judgement": {**refusal, "correctness": 0.0}}]
    summary = summarize_generation(rows)
    # 忠实度只看没拒答的回答；正确性看能回答的两题（1 和 0）；拒答正确率 2/3。
    assert summary["faithfulness"] == 1.0
    assert summary["correctness"] == 0.5
    assert summary["refusal_accuracy"] == 0.6667
    assert summary["citation_validity"] == 0.5


# 生成评测端到端：检索后用线上回答链路生成回答，再由评审打分，结果汇总进总览和题型分组。
def test_generation_run_end_to_end(setup, eval_dir, monkeypatch):
    client, store = setup
    models = client.app.state.models
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    # 该测试验证生成链路和评审调用次数，不验证生产阈值；显式使用较低阈值保证两道可回答题都进入评审。
    monkeypatch.setenv("RERANK_MIN_SCORE", "0.3")

    class FakeResponder:
        def answer(self, owner, session_id, question, sources, coverage=None):
            assert owner == "eval"
            if not sources:
                return "知识库中没有足够资料，请补充文档或具体问题。", {}
            return f"根据资料 [S1]：{sources[0]['text'][:10]}", {}

    replies = []
    monkeypatch.setattr(models, "chat_completion", lambda messages, max_tokens: replies.append(1) or json.dumps(
        {"refused": False, "faithfulness": 1, "correctness": 1, "citation": 1}))
    run = start_run("generation", "dev", [])
    run = execute_run(store, models, dataset_module.load_dataset(), run, generate=True, responder=FakeResponder())
    assert run["kind"] == "generation" and run["status"] == "completed"
    answered = run["questions"][0]
    assert answered["answer"].startswith("根据资料") and answered["cited"] == ["S1"]
    refused = run["questions"][2]
    assert refused["judgement"]["judge"] == "rule" and refused["judgement"]["correctness"] == 1.0
    # 两道能回答的题调用了评审，无法回答的题被固定拒答，不花评审费用。
    assert len(replies) == 2
    assert run["summary"]["refusal_accuracy"] == 1.0
    assert run["by_type"]["事实"]["correctness"] == 1.0


# 评测用的检索变体：仅向量不调用关键词检索；取最好名次时多个检索词不重复累加；候选池和重排开关生效。
def test_search_variants():
    class Store:
        def __init__(self):
            self.calls = []

        def search(self, owner, query, models, limit):
            self.calls.append("dense")
            return [{"id": "a", "title": "A", "text": "a", "score": 0.9},
                {"id": "b", "title": "B", "text": "b", "score": 0.8}]

        def search_keyword(self, owner, query, limit):
            self.calls.append("keyword")
            return [{"id": "b", "title": "B", "text": "b", "score": 3.0}]

    class Reranker:
        def __init__(self):
            self.called = False

        def rerank(self, query, documents):
            self.called = True
            return [0.9] * len(documents)

    store = Store()
    tool = DocumentSearchTool()
    result = tool.execute(store, Reranker(), "eval", ["q"], "q", methods=["dense"])
    assert store.calls == ["dense"]
    assert result["diagnostics"]["config"]["methods"] == ["dense"]
    summed = tool.execute(Store(), Reranker(), "eval", ["q1", "q2"], "q")
    best = tool.execute(Store(), Reranker(), "eval", ["q1", "q2"], "q", fusion="best")
    rows = {}
    for row in best["diagnostics"]["candidates"]:
        rows[row["title"]] = row
    # b 在两个检索词 × 两路召回里共命中 4 次；取最好名次后每路只算一次。
    assert rows["B"]["rrf_score"] == round(1 / 62 + 1 / 61, 6)
    assert summed["diagnostics"]["candidates"][0]["rrf_score"] > rows["B"]["rrf_score"]
    reranker = Reranker()
    limited = tool.execute(Store(), reranker, "eval", ["q"], "q", pool_size=1, rerank=False)
    assert reranker.called is False
    assert limited["stats"]["relevance_filter"] == "off"
    assert limited["diagnostics"]["config"]["rerank_candidates"] == 1
    assert "rerank_ms" in limited["stats"]



# 普通用户调用评测接口一律 403，页面上也不显示评测入口。
def test_eval_api_requires_admin(setup):
    client, _ = setup
    assert client.get("/eval/dataset", headers=user_headers("alice")).status_code == 403
    assert client.get("/eval/runs", headers=user_headers("alice")).status_code == 403
    assert client.post("/eval/runs", headers=user_headers("alice"), json={}).status_code == 403
    assert client.get("/eval/runs", headers=headers()).status_code == 200
