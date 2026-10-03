# 巡检复测集：管理员自建的评测集，题目多数来自知识巡检。
# 和调参评测集、专项评测集分开：那两种在隔离的评测语料上衡量检索和回答质量；
# 巡检复测集回答的是"之前出过问题的这些提问，现在还好吗"，按提问人的权限在线上知识库里跑。
from collections import Counter
from datetime import datetime, timezone
import logging
from uuid import uuid4

from sqlalchemy import delete, func, select

from ..agent.replay import replay_question
from ..inspection.diagnosis import full_scope, matched_documents, top_score
from ..mysql.store import (document_heads, eval_set_items, eval_set_runs, eval_sets, inspection_issue_events,
    inspection_issues, run_errors, runs, users)
from ..observability import is_refusal
from ..tools.search import DocumentSearchTool
from .generation import judge_answer


logger = logging.getLogger("production-rag-regression")

EXPECTS = {"answer": "应该回答", "refuse": "应该拒答"}
KINDS = {"retrieval": "检索", "generation": "生成"}
# 从一个巡检问题加入评测集时，最多列出几种不同的问法供选择。
CANDIDATE_LIMIT = 5
# 合理拒答的原因，和 app/inspection/service.py 的 REASONABLE_REFUSALS 一致；
# 这里不直接 import，避免评测模块和巡检模块互相引用。
REASONABLE_REFUSALS = {"out_of_scope", "by_design_permission", "not_covered"}


def now_text():
    return datetime.now(timezone.utc).isoformat()


def set_view(row, item_count=0, latest=None):
    return {"id": row["id"], "name": row["name"], "description": row["description"], "created_by": row["created_by"],
        "created": row["created"], "updated": row["updated"], "item_count": item_count, "latest": latest or {}}


def item_view(row):
    return {"id": row["id"], "set_id": row["set_id"], "question": row["question"], "asker": row["asker"],
        "expect": row["expect"], "expect_label": EXPECTS.get(row["expect"], row["expect"]),
        "documents": row["documents"] or [], "reference_answer": row["reference_answer"], "note": row["note"],
        "issue_id": row["issue_id"], "created_by": row["created_by"], "created": row["created"]}


def run_view(row, with_results=False):
    view = {"id": row["id"], "set_id": row["set_id"], "kind": row["kind"], "kind_label": KINDS.get(row["kind"], row["kind"]),
        "status": row["status"], "triggered_by": row["triggered_by"], "summary": row["summary"] or {},
        "error": row["error"], "started": row["started"], "finished": row["finished"]}
    if with_results:
        view["results"] = row["results"] or []
    return view


# 评测集列表：每个集的题数，以及检索、生成各自最近一次运行的通过情况。
def list_sets(store):
    with store.engine.connect() as connection:
        rows = connection.execute(select(eval_sets).order_by(eval_sets.c.created.desc())).mappings().all()
        counts = dict(connection.execute(select(eval_set_items.c.set_id, func.count()).group_by(
            eval_set_items.c.set_id)).all())
        run_rows = connection.execute(select(eval_set_runs.c.id, eval_set_runs.c.set_id, eval_set_runs.c.kind,
            eval_set_runs.c.status, eval_set_runs.c.summary, eval_set_runs.c.started, eval_set_runs.c.finished,
            eval_set_runs.c.triggered_by, eval_set_runs.c.error).order_by(eval_set_runs.c.started.desc())).mappings().all()
    latest = {}
    for run in run_rows:
        latest.setdefault(run["set_id"], {}).setdefault(run["kind"], {"id": run["id"], "status": run["status"],
            "summary": run["summary"] or {}, "started": run["started"], "finished": run["finished"]})
    return {"items": [set_view(row, counts.get(row["id"], 0), latest.get(row["id"])) for row in rows],
        "expects": EXPECTS, "kinds": KINDS}


