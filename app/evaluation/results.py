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
    # 交给回答模型的资料（含父块扩展拼进来的相邻分片）里的证据比例；和 Agent 资料命中率口径一致。
    # 固定流程现在和线上一样做充分性判断和补充检索（见 app/evaluation/flow.py），这是判断之后最终交给模型的。
    # 得分：每题满分 100，没拿全最高 90，一条没找到按证据条数扣分（规则见 score.py），取所有题平均。
    ("score", "固定流程得分", "higher"),
    ("recall_given", "固定流程资料命中率", "higher"),
    ("recall_given_first", "第一次检索交给模型的资料命中率", "higher"),
    ("rescued_count", "补充检索救回的题数", "higher"),
    ("wrong_clear_rate", "误清空率（有答案被清空）", "lower"),
    ("right_clear_rate", "正确清空率（无答案被清空）", "higher"),
    ("retry_rate", "补充检索比例", "lower"),
    ("avg_judge_calls", "平均充分性判断次数", "lower"),
    ("flow_latency_avg_ms", "完整检索平均耗时（毫秒）", "lower"),
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
    # Agent 检索评测（勾选了 Agent 时才有）：只有“最后命中”，口径和固定流程的过滤后 Recall 一致。
    ("agent_score", "Agent 得分", "higher"),
    ("agent_recall", "Agent 资料命中率", "higher"),
    ("agent_false_reject_rate", "Agent 误杀率", "lower"),
    ("agent_false_accept_rate", "Agent 漏放率", "lower"),
    ("agent_avg_tool_calls", "Agent 平均工具调用次数", "lower"),
    ("agent_wasted_rate", "Agent 无新增检索比例", "lower"),
    ("agent_avg_prompt_tokens", "Agent 平均输入 token", "lower"),
    ("agent_search_latency_avg_ms", "Agent 平均检索耗时（毫秒，不含写回答）", "lower"),
    ("agent_latency_avg_ms", "Agent 平均耗时（毫秒）", "lower"),
]
MODES = ("fixed", "agent")


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
    # 只跑 Agent 的评测没有固定流程的分阶段结果，这组说明用不上。
    if questions and "stages" not in questions[0]:
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
    # 最后交给模型的资料（固定流程，含补充检索、被清空算 0）、Agent 拿到的资料里各有几条证据，被清空的有答案题数。
    # 旧记录没有这些字段时是 None，前端退回只写比例的说明。
    given_hits = agent_hits = cleared_questions = ext_hits = None

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
            if question.get("given_recall") is not None:
                given_hits = (given_hits or 0) + int(question["given_recall"] * evidence_count + 0.5)
            agent = question.get("agent") or {}
            if agent.get("recall") is not None:
                agent_hits = (agent_hits or 0) + int(agent["recall"] * evidence_count + 0.5)
            if "ext_hits" in question:
                ext_hits = (ext_hits or 0) + question["ext_hits"]
            if "cleared" in question:
                cleared_questions = (cleared_questions or 0) + bool(question.get("cleared"))
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
        "given_hits": given_hits,
        "agent_hits": agent_hits,
        "cleared_questions": cleared_questions,
        "ext_hits": ext_hits,
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
        # 跑的模式不同（只跑固定流程 / 只跑 Agent / 一起跑）时指标不完全相同，不自动对比。
        if run_modes(candidate) != run_modes(run):
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
    # 跑的模式、Agent 提示词版本和模型不在设置页参数里，单独比较：改提示词后对比评测，最需要看到这一项。
    base_config = base.get("config") or {}
    target_config = target.get("config") or {}
    # 检索口径：旧记录（没有 flow）是规则检索词、只检索；新记录是改写 + 检索 + 充分性判断 + 补充检索。
    base_flow = flow_label(base_config)
    target_flow = flow_label(target_config)
    if base_flow and target_flow and base_flow != target_flow:
        settings_diff.append({"key": "检索口径", "base": base_flow, "target": target_flow})
    for key, label in (("intent_prompt", "意图（改写）提示词版本"), ("model", "改写模型"), ("sufficiency", "充分性判断")):
        before = (base_config.get("flow") or {}).get(key)
        after = (target_config.get("flow") or {}).get(key)
        if before is not None and after is not None and before != after:
            settings_diff.append({"key": label, "base": before, "target": after})
    # 评测语料不同（勾的语料不一样，或者同名语料内容改过）：分数变化可能来自语料。旧记录没有这一项，不比较。
    base_corpus = base_config.get("corpus")
    target_corpus = target_config.get("corpus")
    if base_corpus is not None and target_corpus is not None and corpus_signature(base_corpus) != corpus_signature(target_corpus):
        settings_diff.append({"key": "评测语料", "base": corpus_label(base_corpus, target_corpus),
            "target": corpus_label(target_corpus, base_corpus)})
    if run_modes(base) != run_modes(target):
        settings_diff.append({"key": "模式", "base": "+".join(run_modes(base)), "target": "+".join(run_modes(target))})
    base_agent = base_config.get("agent") or {}
    target_agent = target_config.get("agent") or {}
    if base_agent and target_agent:
        for key, label in (("prompt_version", "Agent 提示词版本"), ("prompt_identity", "Agent 提示词内容"), ("model", "Agent 模型")):
            if key == "prompt_identity" and (base_agent.get("prompt_version") != target_agent.get("prompt_version")
                    or not base_agent.get(key) or not target_agent.get(key)):
                continue  # 版本号已经不同（内容当然不同）或旧记录没有指纹时不列
            if base_agent.get(key) != target_agent.get(key):
                settings_diff.append({"key": label, "base": base_agent.get(key), "target": target_agent.get(key)})
    return {"base": run_brief(base), "target": run_brief(target), "metrics": rows, "settings_diff": settings_diff}


