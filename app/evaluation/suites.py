# 专项评测集：管理员自建，每个专项针对一个方向（例如分片超长被截断、多轮对话记忆）检查有没有问题。
# 和调参评测集（开发集 / 留出集）分开：调参题用来比较参数，看整体分数；专项题专门挑某类难题，分数低是正常的，
# 不能混进调参分数，否则分不清分数变化是参数带来的还是专项题带来的。
# 每个专项选一种评测方式：
#   retrieval 检索：只检索，证据全部被返回算通过；逐题记下向量检索、关键词检索各排第几，看是谁找到的；
#   answer 回答：检索后完整回答，评审模型判定「要点一致」算通过；
#   dialogue 多轮对话：按顺序问完一段对话，最后一问评审「要点一致」算通过；可选对比几组记忆参数。
# 和调参评测共用评测语料、评测记录（eval/results）和同时只能跑一个评测的限制。
from uuid import uuid4

from sqlalchemy import func, select

from ..mysql.store import eval_suite_items, eval_suites
from ..runtime_config import snapshot as runtime_snapshot
from .dataset import corpus_text, normalize, now_text
from .generation import judge_answer
from .results import answer_hook, list_runs
from ..models import Models
from ..tools.search import DocumentSearchTool
from .retrieval import EVAL_OWNER, current_chunk_texts, import_corpus, score_question


METHODS = {"retrieval": "检索", "answer": "回答", "dialogue": "多轮对话"}
# 检索、回答方式用哪几路检索。默认和线上一样向量 + 关键词混合；只用一路时能单独看出这一路的表现，
# 例如截断专项选「只用向量」，分片后半段被截掉的影响就不会被关键词检索兜回来、看不出来。
SEARCH_MODES = {"hybrid": "混合检索", "dense": "只用向量", "keyword": "只用关键词"}
SEARCH_METHODS = {"hybrid": ("dense", "keyword"), "dense": ("dense",), "keyword": ("keyword",)}
# 需要真实大模型的评测方式：回答要生成和评审，多轮对话要按顺序真的问一遍。
LLM_METHODS = {"answer", "dialogue"}
NAME_LIMIT = 64
DESCRIPTION_LIMIT = 500
QUESTION_LIMIT = 500
ANSWER_LIMIT = 2000
TURN_LIMIT = 20


def suite_view(row, count=0, latest=None):
    search_mode = row["search_mode"] or "hybrid"
    return {"id": row["id"], "name": row["name"], "description": row["description"] or "", "method": row["method"],
        "method_label": METHODS.get(row["method"], row["method"]), "search_mode": search_mode,
        "search_mode_label": SEARCH_MODES.get(search_mode, search_mode), "created_by": row["created_by"],
        "created": row["created"], "updated": row["updated"], "item_count": count, "latest": latest}


def item_view(row):
    return {"id": row["id"], **(row["data"] or {}), "created_by": row["created_by"], "created": row["created"],
        "updated": row["updated"]}


# 某个专项在历次专项评测里的结果（新的在前），来自评测记录的 summary.suites。
def suite_runs(suite_id, runs=None):
    result = []
    for run in runs if runs is not None else list_runs():
        if run.get("kind") != "special":
            continue
        entry = ((run.get("summary") or {}).get("suites") or {}).get(suite_id)
        if entry is None and suite_id not in [item["id"] for item in
                ((run.get("config") or {}).get("special") or {}).get("suites", [])]:
            continue
        result.append({"id": run["id"], "status": run["status"], "created": run["created"],
            "finished": run.get("finished"), "summary": entry})
    return result


def list_suites(engine):
    runs = list_runs()
    with engine.connect() as connection:
        rows = connection.execute(select(eval_suites).order_by(eval_suites.c.created)).mappings().all()
        counts = dict(connection.execute(select(eval_suite_items.c.suite_id, func.count()).group_by(
            eval_suite_items.c.suite_id)).all())
    items = []
    for row in rows:
        history = [entry for entry in suite_runs(row["id"], runs) if entry["status"] == "completed"]
        items.append(suite_view(row, counts.get(row["id"], 0), history[0] if history else None))
    return {"items": items, "methods": METHODS, "search_modes": SEARCH_MODES}