def check_name(connection, name, exclude=None):
    name = (name or "").strip()
    if not name:
        raise ValueError("请填写评测集名字")
    query = select(eval_sets.c.id).where(eval_sets.c.name == name)
    if exclude:
        query = query.where(eval_sets.c.id != exclude)
    if connection.execute(query).first():
        raise ValueError(f"已经有叫「{name}」的评测集了")
    return name


def create_set(store, name, description, username):
    now = now_text()
    set_id = str(uuid4())
    with store.engine.begin() as connection:
        name = check_name(connection, name)
        connection.execute(eval_sets.insert().values(id=set_id, name=name, description=(description or "").strip() or None,
            created_by=username, created=now, updated=now))
    return get_set(store, set_id)


def update_set(store, set_id, name=None, description=None):
    values = {"updated": now_text()}
    with store.engine.begin() as connection:
        if name is not None:
            values["name"] = check_name(connection, name, exclude=set_id)
        if description is not None:
            values["description"] = description.strip() or None
        if connection.execute(eval_sets.update().where(eval_sets.c.id == set_id).values(**values)).rowcount == 0:
            return None
    return get_set(store, set_id)


def delete_set(store, set_id):
    with store.engine.begin() as connection:
        if connection.execute(delete(eval_sets).where(eval_sets.c.id == set_id)).rowcount == 0:
            return False
        connection.execute(delete(eval_set_items).where(eval_set_items.c.set_id == set_id))
        connection.execute(delete(eval_set_runs).where(eval_set_runs.c.set_id == set_id))
    return True


# 评测集详情：全部题目和最近的运行记录（不含逐题结果，打开某次运行时再取）。
def get_set(store, set_id):
    with store.engine.connect() as connection:
        row = connection.execute(select(eval_sets).where(eval_sets.c.id == set_id)).mappings().first()
        if row is None:
            return None
        items = connection.execute(select(eval_set_items).where(eval_set_items.c.set_id == set_id).order_by(
            eval_set_items.c.created)).mappings().all()
        run_rows = connection.execute(select(eval_set_runs).where(eval_set_runs.c.set_id == set_id).order_by(
            eval_set_runs.c.started.desc()).limit(20)).mappings().all()
    view = set_view(row, len(items))
    view.update({"items": [item_view(item) for item in items], "runs": [run_view(run) for run in run_rows],
        "expects": EXPECTS, "kinds": KINDS})
    return view


# 题目内容的校验，新增和编辑共用：提问人必须是现有用户（要按他的权限检索），期望命中的文档必须存在，
# 同一个评测集里不能有两道问题和提问人都相同的题。返回要写入的字段。
def item_values(connection, set_id, item, exclude=None):
    question = (item.get("question") or "").strip()
    asker = (item.get("asker") or "").strip()
    if not question:
        raise ValueError("请填写问题")
    if connection.execute(select(users.c.username).where(users.c.username == asker)).first() is None:
        raise ValueError(f"用户不存在：{asker}")
    if item.get("expect") not in EXPECTS:
        raise ValueError("期望结果只能是应该回答或应该拒答")
    duplicate = select(eval_set_items.c.id).where(eval_set_items.c.set_id == set_id,
        eval_set_items.c.question == question, eval_set_items.c.asker == asker)
    if exclude:
        duplicate = duplicate.where(eval_set_items.c.id != exclude)
    if connection.execute(duplicate).first():
        raise ValueError(f"评测集里已经有这道题了：{question}（{asker}）")
    keys = []
    for document in item.get("documents") or []:
        doc_key = document.get("doc_key") if isinstance(document, dict) else document
        if doc_key not in keys:
            keys.append(doc_key)
    titles = dict(connection.execute(select(document_heads.c.doc_key, document_heads.c.title).where(
        document_heads.c.doc_key.in_(keys))).all()) if keys else {}
    documents = []
    for doc_key in keys:
        if doc_key not in titles:
            raise ValueError(f"文档不存在：{doc_key}")
        documents.append({"doc_key": doc_key, "title": titles[doc_key]})
    if item["expect"] == "refuse" and documents:
        raise ValueError("应该拒答的题不用填期望命中的文档")
    return {"question": question, "asker": asker, "expect": item["expect"], "documents": documents,
        "reference_answer": (item.get("reference_answer") or "").strip() or None,
        "note": (item.get("note") or "").strip()[:500] or None}


