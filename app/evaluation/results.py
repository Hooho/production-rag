from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import threading

from sqlalchemy import select

from ..mysql.store import eval_runs, settings as settings_table
from ..runtime_config import bound_engine
from .dataset import EVAL_DIR, QUESTION_TYPES
from .generation import answer_question, cited_ids, judge_answer, summarize_generation
from .retrieval import EVAL_OWNER, run_retrieval
from ..tools.search import DocumentSearchTool


# 每次评测一条记录，编号是"日期时间_提交号"，一眼能看出是哪天、哪个版本的代码跑出来的。
# 以前每次评测存成 eval/results 下的一个 JSON 文件，想随代码一起提交；实际很少提交，文件又大（带诊断的一次两百多万字节），
# 题目也已经搬进了数据库，所以结果也存数据库（eval_runs 表）。旧文件在首次启动时导入一次（import_result_files）。
RESULTS_DIR = EVAL_DIR / "results"
IMPORT_KEY = "eval_results_imported"
# 评测在后台线程里边跑边保存进度，页面同时在轮询读取；读写评测记录时排个队，免得同一个连接上的事务互相打架
# （SQLite 测试库只有一个共享连接，MySQL 上也只是多等几毫秒）。
_lock = threading.RLock()
RUN_ID_PATTERN = re.compile(r"^\d{8}-\d{6}_[0-9A-Za-z-]+$")
# 对比时每个指标的方向：higher 表示越大越好，lower 表示越小越好。
# 没有方向就无法判断"变好还是变差"，例如误杀率上升是变差，召回率上升是变好。
METRICS = [
    ("recall_pool", "召回 Recall@候选池", "higher"),
    ("recall_top", "重排 Recall@返回数", "higher"),
    ("recall_final", "过滤后 Recall", "higher"),
    ("mrr_pool", "召回 MRR", "higher"),
    ("mrr_top", "重排 MRR", "higher"),
    ("mrr_final", "过滤后 MRR", "higher"),
    ("false_reject_rate", "误杀率", "lower"),
    ("false_accept_rate", "漏放率", "lower"),
    ("latency_avg_ms", "平均耗时（毫秒）", "lower"),
    ("latency_p95_ms", "P95 耗时（毫秒）", "lower"),
    ("faithfulness", "忠实度", "higher"),
    ("correctness", "正确性", "higher"),
    ("refusal_accuracy", "拒答正确率", "higher"),
    ("citation_validity", "引用有效性", "higher"),
]


# 读取当前代码的提交号；容器里没有 .git 时用环境变量 GIT_COMMIT，仍拿不到就记为 unknown。
def git_commit():
    configured = os.getenv("GIT_COMMIT")
    if configured:
        return configured
    try:
        output = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
            timeout=5, check=True).stdout.strip()
        return output or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


# 生成一次评测的编号；提交号里只保留字母数字和连字符，保证能安全地作为文件名。
# 编号精确到秒，同一秒里发起两次（测试里很常见）会撞号、后一次覆盖前一次；撞号时往后顺延一秒，保持按时间排序。
def new_run_id(commit):
    safe_commit = re.sub(r"[^0-9A-Za-z-]", "", commit) or "unknown"
    moment = datetime.now()
    while True:
        run_id = moment.strftime("%Y%m%d-%H%M%S") + "_" + safe_commit
        with _lock, target_engine().connect() as connection:
            taken = connection.execute(select(eval_runs.c.id).where(eval_runs.c.id == run_id)).first()
        if not taken:
            return run_id
        moment += timedelta(seconds=1)


# 当前 UTC 时间，统一用 ISO 格式保存。
def now():
    return datetime.now(timezone.utc).isoformat()


# 编号只允许固定格式，接口参数里的编号先校验再查询。
def check_run_id(run_id):
    if not RUN_ID_PATTERN.match(run_id):
        raise ValueError("评测编号格式不正确")
    return run_id


def target_engine(engine=None):
    return engine or bound_engine()


# 保存（新建或覆盖）一次评测：列表要用的概要单独存一列，读列表时不用把逐题明细一起读出来。
# 评测进行中会反复保存进度，每次整条覆盖，读到的总是完整的一版。
def save_run(run, engine=None):
    check_run_id(run["id"])
    values = {"kind": run.get("kind") or "", "status": run.get("status") or "", "created": run.get("created") or now(),
        "brief": json.loads(json.dumps(run_brief(run), default=str)), "data": json.loads(json.dumps(run, default=str)),
        "updated": now()}
    with _lock, target_engine(engine).begin() as connection:
        updated = connection.execute(eval_runs.update().where(eval_runs.c.id == run["id"]).values(**values)).rowcount
        if not updated:
            connection.execute(eval_runs.insert().values(id=run["id"], **values))


# 读取一次评测的完整结果。
def load_run(run_id, engine=None):
    check_run_id(run_id)
    with _lock, target_engine(engine).connect() as connection:
        data = connection.execute(select(eval_runs.c.data).where(eval_runs.c.id == run_id)).scalar()
    return dict(data) if data is not None else None