def check_search_mode(search_mode):
    if search_mode not in SEARCH_MODES:
        raise ValueError("请选择检索方式")
    return search_mode


def check_suite_fields(connection, name, description, method, exclude=None):
    name = (name or "").strip()
    if not name:
        raise ValueError("请填写专项名称")
    if len(name) > NAME_LIMIT:
        raise ValueError(f"专项名称不能超过 {NAME_LIMIT} 个字")
    if len(description or "") > DESCRIPTION_LIMIT:
        raise ValueError(f"说明不能超过 {DESCRIPTION_LIMIT} 个字")
    if method not in METHODS:
        raise ValueError("请选择评测方式")
    query = select(eval_suites.c.id).where(eval_suites.c.name == name)
    if exclude:
        query = query.where(eval_suites.c.id != exclude)
    if connection.execute(query).first():
        raise ValueError("已经有同名的专项")
    return name, (description or "").strip() or None


def create_suite(engine, name, description, method, username, search_mode="hybrid"):
    now = now_text()
    suite_id = str(uuid4())
    with engine.begin() as connection:
        name, description = check_suite_fields(connection, name, description, method)
        connection.execute(eval_suites.insert().values(id=suite_id, name=name, description=description,
            method=method, search_mode=check_search_mode(search_mode), created_by=username, created=now, updated=now))
    return get_suite(engine, suite_id)


# 改名称和说明；评测方式只有专项里还没有题目时才能改，因为不同方式的题目字段不一样。
def update_suite(engine, suite_id, name, description, method, search_mode="hybrid"):
    with engine.begin() as connection:
        row = connection.execute(select(eval_suites).where(eval_suites.c.id == suite_id)).mappings().first()
        if row is None:
            return None
        name, description = check_suite_fields(connection, name, description, method, exclude=suite_id)
        if method != row["method"] and connection.execute(select(func.count()).select_from(eval_suite_items).where(
                eval_suite_items.c.suite_id == suite_id)).scalar():
            raise ValueError("专项里已经有题目，不能再改评测方式")
        connection.execute(eval_suites.update().where(eval_suites.c.id == suite_id).values(name=name,
            description=description, method=method, search_mode=check_search_mode(search_mode), updated=now_text()))
    return get_suite(engine, suite_id)


def delete_suite(engine, suite_id):
    with engine.begin() as connection:
        deleted = connection.execute(eval_suites.delete().where(eval_suites.c.id == suite_id)).rowcount
        connection.execute(eval_suite_items.delete().where(eval_suite_items.c.suite_id == suite_id))
    return bool(deleted)


def get_suite(engine, suite_id):
    with engine.connect() as connection:
        row = connection.execute(select(eval_suites).where(eval_suites.c.id == suite_id)).mappings().first()
        if row is None:
            return None
        items = connection.execute(select(eval_suite_items).where(eval_suite_items.c.suite_id == suite_id).order_by(
            eval_suite_items.c.position)).mappings().all()
    view = suite_view(row, len(items))
    view["items"] = [item_view(item) for item in items]
    view["runs"] = suite_runs(suite_id)
    return view


def text_value(value, label, limit, required=True):
    text = (value or "").strip() if isinstance(value, str) or value is None else None
    if text is None:
        raise ValueError(f"{label}格式不对")
    if required and not text:
        raise ValueError(f"请填写{label}")
    if len(text) > limit:
        raise ValueError(f"{label}不能超过 {limit} 个字")
    return text