# 新增题目，逐题校验，有一题不合格就整批不加。
def add_items(store, set_id, items, username):
    now = now_text()
    added = []
    with store.engine.begin() as connection:
        if connection.execute(select(eval_sets.c.id).where(eval_sets.c.id == set_id)).first() is None:
            return None
        for item in items:
            values = {"id": str(uuid4()), "set_id": set_id, **item_values(connection, set_id, item),
                "issue_id": item.get("issue_id"), "created_by": username, "created": now}
            connection.execute(eval_set_items.insert().values(**values))
            added.append(values)
        connection.execute(eval_sets.update().where(eval_sets.c.id == set_id).values(updated=now))
    return [item_view(item) for item in added]


# 编辑题目：问题、提问人、期望结果、期望文档、参考答案都可以改；来源巡检问题不变。
# 改了之后，和上一次运行比较时仍按题目编号对应。
def update_item(store, set_id, item_id, item):
    with store.engine.begin() as connection:
        if connection.execute(select(eval_set_items.c.id).where(eval_set_items.c.set_id == set_id,
                eval_set_items.c.id == item_id)).first() is None:
            return None
        values = item_values(connection, set_id, item, exclude=item_id)
        connection.execute(eval_set_items.update().where(eval_set_items.c.id == item_id).values(**values))
        connection.execute(eval_sets.update().where(eval_sets.c.id == set_id).values(updated=now_text()))
        row = connection.execute(select(eval_set_items).where(eval_set_items.c.id == item_id)).mappings().first()
    return item_view(row)


# 编辑题目时可选的期望文档：所有文档的当前版本（管理员才能调用）。
def document_options(store):
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_heads.c.doc_key, document_heads.c.title, document_heads.c.owner).order_by(
            document_heads.c.title)).mappings().all()
    return [{"doc_key": row["doc_key"], "title": row["title"], "owner": row["owner"]} for row in rows]


def delete_item(store, set_id, item_id):
    with store.engine.begin() as connection:
        return connection.execute(delete(eval_set_items).where(eval_set_items.c.set_id == set_id,
            eval_set_items.c.id == item_id)).rowcount > 0