# 删除一条评测记录。
def delete_run(run_id, engine=None):
    check_run_id(run_id)
    with _lock, target_engine(engine).begin() as connection:
        return bool(connection.execute(eval_runs.delete().where(eval_runs.c.id == run_id)).rowcount)


# 首次启动时把 eval/results 下的旧结果文件导入数据库（已有同编号的跳过），只做一次；文件原样保留，可以自己删。
def import_result_files(engine):
    with engine.connect() as connection:
        if connection.execute(select(settings_table.c.key).where(settings_table.c.key == IMPORT_KEY)).first():
            return 0
        existing = set(connection.execute(select(eval_runs.c.id)).scalars().all())
    imported = 0
    for path in sorted(RESULTS_DIR.glob("*.json")) if RESULTS_DIR.exists() else []:
        try:
            run = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(run, dict) or not RUN_ID_PATTERN.match(str(run.get("id", ""))) or run["id"] in existing:
            continue
        save_run(run, engine)
        imported += 1
    with engine.begin() as connection:
        connection.execute(settings_table.insert().values(key=IMPORT_KEY, value={"at": now(), "count": imported},
            updated=now()))
    return imported


# 历史指标说明只需要这些汇总数字；提前随列表返回，前端展开指标时不必再请求完整逐题结果。
def summarize_history_metrics(run):
    questions = run.get("questions")
    if not isinstance(questions, list):
        return None

    config = run.get("config") or {}
    return_limit = config.get("return_limit") or 6
    answerable_questions = 0
    unanswerable_questions = 0
    evidence_total = 0
    pool_chunks = 0
    pool_hits = 0
    top_total = 0
    top_chunks = 0
    top_hits = 0
    final_remaining = 0
    final_answerable_chunks = 0
    final_hits = 0
    false_reject_questions = 0
    false_accept_questions = 0

    for question in questions:
        pool = question.get("pool")
        configured_pool_size = config.get("pool_size") or 0
        pool_size = len(pool) if isinstance(pool, list) else configured_pool_size
        returned = question.get("returned") or 0
        top_total += min(pool_size, return_limit)
        final_remaining += returned

        if question.get("answerable"):
            answerable_questions += 1
            evidence_count = question.get("evidence_count") or 0
            evidence_total += evidence_count
            pool_chunks += pool_size
            top_chunks += min(pool_size, return_limit)
            for stage in ("pool", "top", "final"):
                stage_data = (question.get("stages") or {}).get(stage) or {}
                recall = stage_data.get("recall") or 0
                hits = int(recall * evidence_count + 0.5)
                if stage == "pool":
                    pool_hits += hits
                elif stage == "top":
                    top_hits += hits
                else:
                    final_hits += hits
            final_answerable_chunks += returned
            if returned == 0:
                false_reject_questions += 1
        else:
            unanswerable_questions += 1
            if returned > 0:
                false_accept_questions += 1

    return {
        "answerable_questions": answerable_questions,
        "unanswerable_questions": unanswerable_questions,
        "evidence_total": evidence_total,
        "pool_chunks": pool_chunks,
        "pool_hits": pool_hits,
        "top_total": top_total,
        "top_chunks": top_chunks,
        "top_hits": top_hits,
        "final_remaining": final_remaining,
        "final_answerable_chunks": final_answerable_chunks,
        "final_hits": final_hits,
        "false_reject_questions": false_reject_questions,
        "false_accept_questions": false_accept_questions,
    }


# 列出历次评测（新的在前），只返回列表需要的概要；逐题明细很大，列表里不带。
def list_runs(engine=None):
    with _lock, target_engine(engine).connect() as connection:
        rows = connection.execute(select(eval_runs.c.brief).order_by(eval_runs.c.id.desc())).scalars().all()
    return [dict(row) for row in rows]


# 一次评测的概要：编号、时间、提交号、配置、主要指标和进度。
def run_brief(run):
    brief = {}
    for key in ("id", "kind", "status", "created", "finished", "commit", "config", "summary", "progress", "error"):
        brief[key] = run.get(key)
    # 历史页的指标解释依赖实际证据数量，和列表内容一起返回，避免展开每行时补请求完整结果。
    brief["history_metrics"] = summarize_history_metrics(run)
    return brief


# 找到同类型、同一题目范围里在它之前完成的最近一次评测，作为"上一次"自动对比。
# 题目范围不同（dev 和 holdout）时分数不可比，因此必须同 split。
def previous_run(run, runs):
    split = (run.get("config") or {}).get("split")
    for candidate in runs:
        if candidate["id"] >= run["id"] or candidate.get("status") != "completed":
            continue
        if candidate.get("kind") != run.get("kind"):
            continue
        if (candidate.get("config") or {}).get("split") != split:
            continue
        return candidate
    return None