# 按评测方式校验一道题，返回要保存的字段。证据必须能在评测语料里逐字找到，否则这道题永远判为没找到。
def check_item(method, data, corpus=None):
    question = text_value(data.get("question"), "问题", QUESTION_LIMIT)
    cleaned = {"question": question}
    if method in ("retrieval", "answer"):
        evidence = [text.strip() for text in data.get("evidence") or [] if isinstance(text, str) and text.strip()]
        if method == "retrieval" and not evidence:
            raise ValueError("检索方式的题目至少要有一条证据原文")
        folded = normalize(corpus if corpus is not None else corpus_text())
        for text in evidence:
            if normalize(text) not in folded:
                raise ValueError(f"证据不在评测语料中：{text[:60]}")
        cleaned["evidence"] = evidence
    if method == "dialogue":
        turns = [text.strip() for text in data.get("turns") or [] if isinstance(text, str) and text.strip()]
        if not turns:
            raise ValueError("多轮对话的题目至少要有一轮前面的提问")
        if len(turns) > TURN_LIMIT:
            raise ValueError(f"前面的提问不能超过 {TURN_LIMIT} 轮")
        cleaned["turns"] = [text[:QUESTION_LIMIT] for text in turns]
    reference = text_value(data.get("reference_answer"), "参考答案", ANSWER_LIMIT, required=method in LLM_METHODS)
    if reference:
        cleaned["reference_answer"] = reference
    return cleaned


def suite_method(connection, suite_id):
    return connection.execute(select(eval_suites.c.method).where(eval_suites.c.id == suite_id)).scalar()


def add_item(engine, suite_id, data, username):
    now = now_text()
    with engine.begin() as connection:
        method = suite_method(connection, suite_id)
        if method is None:
            return None
        cleaned = check_item(method, data)
        position = connection.execute(select(func.max(eval_suite_items.c.position)).where(
            eval_suite_items.c.suite_id == suite_id)).scalar()
        item_id = str(uuid4())
        connection.execute(eval_suite_items.insert().values(id=item_id, suite_id=suite_id,
            position=0 if position is None else position + 1, data=cleaned, created_by=username, created=now,
            updated=now))
        connection.execute(eval_suites.update().where(eval_suites.c.id == suite_id).values(updated=now))
    return get_suite(engine, suite_id)


def update_item(engine, suite_id, item_id, data):
    now = now_text()
    with engine.begin() as connection:
        method = suite_method(connection, suite_id)
        if method is None:
            return None
        cleaned = check_item(method, data)
        updated = connection.execute(eval_suite_items.update().where(eval_suite_items.c.id == item_id,
            eval_suite_items.c.suite_id == suite_id).values(data=cleaned, updated=now)).rowcount
        if not updated:
            return None
    return get_suite(engine, suite_id)


def delete_item(engine, suite_id, item_id):
    with engine.begin() as connection:
        deleted = connection.execute(eval_suite_items.delete().where(eval_suite_items.c.id == item_id,
            eval_suite_items.c.suite_id == suite_id)).rowcount
    return get_suite(engine, suite_id) if deleted else None


# 要跑的专项及其题目；不存在或没有题目的专项报错，不新建一个必然失败的评测。
def load_for_run(engine, suite_ids):
    if not suite_ids:
        raise ValueError("请至少选择一个专项")
    loaded = []
    with engine.connect() as connection:
        for suite_id in dict.fromkeys(suite_ids):
            row = connection.execute(select(eval_suites).where(eval_suites.c.id == suite_id)).mappings().first()
            if row is None:
                raise ValueError("专项不存在或已被删除")
            items = connection.execute(select(eval_suite_items).where(
                eval_suite_items.c.suite_id == suite_id).order_by(eval_suite_items.c.position)).mappings().all()
            if not items:
                raise ValueError(f"「{row['name']}」还没有题目")
            loaded.append({"id": row["id"], "name": row["name"], "description": row["description"] or "",
                "method": row["method"], "search_mode": row["search_mode"] or "hybrid", "items": [{"id": item["id"], **(item["data"] or {})} for item in items]})
    return loaded


# 一条证据在向量检索、关键词检索里各排第几（多个检索词时取最好的名次），None 表示没进前几名。
def method_ranks(row, chunk_id):
    ranks = {}
    for listing in (row.get("diagnostics") or {}).get("lists") or []:
        for hit in listing.get("hits") or []:
            if hit.get("chunk_id") == chunk_id:
                method = listing.get("method")
                if ranks.get(method) is None or hit["rank"] < ranks[method]:
                    ranks[method] = hit["rank"]
    return ranks