# 从巡检问题加入评测集时的预填内容：几种不同的问法（用改写后的完整问题，多轮追问才看得懂）、
# 提问人、期望结果和期望命中的文档，管理员确认后再加入。
#   知识缺口标记为合理拒答（无需处理且原因是超出范围、权限保密、不打算覆盖）：应该拒答；
#   其他知识缺口：应该回答，期望文档取诊断时找到的文档（提问人能看到的，或全库里有但没权限的）；
#   可疑内容：应该回答，期望文档是被差评的那份，参考答案需要管理员补上正确说法；
#   系统问题：应该回答，不限定文档。
def issue_candidates(store, issue_id):
    with store.engine.connect() as connection:
        issue = connection.execute(select(inspection_issues.c.id, inspection_issues.c.kind, inspection_issues.c.status,
            inspection_issues.c.close_reason, inspection_issues.c.detail, inspection_issues.c.title).where(
                inspection_issues.c.id == issue_id)).mappings().first()
        if issue is None:
            return None
        events = connection.execute(select(inspection_issue_events).where(
            inspection_issue_events.c.issue_id == issue_id).order_by(inspection_issue_events.c.created.desc())).mappings().all()
        run_ids = [event["source_id"] for event in events if event["source"] == "run"]
        error_ids = [event["source_id"] for event in events if event["source"] == "error"]
        run_rows = {}
        if run_ids:
            for row in connection.execute(select(runs.c.id, runs.c.question, runs.c.trace).where(runs.c.id.in_(run_ids))).mappings():
                run_rows[row["id"]] = row
        error_rows = {}
        if error_ids:
            for row in connection.execute(select(run_errors.c.id, run_errors.c.question).where(run_errors.c.id.in_(error_ids))).mappings():
                error_rows[row["id"]] = row
        added = {(row["set_id"], row["question"], row["asker"]) for row in connection.execute(select(
            eval_set_items.c.set_id, eval_set_items.c.question, eval_set_items.c.asker).where(
                eval_set_items.c.issue_id == issue_id)).mappings().all()}
        set_names = dict(connection.execute(select(eval_sets.c.id, eval_sets.c.name)).all())
    detail = issue["detail"] or {}
    candidates = []
    seen = set()
    for event in events:
        if event["source"] == "run" and event["source_id"] in run_rows:
            row = run_rows[event["source_id"]]
            original = row["question"]
            question = ((row["trace"] or {}).get("rewrite") or {}).get("standalone_query") or original
        elif event["source"] == "error" and event["source_id"] in error_rows:
            original = question = error_rows[event["source_id"]]["question"]
        else:
            continue
        if (question, event["owner"]) in seen:
            continue
        seen.add((question, event["owner"]))
        candidates.append({"question": question, "original": original, "asker": event["owner"],
            "in_sets": [set_names[set_id] for set_id, text, asker in added
                if text == question and asker == event["owner"] and set_id in set_names]})
        if len(candidates) >= CANDIDATE_LIMIT:
            break
    expect = "answer"
    documents = []
    if issue["kind"] == "knowledge_gap":
        if issue["status"] == "ignored" and issue["close_reason"] in REASONABLE_REFUSALS:
            expect = "refuse"
        else:
            for checked in (detail.get("diagnosis") or {}).get("questions") or []:
                for document in checked.get("documents") or []:
                    if document.get("doc_key") and document["doc_key"] not in [item["doc_key"] for item in documents]:
                        documents.append({"doc_key": document["doc_key"], "title": document.get("title")})
    elif issue["kind"] == "suspect_content" and detail.get("doc_key"):
        documents.append({"doc_key": detail["doc_key"], "title": detail.get("document_title")})
    hint = {
        "refuse": "这个问题标记为合理拒答，加入后检查系统以后是否仍然拒答，防止误答。",
        "answer": "修好之后加入，以后每次改动都检查这些问题还能不能答上来。",
    }[expect]
    if issue["kind"] == "suspect_content":
        hint = "可疑内容建议补上参考答案（正确的说法），生成评测时由评审模型核对回答是否正确。"
    return {"issue_id": issue_id, "kind": issue["kind"], "candidates": candidates, "expect": expect,
        "documents": documents, "hint": hint}


# 检索评测：按提问人的权限检索一次，不调用大模型。
#   应该回答：有资料达到相关度要求；填了期望文档时，还要求命中其中至少一份；
#   应该拒答：没有任何资料达到要求。
def check_retrieval(store, models, item, scope, tool):
    result = tool.execute(store, models, item["asker"], [item["question"]], item["question"])
    found = matched_documents(store, result["sources"], scope)
    score = top_score(result)
    found_keys = {document["doc_key"] for document in found}
    expected = item["documents"] or []
    if item["expect"] == "refuse":
        passed = not result["sources"]
        reason = "没有检索到达标的资料，会拒答" if passed else f"检索到了 {len(result['sources'])} 段达标资料，可能不会拒答"
    elif not result["sources"]:
        passed = False
        reason = "没有检索到达标的资料，会拒答"
    elif expected and not found_keys & {document["doc_key"] for document in expected}:
        passed = False
        reason = "检索到了资料，但不是期望的文档：" + "、".join(f"《{document['title']}》" for document in found[:3])
    else:
        passed = True
        reason = f"检索到 {len(result['sources'])} 段达标资料"
    return {"passed": passed, "reason": reason, "top_score": score,
        "documents": [{"doc_key": document["doc_key"], "title": document["title"], "score": document.get("score")} for document in found]}