# 逐项比较两次评测的整体指标，给出差值和"变好 / 变差 / 持平"。
def compare_runs(base, target):
    base_summary = base.get("summary") or {}
    target_summary = target.get("summary") or {}
    rows = []
    for key, label, direction in METRICS:
        before = base_summary.get(key)
        after = target_summary.get(key)
        if before is None and after is None:
            continue
        delta = None
        change = "unknown"
        if before is not None and after is not None:
            delta = round(after - before, 6)
            # 耗时每次运行都会有几毫秒的自然波动，差值不超过 5 毫秒或 10% 时算持平，否则会被随机抖动误报为"变差"。
            tolerance = 1e-9
            if key.endswith("_ms"):
                tolerance = max(5, abs(before) * 0.1)
            if abs(delta) <= tolerance:
                change = "same"
            elif (delta > 0) == (direction == "higher"):
                change = "better"
            else:
                change = "worse"
        rows.append({"key": key, "label": label, "direction": direction, "base": before, "target": after,
            "delta": delta, "change": change})
    # 两次评测用的系统参数不同时（设置页改过），列出不同的项，提醒分数变化可能来自参数而不是代码。
    # 旧记录没有保存完整参数，只比较双方都有的项。
    base_settings = (base.get("config") or {}).get("settings") or {}
    target_settings = (target.get("config") or {}).get("settings") or {}
    settings_diff = []
    for key in sorted(set(base_settings) & set(target_settings)):
        if base_settings[key] != target_settings[key]:
            settings_diff.append({"key": key, "base": base_settings[key], "target": target_settings[key]})
    return {"base": run_brief(base), "target": run_brief(target), "metrics": rows, "settings_diff": settings_diff}


# 新建一次评测记录并立即保存为 running，前端马上就能在列表里看到它和进度。
def start_run(kind, split, suites, special=None):
    commit = git_commit()
    config = {"split": split, "suites": list(suites)}
    # 专项评测：要跑的专项（编号和名称）以及多轮对话是否对比记忆参数。
    if special is not None:
        config["special"] = special
    run = {"id": new_run_id(commit), "kind": kind, "status": "running", "created": now(), "finished": None,
        "commit": commit, "config": config, "summary": None,
        "progress": {"done": 0, "total": 0}, "error": None}
    save_run(run)
    return run


# 生成评测和线上一样先做检索充分性判断（可能补充检索或拒答），再生成回答；
# 检索指标仍按第一次检索计算，判断结论和最终来源数单独记在 sufficiency 里，便于看它挡掉了哪些题。
# 返回给 run_retrieval 的逐题回调，专项评测集的「回答」方式也用它。
def answer_hook(store, models, responder, run_id):
    def on_item(item, row, retrieval):
        check = DocumentSearchTool().check_sufficiency(store, models, EVAL_OWNER, row["queries"],
            row["rerank_query"], retrieval)
        coverage = {"verdict": check["verdict"], "missing": check["missing"]} if check["checked"] else None
        sources = check["sources"]
        answer = answer_question(models, responder, run_id, item, row["rerank_query"], sources, coverage)
        row["answer"] = answer
        row["cited"] = cited_ids(answer)
        row["sufficiency"] = {"checked": check["checked"], "verdict": check["verdict"],
            "missing": check["missing"], "retried": check["retried"], "retry_query": check["retry_query"], "retry_used": check.get("retry_used", False),
            "refused": check["refused"], "source_count": len(sources)}
        row["judgement"] = judge_answer(models, item, answer, sources)
    return on_item


# 执行一次评测并把结果写回同一个文件。generate=True 时在检索之后继续生成回答并请大模型评审。
# 任何异常都记录到结果里再抛出，避免界面上永远显示"运行中"。
def execute_run(store, models, items, run, generate=False, responder=None):
    last_saved = [0.0]

    # 进度最多每秒写一次文件，逐题写入会让慢速磁盘上的评测明显变慢。
    def on_progress(done, total):
        run["progress"] = {"done": done, "total": total}
        current = datetime.now().timestamp()
        if current - last_saved[0] >= 1 or done == total:
            last_saved[0] = current
            save_run(run)

    on_item = answer_hook(store, models, responder, run["id"]) if generate else None

    try:
        # 专项评测：每个专项按自己的评测方式跑，结果分开（见 app/evaluation/suites.py）。
        if run["kind"] == "special":
            from .suites import run_special
            run_special(store, models, run, on_progress, responder)
            run["status"] = "completed"
            return run
        split = run["config"]["split"]
        suites = run["config"]["suites"]
        result = run_retrieval(store, models, items, split, suites, on_progress, on_item)
        run.update(result)
        if generate:
            generation = summarize_generation(result["questions"])
            run["summary"].update(generation)
            for question_type in QUESTION_TYPES:
                selected = []
                for row in result["questions"]:
                    if row["type"] == question_type:
                        selected.append(row)
                if selected:
                    run["by_type"][question_type].update(summarize_generation(selected))
        run["config"]["suites"] = suites
        run["status"] = "completed"
    except Exception as error:
        run["status"] = "failed"
        run["error"] = f"{type(error).__name__}: {error}"[:500]
        raise
    finally:
        run["finished"] = now()
        save_run(run)
    return run