# 按指定的几路检索逐题检索并打分，和调参评测用同一套检索和打分（DocumentSearchTool、score_question）；
# 检索词用不调用模型的规则改写（专项题都是独立的完整问题）。
def search_items(store, models, items, methods, progress, on_item=None):
    import_corpus(store, models)
    chunk_texts = current_chunk_texts(store)
    pool_size = runtime_snapshot()["rerank_candidates"]
    tool = DocumentSearchTool()
    rows = []
    config = {}
    for done, item in enumerate(items, 1):
        analysis = Models.fallback_query(item["question"], [], None)
        queries, rerank_query = analysis["queries"], analysis["standalone_query"]
        retrieval = tool.execute(store, models, EVAL_OWNER, queries, rerank_query, methods=methods)
        row = score_question(item, retrieval, chunk_texts, pool_size)
        row.update({"queries": queries, "rerank_query": rerank_query, "diagnostics": retrieval["diagnostics"],
            "sources": retrieval["sources"]})
        used = retrieval["diagnostics"]["config"]
        config = {"pool_size": pool_size, "return_limit": used.get("return_limit"), "min_score": used.get("min_score"),
            "reranked": used.get("reranked")}
        if on_item:
            on_item(item, row, retrieval)
        rows.append(row)
        progress(done)
    return rows, config


# 检索、回答方式：把专项题目当成调参题跑同一套检索（可选再回答），逐题整理成专项结果。
def run_search_suite(store, models, suite, responder, run_id, progress):
    items = []
    for item in suite["items"]:
        items.append({"id": item["id"], "question": item["question"], "type": "事实", "answerable": True,
            "evidence": item.get("evidence") or [], "reference_answer": item.get("reference_answer") or "",
            "split": "dev", "reviewed": True})
    on_item = answer_hook(store, models, responder, run_id) if suite["method"] == "answer" else None
    rows, config = search_items(store, models, items, SEARCH_METHODS[suite["search_mode"]], progress, on_item)
    questions = []
    dense_found = keyword_found = evidence_total = 0
    for item, row in zip(items, rows):
        evidence = []
        for entry in row.get("evidence") or []:
            ranks = method_ranks(row, entry.get("chunk_id")) if entry.get("chunk_id") else {}
            evidence.append({"text": entry["text"], "dense_rank": ranks.get("dense"),
                "keyword_rank": ranks.get("keyword"), "rerank_rank": entry.get("rerank_rank"),
                "status": entry.get("status")})
            evidence_total += 1
            dense_found += ranks.get("dense") is not None
            keyword_found += ranks.get("keyword") is not None
        found = ((row.get("stages") or {}).get("final") or {}).get("recall") or 0
        entry = {"id": item["id"], "question": item["question"], "evidence": evidence, "found": found >= 1,
            "lost_stage": row.get("lost_stage"), "returned": row.get("returned"),
            "reference_answer": item["reference_answer"] or None}
        if suite["method"] == "answer":
            judgement = row.get("judgement") or {}
            entry.update({"answer": row.get("answer"), "judgement": judgement,
                "passed": judgement.get("correctness") == 1})
        else:
            entry["passed"] = entry["found"]
        questions.append(entry)
    section = {"questions": questions, "search_mode": suite["search_mode"],
        "search_mode_label": SEARCH_MODES[suite["search_mode"]]}
    if evidence_total:
        section["evidence_total"] = evidence_total
        section["dense_found"] = dense_found
        section["keyword_found"] = keyword_found
    return section, config