# 生成评测：以提问人的身份完整问一遍（见 app/agent/replay.py）。
#   应该拒答：系统拒答了；
#   应该回答：没有拒答、走的是知识问答，填了期望文档时回答用到的资料里要有它；
#   有参考答案且接了真实大模型时，再让评审模型核对，要点一致才算通过。
def check_generation(store, models, item, scope):
    replay = replay_question(store, models, item["asker"], item["question"])
    raw_sources = replay["raw"].get("sources") or []
    found = matched_documents(store, raw_sources, scope)
    judge = None
    refused = replay["refused"]
    if models.mode == "openai" and replay["route"] == "knowledge" and not is_refusal(replay["answer"]):
        judge = judge_answer(models, {"question": item["question"], "answerable": item["expect"] == "answer",
            "reference_answer": item["reference_answer"] or ""}, replay["answer"], raw_sources)
        refused = bool(judge.get("refused"))
    expected = {document["doc_key"] for document in item["documents"] or []}
    if item["expect"] == "refuse":
        passed = refused
        reason = "系统拒答了" if passed else "系统给出了回答，没有拒答"
    elif refused:
        passed = False
        reason = "系统拒答了"
    elif replay["route"] != "knowledge":
        passed = False
        reason = "问题没有走知识问答（被分到了其他工具）"
    elif expected and not expected & {document["doc_key"] for document in found}:
        passed = False
        reason = "回答了，但用到的资料里没有期望的文档"
    elif judge and item["reference_answer"] and (judge.get("correctness") or 0) < 1:
        passed = False
        reason = "和参考答案不一致：" + (judge.get("correctness_reason") or "")
    else:
        passed = True
        reason = "回答了" + ("，和参考答案一致" if judge and item["reference_answer"] else "")
    return {"passed": passed, "reason": reason, "top_score": replay["top_score"], "route": replay["route"],
        "refused": refused, "answer": replay["answer"][:4000],
        "documents": [{"doc_key": document["doc_key"], "title": document["title"], "score": document.get("score")} for document in found],
        "judge": {key: judge.get(key) for key in ("correctness", "correctness_reason", "faithfulness", "citation")} if judge else None}


def start_run(store, set_id, kind, username):
    if kind not in KINDS:
        raise ValueError(f"未知的评测方式：{kind}")
    with store.engine.begin() as connection:
        if connection.execute(select(eval_sets.c.id).where(eval_sets.c.id == set_id)).first() is None:
            return None
        total = connection.execute(select(func.count()).select_from(eval_set_items).where(
            eval_set_items.c.set_id == set_id)).scalar()
        if not total:
            raise ValueError("评测集里还没有题目")
        if connection.execute(select(eval_set_runs.c.id).where(eval_set_runs.c.set_id == set_id,
                eval_set_runs.c.status == "running")).first():
            raise ValueError("这个评测集正在运行，请等它跑完")
        run_id = str(uuid4())
        connection.execute(eval_set_runs.insert().values(id=run_id, set_id=set_id, kind=kind, status="running",
            triggered_by=username, summary={"total": total, "done": 0}, started=now_text()))
    return run_id


