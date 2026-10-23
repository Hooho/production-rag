# 评测里的固定流程：和线上检索部分一致，改写 → 第一次检索 → 充分性判断 → 补充检索（→ 资料不足时清空来源）。
# 线上这几步在 app/agent/service.py（identify_intent、retrieve_documents、check_sufficiency），
# 这里直接调用同样的函数（Models.analyze_query、DocumentSearchTool.execute / check_sufficiency），不另写一套，
# 线上改了评测自动跟上。范围只到"交给大模型写答案之前"：输入检查、记忆、分流、组装上下文不在评测里。
#
# 以前评测不调用改写模型，按规则用原问题检索（结果稳定），但和线上不一样，和 Agent（检索词是大模型自己写的）比也不公平。
# 改写结果每次可能不同，所以按"题目 + 追问历史 + 意图提示词版本 + 模型"缓存（eval_query_cache 表），
# 同样的键直接复用，两次评测的第一次检索可以直接比；改了提示词或换了模型自动重新改写。
import hashlib
import json
import time

from sqlalchemy import select

from .. import prompts
from ..models import Models
from ..mysql.store import eval_query_cache
from .dataset import now_text


def item_history(item):
    return [{"question": question} for question in item.get("history", [])]


# 缓存键：题目、追问历史、意图提示词版本、模型、意图识别方式（小模型优先时走到大模型这一步的题不同）。
def rewrite_key(question, history, prompt_tag, model, intent_mode):
    raw = json.dumps([question, history, prompt_tag, model, intent_mode], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def rewrite_view(analysis, question):
    return {"queries": list(analysis.get("queries") or [question]),
        "standalone_query": analysis.get("standalone_query") or question,
        "route": analysis.get("route"), "intent": analysis.get("intent"),
        "classifier": analysis.get("classifier") or "fallback"}


# 改写一道题：和线上意图识别同一个函数（规则 → 本地小模型 → 大模型 → 规则兜底），只取检索词和补全后的问题；
# 分流结果（route）只记录，不影响检索（评测题都是知识题）。
# 返回 queries、standalone_query、route、intent、classifier、cached（是否用了缓存）、duration_ms、prompt_tag。
# refresh=True 时不读缓存，重新改写后覆盖缓存（想看改写本身的波动时用）。
def rewrite_item(store, models, item, refresh=False):
    question = item["question"]
    history = item_history(item)
    prompt_tag = prompts.tag("intent")
    use_cache = models.mode == "openai"
    key = rewrite_key(question, history, prompt_tag, models.llm_model, models.intent_mode) if use_cache else None
    if use_cache and not refresh:
        with store.engine.connect() as connection:
            row = connection.execute(select(eval_query_cache).where(eval_query_cache.c.cache_key == key)).mappings().first()
        if row is not None:
            return {**row["data"], "cached": True, "duration_ms": row["duration_ms"], "prompt_tag": prompt_tag}
    started = time.monotonic()
    try:
        analysis = models.analyze_query(question, history, None)
    except Exception:  # 意图识别出错时线上也会退回规则，评测不因此中断
        analysis = Models.fallback_query(question, history, None)
    duration_ms = round((time.monotonic() - started) * 1000)
    view = rewrite_view(analysis, question)
    # 只缓存大模型的改写：规则和小模型本来就稳定；大模型调用失败退回规则的也不缓存，下次再试。
    if use_cache and view["classifier"] == "llm":
        with store.engine.begin() as connection:
            connection.execute(eval_query_cache.delete().where(eval_query_cache.c.cache_key == key))
            connection.execute(eval_query_cache.insert().values(cache_key=key, question=question, prompt_tag=prompt_tag,
                model=models.llm_model, data=view, duration_ms=duration_ms, created=now_text()))
    return {**view, "cached": False, "duration_ms": duration_ms, "prompt_tag": prompt_tag}


# 一次检索交给模型的分片：每个来源经过父块扩展拼进了相邻分片，都算"交给模型了"。
def given_chunk_ids(sources):
    ids = []
    for source in sources or []:
        for chunk_id in source.get("parent_chunk_ids") or [source.get("chunk_id")]:
            if chunk_id is not None and str(chunk_id) not in ids:
                ids.append(str(chunk_id))
    return ids


SOURCE_FIELDS = ("id", "title", "heading", "text", "chunk_id", "position", "parent_chunk_ids", "relevance")


def slim_sources(sources):
    return [{key: source.get(key) for key in SOURCE_FIELDS} for source in sources or []]


# 把充分性判断（和可能的补充检索）的结果记到评测行上，并按最终交给模型的资料重算命中：
#   first_given_recall：第一次检索交给模型的资料命中率；
#   given_recall：判断之后最终交给模型的资料命中率（用了补充检索就按补充的算，被清空就是 0）。
# 漏斗、阈值扫描等调参指标仍只看第一次检索（stages），这里不改。
# found(sources) 返回这批来源里找到的证据序号集合；first_sources 是第一次检索的来源。
def apply_sufficiency(row, check, found, first_sources, evidence_count, keep_sources):
    first = found(first_sources)
    final = found(check["sources"])
    row["first_given_recall"] = row.get("given_recall")
    row["given_recall"] = len(final) / evidence_count if evidence_count else None
    for index, entry in enumerate(row.get("evidence") or []):
        entry["first_given"] = index in first
        entry["given"] = index in final
    judgements = [{"verdict": item["verdict"], "missing": item.get("missing", ""), "rewrite_query": item.get("rewrite_query", "")}
        for item in check["judgements"]]
    row["sufficiency"] = {"checked": check["checked"], "verdict": check["verdict"], "missing": check["missing"],
        "judgements": judgements, "calls": len(judgements), "retried": check["retried"],
        "retry_query": check["retry_query"], "retry_used": check.get("retry_used", False),
        "refused": check["refused"], "source_count": len(check["sources"])}
    if check["retried"]:
        retry = check["retry_retrieval"]
        retry_found = found(retry["sources"])
        row["retry"] = {"returned": len(retry["sources"]), "used": check.get("retry_used", False),
            "given_recall": len(retry_found) / evidence_count if evidence_count else None,
            "found": sorted(retry_found)}
        if keep_sources:
            row["retry"]["sources"] = slim_sources(retry["sources"])
    row["cleared"] = bool(check["refused"])