# 多轮对话方式：每段对话按顺序问完，评审最后一问；compare 时每组记忆参数各跑一遍，通过与否看当前设置那组。
def run_dialogue_suite(store, models, suite, run_id, compare, progress):
    from .memory import average, memory_variants, run_dialogue
    import_corpus(store, models)
    variants = memory_variants(runtime_snapshot())
    if not compare:
        variants = variants[:1]
    done = 0
    results = []
    for variant in variants:
        rows = []
        for item in suite["items"]:
            outcome = run_dialogue(store, models, run_id, variant, item)
            judgement = judge_answer(models, {"question": item["question"], "history": item["turns"],
                "answerable": True, "reference_answer": item["reference_answer"]}, outcome["answer"],
                outcome["sources"])
            rows.append({"id": item["id"], "question": item["question"], "turns": item["turns"],
                "reference_answer": item["reference_answer"], "answer": outcome["answer"][:4000],
                "summarized": outcome["summarized"], "input_tokens": outcome["input_tokens"],
                "judgement": judgement, "passed": judgement.get("correctness") == 1})
            done += 1
            progress(done)
        results.append({"name": variant["name"], "label": variant["label"], "passed": sum(row["passed"] for row in rows),
            "correctness": average([row["judgement"].get("correctness") for row in rows]),
            "summarized_rate": average([1.0 if row["summarized"] else 0.0 for row in rows]),
            "input_tokens_avg": average([row["input_tokens"] for row in rows]), "rows": rows})
    section = {"questions": results[0]["rows"]}
    if compare:
        section["variants"] = [{key: value for key, value in result.items() if key != "rows"} for result in results]
    return section


# 执行一次专项评测：依次跑每个专项，结果按专项分开写进 run["special"]，总览写进 summary。
def run_special(store, models, run, on_progress, responder):
    special = run["config"]["special"]
    suites = load_for_run(store.engine, [suite["id"] for suite in special["suites"]])
    compare = bool(special.get("compare_memory"))
    total = 0
    for suite in suites:
        variants = len(memory_suites_variants(compare)) if suite["method"] == "dialogue" else 1
        total += len(suite["items"]) * variants
    offset = [0]
    sections = []
    search_config = None
    on_progress(0, total)
    for suite in suites:
        start = offset[0]

        def progress(done, start=start):
            on_progress(start + done, total)
        if suite["method"] == "dialogue":
            section = run_dialogue_suite(store, models, suite, run["id"], compare, progress)
            offset[0] += len(suite["items"]) * len(memory_suites_variants(compare))
        else:
            section, search_config = run_search_suite(store, models, suite, responder, run["id"], progress)
            offset[0] += len(suite["items"])
        passed = sum(1 for question in section["questions"] if question["passed"])
        section.update({"suite_id": suite["id"], "name": suite["name"], "description": suite["description"],
            "method": suite["method"], "method_label": METHODS[suite["method"]], "count": len(suite["items"]),
            "passed": passed})
        sections.append(section)
        run["special"] = sections
    settings = runtime_snapshot()
    run["config"].update({"settings": settings, "model_mode": models.mode, "llm_model": models.llm_model,
        "embedding_model": models.embedding_model, "rerank_model": models.rerank_model})
    if search_config:
        for key in ("pool_size", "return_limit", "min_score", "reranked"):
            run["config"][key] = search_config.get(key)
    count = sum(section["count"] for section in sections)
    passed = sum(section["passed"] for section in sections)
    run["summary"] = {"count": count, "passed": passed, "pass_rate": round(passed / count, 4) if count else None,
        "suites": {section["suite_id"]: {"name": section["name"], "method": section["method"],
            "count": section["count"], "passed": section["passed"]} for section in sections}}
    return run


def memory_suites_variants(compare):
    from .memory import memory_variants
    variants = memory_variants(runtime_snapshot())
    return variants if compare else variants[:1]


# 打开一次专项评测时，给每个专项找到上一次跑过它的评测，逐题标出上次是否通过，页面据此显示「变好 / 变差」。
def attach_previous(run, runs=None):
    from .results import load_run
    runs = runs if runs is not None else list_runs()
    for section in run.get("special") or []:
        previous = None
        for candidate in runs:
            if candidate["id"] >= run["id"] or candidate.get("kind") != "special" or candidate.get("status") != "completed":
                continue
            if section["suite_id"] in ((candidate.get("summary") or {}).get("suites") or {}):
                previous = candidate
                break
        if previous is None:
            continue
        full = load_run(previous["id"]) or {}
        before = next((item for item in full.get("special") or [] if item["suite_id"] == section["suite_id"]), None)
        if before is None:
            continue
        passed = {question["id"]: question["passed"] for question in before["questions"]}
        section["previous"] = {"id": previous["id"], "created": previous["created"], "passed": before["passed"],
            "count": before["count"]}
        for question in section["questions"]:
            question["previous_passed"] = passed.get(question["id"])
    return run