# 逐题执行，每题结束后更新进度；单题出错记为未通过并写明原因，不影响其他题。
def execute_run(store, models, run_id):
    with store.engine.connect() as connection:
        run = connection.execute(select(eval_set_runs).where(eval_set_runs.c.id == run_id)).mappings().first()
        items = connection.execute(select(eval_set_items).where(eval_set_items.c.set_id == run["set_id"]).order_by(
            eval_set_items.c.created)).mappings().all()
    try:
        scope = full_scope(store)
        tool = DocumentSearchTool()
        results = []
        for index, item in enumerate(items):
            item = dict(item)
            try:
                if run["kind"] == "retrieval":
                    outcome = check_retrieval(store, models, item, scope, tool)
                else:
                    outcome = check_generation(store, models, item, scope)
            except Exception as error:
                logger.exception("regression_item_failed run_id=%s item_id=%s", run_id, item["id"])
                outcome = {"passed": False, "reason": f"执行出错：{type(error).__name__}: {error}"[:300], "error": True}
            results.append({"item_id": item["id"], "question": item["question"], "asker": item["asker"],
                "expect": item["expect"], **outcome})
            with store.engine.begin() as connection:
                connection.execute(eval_set_runs.update().where(eval_set_runs.c.id == run_id).values(
                    summary={"total": len(items), "done": index + 1}))
        summary = summarize(results)
        summary.update(compare(store, run, results))
        with store.engine.begin() as connection:
            connection.execute(eval_set_runs.update().where(eval_set_runs.c.id == run_id).values(
                status="completed", summary=summary, results=results, finished=now_text()))
    except Exception as error:
        logger.exception("regression_run_failed run_id=%s", run_id)
        with store.engine.begin() as connection:
            connection.execute(eval_set_runs.update().where(eval_set_runs.c.id == run_id).values(
                status="failed", error=f"{type(error).__name__}: {error}"[:500], finished=now_text()))


def summarize(results):
    passed = sum(1 for result in results if result["passed"])
    by_expect = {}
    for expect in EXPECTS:
        selected = [result for result in results if result["expect"] == expect]
        if selected:
            by_expect[expect] = {"total": len(selected), "passed": sum(1 for result in selected if result["passed"])}
    return {"total": len(results), "done": len(results), "passed": passed, "failed": len(results) - passed,
        "pass_rate": round(passed / len(results), 4) if results else None, "by_expect": by_expect}


# 和同一个评测集、同一种方式的上一次运行比较：哪些题原来通过现在失败（新失败），哪些原来失败现在通过（新通过）。
def compare(store, run, results):
    with store.engine.connect() as connection:
        previous = connection.execute(select(eval_set_runs.c.id, eval_set_runs.c.results, eval_set_runs.c.started).where(
            eval_set_runs.c.set_id == run["set_id"], eval_set_runs.c.kind == run["kind"],
            eval_set_runs.c.status == "completed", eval_set_runs.c.started < run["started"]).order_by(
                eval_set_runs.c.started.desc()).limit(1)).mappings().first()
    if previous is None:
        return {"previous": None}
    before = {result["item_id"]: result["passed"] for result in previous["results"] or []}
    changes = Counter()
    for result in results:
        if result["item_id"] not in before:
            result["change"] = "new"
            changes["new"] += 1
        elif before[result["item_id"]] and not result["passed"]:
            result["change"] = "regressed"
            changes["regressed"] += 1
        elif not before[result["item_id"]] and result["passed"]:
            result["change"] = "fixed"
            changes["fixed"] += 1
    return {"previous": {"id": previous["id"], "started": previous["started"]}, "changes": dict(changes)}


def get_run(store, set_id, run_id):
    with store.engine.connect() as connection:
        row = connection.execute(select(eval_set_runs).where(eval_set_runs.c.id == run_id,
            eval_set_runs.c.set_id == set_id)).mappings().first()
    return run_view(row, with_results=True) if row else None


# 服务重启时还标着运行中的记录已经不会再跑完，标记为中断，免得评测集一直显示"运行中"无法再次运行。
def interrupt_running(store):
    with store.engine.begin() as connection:
        connection.execute(eval_set_runs.update().where(eval_set_runs.c.status == "running").values(
            status="interrupted", error="服务重启，运行中断", finished=now_text()))