def corpus_signature(corpus):
    return sorted((item["title"], item.get("sha256")) for item in corpus)


# 语料列表的显示：标题用顿号连起来；对方也有同名语料、但内容不同的标"（内容不同）"。
def corpus_label(corpus, other):
    other_sha = {item["title"]: item.get("sha256") for item in other}
    names = []
    for item in sorted(corpus, key=lambda entry: entry["title"]):
        changed = item["title"] in other_sha and other_sha[item["title"]] != item.get("sha256")
        names.append(f"《{item['title']}》" + ("（内容不同）" if changed else ""))
    return "、".join(names) or "（无）"


# 固定流程的检索口径（只有跑了固定流程才有意义）。
def flow_label(config):
    if "fixed" not in (config.get("modes") or ["fixed"]):
        return None
    return "完整检索（改写 + 判断）" if (config.get("flow") or {}).get("name") == "full" else "只检索（规则检索词）"


# 这次评测跑了哪些模式；旧记录没有这一项，都是只跑固定流程。
def run_modes(run):
    return list((run.get("config") or {}).get("modes") or ["fixed"])


# 新建一次评测记录并立即保存为 running，前端马上就能在列表里看到它和进度。
# modes：检索评测跑哪些模式（fixed 固定流程、agent），可以只跑一个，也可以一起跑。
# corpus：这次用的评测语料（编号、标题、内容指纹），见 app/evaluation/corpus.py。
def start_run(kind, split, suites, special=None, modes=("fixed",), corpus=None):
    commit = git_commit()
    config = {"split": split, "suites": list(suites), "modes": [mode for mode in MODES if mode in modes]}
    if corpus is not None:
        config["corpus"] = list(corpus)
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
        # 检索评测已经按线上流程判断过（evaluate_items 的 judge）就直接用，不再判断一次。
        check = retrieval.get("sufficiency_check") or DocumentSearchTool().check_sufficiency(store, models, EVAL_OWNER,
            row["queries"], row["rerank_query"], retrieval)
        coverage = {"verdict": check["verdict"], "missing": check["missing"]} if check["checked"] else None
        sources = check["sources"]
        answer = answer_question(models, responder, run_id, item, row["rerank_query"], sources, coverage)
        row["answer"] = answer
        row["cited"] = cited_ids(answer)
        row["sufficiency"] = row.get("sufficiency") or {"checked": check["checked"], "verdict": check["verdict"],
            "missing": check["missing"], "retried": check["retried"], "retry_query": check["retry_query"], "retry_used": check.get("retry_used", False),
            "refused": check["refused"], "source_count": len(sources)}
        row["judgement"] = judge_answer(models, item, answer, sources)
    return on_item


# 执行一次评测并把结果写回同一个文件。generate=True 时在检索之后继续生成回答并请大模型评审。
# 任何异常都记录到结果里再抛出，避免界面上永远显示"运行中"。
def execute_run(store, models, items, run, generate=False, responder=None, agent_mode=None):
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
            run_special(store, models, run, on_progress, responder, agent_mode)
            run["status"] = "completed"
            return run
        split = run["config"]["split"]
        suites = run["config"]["suites"]
        modes = run_modes(run)
        if "agent" in modes:
            # 勾选了 Agent：只跑 Agent，或者和固定流程一起跑（见 app/evaluation/agent_retrieval.py）。
            from .agent_retrieval import run_agent_retrieval
            result = run_agent_retrieval(store, models, agent_mode, items, split, suites, "fixed" in modes, on_progress)
        else:
            result = run_retrieval(store, models, items, split, suites, on_progress, on_item)
        result["config"]["modes"] = modes
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
