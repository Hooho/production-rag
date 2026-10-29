"""Agent 检索评测：同一套调参题让 Agent 跑一遍，看它最后拿到的资料里有没有题目预设的证据（最后命中）。

固定流程的检索评测分三个阶段算命中（候选池 / 重排 / 过滤后），用来调检索参数；
Agent 每道题可能检索好几次、每次的查询词和参数都由它自己定，没有统一的排名，所以只算一个“最后命中”：
把它所有 search_knowledge 返回的分片和 read_context 读到的分片合在一起，用和固定流程同样的方法
（evidence_hits：汇总题匹配目标分片 ID，旧题匹配证据原文）判断证据有没有拿到。
口径和固定流程的“交给模型的资料命中率”（recall_given）一致，都算父块扩展拼进来的相邻分片
（检索返回的每条资料是一个父块，正文里拼进了前后几片，模型看得到）；Agent 另外加上 read_context 读到的分片。
（2026-10-24 前只算命中的那一个分片，前后文类的题对固定流程不公平：答案在相邻分片、已经拼进父块交给了模型，却算没拿到。）

评测页可以勾选只跑固定流程、只跑 Agent 或两个一起跑：
- 只跑固定流程：不经过这里，和原来完全一样；
- 一起跑：固定流程照常跑全套（漏斗、阈值扫描、实验组都有），每道题跑完固定流程后接着跑 Agent，结果存在同一行的 agent 里，
  汇总里加上 agent_ 开头的指标和逐题对比的分类（两边都命中 / 只有固定流程命中 / 只有 Agent 命中 / 都没命中）；
- 只跑 Agent：每道题只有基本信息和 agent。

Agent 只评检索，不评答案：答案照样生成（没法让它只检索不回答），只保存前一段供查看。
每道题用独立的新会话，不写 runs、不写会话记忆和长期记忆（这些写入都在 API 层，这里直接调用 AgentMode.run）。
"""

import json
import time
from uuid import uuid4

from .grouped_evidence import evidence_fields
from ..agentic.query_explanation import query_explanation
from .. import prompts
from ..runtime_config import snapshot as runtime_snapshot
from .dataset import QUESTION_TYPES, select_split
from sqlalchemy import select

from ..mysql.store import document_chunks, document_heads
from .retrieval import (
    EVAL_OWNER,
    current_chunk_texts,
    evidence_hits,
    import_corpus,
    material,
    material_summary,
    mean,
    percentile,
    plan_queries,
    run_retrieval,
    scoring_item,
)

FORCED = {"budget", "timeout"}
ANSWER_LIMIT = 1000


def parse_arguments(raw):
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {"raw": str(raw)[:300]}
    return value if isinstance(value, dict) else {"raw": str(raw)[:300]}


# 评测语料当前版本里每个分块在文档里的序号（从 0 开始，页面显示成「第 N 片」，和知识库页面一致）。
# S1、S2 只是某一次检索返回结果的顺序编号，每次检索都从 S1 开始；「第 N 片」才是分块固定的编号。
def chunk_positions(store):
    joined = document_heads.join(
        document_chunks,
        document_chunks.c.document_id == document_heads.c.current_document_id,
    )
    with store.engine.connect() as connection:
        rows = connection.execute(
            select(document_chunks.c.chunk_id, document_chunks.c.position)
            .select_from(joined)
            .where(document_heads.c.owner == EVAL_OWNER)
        ).all()
    return {str(chunk_id): position for chunk_id, position in rows}


# 一组分片各自包含哪几条证据（证据序号）。
def chunk_hits(chunk_ids, evidence, chunk_texts):
    hits = evidence_hits(
        [{"chunk_id": str(chunk_id)} for chunk_id in chunk_ids], evidence, chunk_texts
    )
    return {chunk_id: hits.get(str(chunk_id), []) for chunk_id in chunk_ids}


# 把一次工具调用整理成检索日志的一条：参数、状态、返回了哪些资料、每条资料命中了哪几条证据。
# 候选诊断保留排名、分数、过滤去向和正文摘要；不把候选计入交付或命中。
def call_log(number, round_no, call, evidence, chunk_texts):
    name = call.get("name") or ""
    trace = call.get("trace") or {}
    entry = {
        "call": number,
        "round": round_no,
        "name": name,
        "arguments": parse_arguments(call.get("arguments")),
        "status": call.get("status"),
        "duration_ms": call.get("duration_ms"),
        "chunk_ids": [],
        "hits": [],
        "full_text": True,
    }
    try:
        explanation = query_explanation(entry["arguments"])
    except ValueError:
        explanation = None
    if explanation:
        entry["query_explanation"] = explanation
    if call.get("status") not in ("ok", "error"):
        # duplicate（和之前的调用完全相同，没有执行）、skipped（预算用完）：只记状态和给模型的说明。
        entry["note"] = (call.get("content") or "")[:200]
        return entry
    if name == "search_knowledge" and "retrieval" in trace:
        sources = (trace.get("retrieval") or {}).get("sources") or []
        sources = sources[: trace.get("top_k") or len(sources)]
        diagnostics = (trace.get("retrieval") or {}).get("diagnostics")
        candidates = {
            str(row["chunk_id"]): row
            for row in (diagnostics or {}).get("candidates", [])
        }
        if diagnostics is not None:
            delivered = {
                str(chunk_id)
                for source in sources
                for chunk_id in (
                    source.get("parent_chunk_ids") or [source.get("chunk_id")]
                )
                if chunk_id is not None
            }
            entry["retrieval_diagnostics"] = {
                **diagnostics,
                "candidates": [
                    {
                        **candidate,
                        "hits": chunk_hits(
                            [str(candidate["chunk_id"])], evidence, chunk_texts
                        )[str(candidate["chunk_id"])],
                        "agent_status": "beyond_top_k"
                        if candidate.get("status") == "returned"
                        and str(candidate["chunk_id"]) not in delivered
                        else candidate.get("status"),
                    }
                    for candidate in diagnostics.get("candidates", [])
                ],
            }
            entry["retrieval_stats"] = (trace.get("retrieval") or {}).get("stats") or {}
        ids = []
        results = []
        for evidence_id, source in zip(trace.get("evidence_ids") or [], sources):
            # 每条资料是一个父块：命中的分片加上拼进来的相邻分片，都算这条资料给出的分片。
            parts = [
                str(chunk_id)
                for chunk_id in (
                    source.get("parent_chunk_ids") or [source.get("chunk_id")]
                )
                if chunk_id is not None
            ]
            part_hits = chunk_hits(parts, evidence, chunk_texts)
            # 检索命中的那一片本身含哪几条证据；不在这里、只在拼进来的相邻分片里的，算扩展命中。
            main = (
                str(source.get("chunk_id"))
                if source.get("chunk_id") is not None
                else None
            )
            main_hits = (
                part_hits.get(main, [])
                if main in part_hits
                else (chunk_hits([main], evidence, chunk_texts)[main] if main else [])
            )
            ids.extend(chunk_id for chunk_id in parts if chunk_id not in ids)
            candidate = candidates.get(main, {})
            ranks = {
                method: min(
                    (
                        part["rank"]
                        for part in candidate.get("contributions", [])
                        if part["method"] == method
                    ),
                    default=None,
                )
                for method in ("dense", "keyword")
            }
            results.append(
                {
                    "vector_rank": ranks["dense"],
                    "keyword_rank": ranks["keyword"],
                    "retrieval_recorded": diagnostics is not None,
                    "rerank_score": candidate.get("rerank_probability"),
                    "evidence_id": evidence_id,
                    "title": source.get("title"),
                    "heading": source.get("heading"),
                    "chunk_id": source.get("chunk_id"),
                    "position": source.get("position"),
                    "parent_chunk_ids": parts,
                    "relevance": source.get("relevance"),
                    "low_relevance": bool(source.get("low_relevance")),
                    "text": (source.get("text") or ""),
                    "hits": sorted(
                        {index for indexes in part_hits.values() for index in indexes}
                    ),
                    "main_hits": sorted(main_hits),
                }
            )
        entry.update(
            query=trace.get("query"),
            mode=trace.get("mode"),
            top_k=trace.get("top_k"),
            results=results,
            chunk_ids=ids,
        )
    elif name == "read_context":
        ids = list(trace.get("chunk_ids") or [])
        hits = chunk_hits(ids, evidence, chunk_texts)
        entry.update(
            source_id=trace.get("source_id"),
            direction=trace.get("direction"),
            chunk_ids=ids,
            positions=list(trace.get("positions") or []),
            text=(call.get("content") or ""),
        )
        entry["read_hits"] = sorted(
            {index for values in hits.values() for index in values}
        )
    else:
        entry["note"] = (call.get("content") or "")[:200]
    if call.get("status") == "error":
        entry["error"] = str(trace.get("error") or call.get("content") or "")[:300]
    found = set()
    for chunk_id in entry["chunk_ids"]:
        found.update(chunk_hits([chunk_id], evidence, chunk_texts)[chunk_id])
    entry["hits"] = sorted(found)
    return entry


# Agent 跑一道题，返回这道题的 agent 部分。
def evaluate_agent(agent_mode, store, models, item, chunk_texts, positions=None):
    item = scoring_item(store, item)
    evidence = item.get("evidence") or []
    # 多轮追问题和固定流程一样，用规则补全后的完整问题（评测没有真实的上一轮对话）。
    _, question, _ = plan_queries(item)
    started = time.monotonic()
    row = {"question_sent": question, "status": "completed", "error": None}
    try:
        result = agent_mode.run(
            store, models, EVAL_OWNER, f"eval-{uuid4()}", question, [], None
        )
        outcome = result.get("agent") or {}
        answer = result.get("answer") or ""
    except Exception as error:  # noqa: BLE001  一道题失败不影响其他题，记下原因
        outcome = getattr(error, "outcome", None) or {}
        answer = ""
        row.update(status="failed", error=f"{type(error).__name__}: {str(error)[:300]}")
    row["latency_ms"] = round((time.monotonic() - started) * 1000)
    # 交给模型的资料：资料池里的全部资料（每次检索留下的累加，同一分片只算一次）。
    row["material"] = material(outcome.get("sources") or [])
    # 检索耗时：发起了工具调用的那几轮（模型想查什么 + 执行检索），到最后一次检索结束为止；
    # 剩下的是写回答（含强制回答、引用重写），和固定流程的「完整检索耗时」一样不算回答。
    tool_rounds = [
        record for record in outcome.get("rounds") or [] if record.get("tool_results")
    ]
    row["search_ms"] = sum(record.get("duration_ms") or 0 for record in tool_rounds)
    row["answer_ms"] = max(0, row["latency_ms"] - row["search_ms"])
    calls = []
    for record in outcome.get("rounds") or []:
        for call in record.get("tool_results") or []:
            calls.append(
                call_log(
                    len(calls) + 1, record.get("round"), call, evidence, chunk_texts
                )
            )
    found = set()
    where = {index: [] for index in range(len(evidence))}
    for entry in calls:
        found.update(entry["hits"])
        for source in entry.get("results") or []:
            for index in source["hits"]:
                where[index].append(
                    {"call": entry["call"], "evidence_id": source["evidence_id"]}
                )
        for index in entry.get("read_hits") or []:
            where[index].append(
                {"call": entry["call"], "evidence_id": entry.get("source_id")}
            )
    # 每条证据是怎么拿到的：direct 检索命中的那一片就含证据；extension 只在父块扩展拼进来的分片里；
    # context 只靠读前后文拿到。同一条证据有多种拿法时取最直接的（direct > extension > context）。
    via = {}
    rank = {"direct": 0, "extension": 1, "context": 2}
    for entry in calls:
        for source in entry.get("results") or []:
            for index in source["hits"]:
                kind = (
                    "direct"
                    if index in (source.get("main_hits") or [])
                    else "extension"
                )
                if index not in via or rank[kind] < rank[via[index]]:
                    via[index] = kind
        for index in entry.get("read_hits") or []:
            via.setdefault(index, "context")
    evidence_chunks = {}
    for chunk_id, indexes in evidence_hits(
        [{"chunk_id": chunk_id} for chunk_id in chunk_texts], evidence, chunk_texts
    ).items():
        for index in indexes:
            evidence_chunks.setdefault(index, []).append(chunk_id)
    # 每次调用新拿到了几个分块（之前的调用没拿到过的）。一次检索一个新分块都没有，就是白查了：
    # 用来看 Agent 是不是在简单题上查得太多（同一批分块反复拿回来）。空检索也算没有新增。
    seen = set()
    for entry in calls:
        fresh = [
            chunk_id
            for chunk_id in dict.fromkeys(entry["chunk_ids"])
            if chunk_id not in seen
        ]
        entry["new_chunks"] = len(fresh)
        seen.update(fresh)
    searches = [
        entry
        for entry in calls
        if entry["name"] == "search_knowledge" and entry["status"] in ("ok", "error")
    ]
    chunks = {chunk_id for entry in calls for chunk_id in entry["chunk_ids"]}
    usage = outcome.get("usage") or {}
    stop_reason = outcome.get("stop_reason")
    if row["status"] == "completed" and outcome.get("status") == "failed":
        row["status"] = "failed"
    row.update(
        {
            "recall": len(found) / len(evidence) if evidence else None,
            # chunk_ids：这条证据在知识库里属于哪个（哪些）分块，和检索结果无关，用来对照两边拿到的分块。
            "evidence": [
                {
                    **evidence_fields(text),
                    "chunk_ids": evidence_chunks.get(index, []),
                    "positions": [
                        (positions or {}).get(str(chunk_id))
                        for chunk_id in evidence_chunks.get(index, [])
                    ],
                    "found": index in found,
                    "where": where[index],
                    "via": via.get(index) if index in found else None,
                }
                for index, text in enumerate(evidence)
            ],
            "found_count": len(found),
            "ext_hits": sum(1 for index in found if via.get(index) == "extension"),
            "context_hits": sum(1 for index in found if via.get(index) == "context"),
            "calls": calls,
            "returned": len(chunks),
            "round_logs": [
                {
                    "round": record.get("round"),
                    "kind": record.get("kind") or "normal",
                    "reasoning": record.get("reasoning") or "",
                    "content": record.get("content") or "",
                    "error": record.get("error"),
                    "duration_ms": record.get("duration_ms"),
                }
                for record in outcome.get("rounds") or []
            ],
            "searches": len(searches),
            "empty_searches": sum(1 for entry in searches if not entry.get("results")),
            "wasted_searches": sum(1 for entry in searches if entry["new_chunks"] == 0),
            "queries": [entry.get("query") for entry in searches],
            "reads": sum(
                1
                for entry in calls
                if entry["name"] == "read_context" and entry["status"] == "ok"
            ),
            "duplicates": sum(1 for entry in calls if entry["status"] == "duplicate"),
            "tool_calls": outcome.get("tool_calls_used") or 0,
            "rounds": len(outcome.get("rounds") or []),
            "stop_reason": stop_reason,
            "forced": stop_reason in FORCED,
            "citation_retried": bool(outcome.get("citation_retried")),
            "prompt_tokens": usage.get("prompt_tokens") or 0,
            "completion_tokens": usage.get("completion_tokens") or 0,
            "cached_tokens": usage.get("cached_tokens") or 0,
            "answer": answer[:ANSWER_LIMIT],
        }
    )
    return row


# 题目的基本信息（只跑 Agent 时没有固定流程的检索结果，逐题行只有这些和 agent）。
def base_row(item):
    return {
        "id": item["id"],
        "question": item["question"],
        "type": item["type"],
        "pair_id": item.get("pair_id"),
        "pair_role": item.get("pair_role"),
        "answerable": bool(item.get("answerable")),
        "evidence_count": len(item.get("evidence") or []),
    }


# Agent 部分的汇总，全部以 agent_ 开头，可以和固定流程的指标放在同一个 summary 里对比。
# 资料命中率只算能回答的题；误杀率 = 能回答的题一条资料都没拿到；漏放率 = 无法回答的题拿到了资料。
def summarize_agent(rows):
    agents = [row["agent"] for row in rows if row.get("agent")]
    answerable = [
        row["agent"] for row in rows if row.get("agent") and row["answerable"]
    ]
    unanswerable = [
        row["agent"] for row in rows if row.get("agent") and not row["answerable"]
    ]
    latencies = [agent["latency_ms"] for agent in agents]
    prompt_tokens = sum(agent["prompt_tokens"] for agent in agents)
    cached = sum(agent["cached_tokens"] for agent in agents)

    def average(key):
        return mean([agent[key] for agent in agents])

    def rate(selected, check):
        return (
            round(sum(1 for agent in selected if check(agent)) / len(selected), 4)
            if selected
            else None
        )

    from .score import agent_item, summarize_scores

    scored = summarize_scores(
        [
            agent_item(row["answerable"], row["agent"])
            for row in rows
            if row.get("agent") and row["agent"]["status"] == "completed"
        ]
    )
    return {
        **material_summary([agent.get("material") for agent in agents], "agent_"),
        "agent_count": len(agents),
        "agent_score": scored["score"],
        "agent_score_bands": scored["score_bands"],
        "agent_recall": mean(
            [agent["recall"] for agent in answerable if agent["recall"] is not None]
        ),
        "agent_false_reject_rate": rate(
            answerable, lambda agent: agent["returned"] == 0
        ),
        # 扩展命中率：拿到的证据里，只在父块扩展拼进来的分片里的比例（旧记录没有 ext_hits 时是 None）。
        "agent_ext_hit_rate": (
            round(
                sum(agent["ext_hits"] for agent in answerable if "ext_hits" in agent)
                / sum(
                    agent["found_count"] for agent in answerable if "ext_hits" in agent
                ),
                4,
            )
            if sum(
                agent.get("found_count", 0)
                for agent in answerable
                if "ext_hits" in agent
            )
            else None
        ),
        # 检索命中率：拿到的证据里去掉父块扩展、读前后文拿到的，只算检索本身命中的（分母是全部证据条数）。
        "agent_direct_recall": (
            round(
                sum(
                    agent["found_count"]
                    - agent["ext_hits"]
                    - agent.get("context_hits", 0)
                    for agent in answerable
                    if "ext_hits" in agent
                )
                / sum(
                    len(agent["evidence"])
                    for agent in answerable
                    if "ext_hits" in agent
                ),
                4,
            )
            if sum(
                len(agent["evidence"]) for agent in answerable if "ext_hits" in agent
            )
            else None
        ),
        "agent_false_accept_rate": rate(
            unanswerable, lambda agent: agent["returned"] > 0
        ),
        "agent_avg_searches": average("searches"),
        "agent_avg_empty_searches": average("empty_searches"),
        # 无新增检索：一个新分块都没拿到的检索。比例 = 无新增检索次数 / 全部检索次数，越低越好。
        "agent_avg_wasted_searches": mean(
            [agent.get("wasted_searches", 0) for agent in agents]
        ),
        "agent_wasted_searches": sum(
            agent.get("wasted_searches", 0) for agent in agents
        ),
        "agent_wasted_rate": (
            round(
                sum(agent.get("wasted_searches", 0) for agent in agents)
                / sum(agent["searches"] for agent in agents),
                4,
            )
            if sum(agent["searches"] for agent in agents)
            else None
        ),
        "agent_avg_reads": average("reads"),
        "agent_avg_tool_calls": average("tool_calls"),
        "agent_avg_rounds": average("rounds"),
        "agent_duplicates": sum(agent["duplicates"] for agent in agents),
        "agent_forced": sum(1 for agent in agents if agent["forced"]),
        "agent_citation_retried": sum(
            1 for agent in agents if agent["citation_retried"]
        ),
        "agent_failed": sum(1 for agent in agents if agent["status"] != "completed"),
        "agent_avg_prompt_tokens": average("prompt_tokens"),
        "agent_avg_completion_tokens": average("completion_tokens"),
        "agent_cache_hit_rate": round(cached / prompt_tokens, 4)
        if prompt_tokens
        else None,
        "agent_latency_avg_ms": round(sum(latencies) / len(latencies))
        if latencies
        else None,
        # 只算检索（不含写回答），和固定流程的完整检索耗时可以直接比；旧记录没有 search_ms 时是 None。
        "agent_search_latency_avg_ms": mean(
            [agent["search_ms"] for agent in agents if "search_ms" in agent]
        ),
        "agent_answer_latency_avg_ms": mean(
            [agent["answer_ms"] for agent in agents if "answer_ms" in agent]
        ),
        "agent_latency_p95_ms": percentile(latencies, 0.95),
    }


# 一起跑时的逐题分类：能回答的题里，证据全部拿到算“命中”。
def compare_rows(rows):
    counts = {"both": 0, "fixed_only": 0, "agent_only": 0, "neither": 0}
    for row in rows:
        if not row["answerable"] or not row.get("agent") or "stages" not in row:
            continue
        fixed = (
            row.get("given_recall")
            if row.get("given_recall") is not None
            else row["stages"]["final"]["recall"]
        ) == 1
        agent = row["agent"]["recall"] == 1
        key = (
            "both"
            if fixed and agent
            else "fixed_only"
            if fixed
            else "agent_only"
            if agent
            else "neither"
        )
        row["compare"] = key
        counts[key] += 1
    return counts


def agent_config(models):
    settings = runtime_snapshot()
    return {
        "tool_budget": settings["agent_tool_budget"],
        "timeout": settings["agent_timeout"],
        "rerank_min_score": settings["agent_rerank_min_score"],
        "prompt_version": prompts.tag("agent"),
        "model": getattr(models, "llm_model", None),
        # 提示词内容的指纹：改了内置提示词时版本号仍是「内置」，靠它区分前后两次用的是不是同一段提示词。
        "prompt_identity": prompts.identity("agent"),
    }


# 运行 Agent 检索评测。with_fixed=True 时固定流程照常跑全套，Agent 接在每道基线题后面跑。
def run_agent_retrieval(
    store,
    models,
    agent_mode,
    items,
    split,
    suites=(),
    with_fixed=True,
    on_progress=None,
):
    state = {}

    def texts():
        if "chunk_texts" not in state:
            state["chunk_texts"] = current_chunk_texts(store)
            state["positions"] = chunk_positions(store)
        return state["chunk_texts"]

    if with_fixed:
        # 固定流程的语料导入在 run_retrieval 一开始，基线题的回调一定在它之后，这时读分片原文是新的。
        def on_item(item, row, retrieval):
            row["agent"] = evaluate_agent(
                agent_mode, store, models, item, texts(), state["positions"]
            )

        result = run_retrieval(
            store, models, items, split, suites, on_progress, on_item
        )
        rows = result["questions"]
        result["comparison"] = compare_rows(rows)
    else:
        corpus = import_corpus(store, models)
        selected = select_split(items, split)
        rows = []
        for index, item in enumerate(selected, start=1):
            row = base_row(item)
            row["agent"] = evaluate_agent(
                agent_mode, store, models, item, texts(), state["positions"]
            )
            rows.append(row)
            if on_progress:
                on_progress(index, len(selected))
        settings = runtime_snapshot()
        result = {
            "config": {
                "split": split,
                "dataset_size": len(selected),
                "suites": [],
                "corpus": corpus,
                "model_mode": models.mode,
                "embedding_model": models.embedding_model,
                "rerank_model": models.rerank_model,
                "return_limit": settings["return_limit"],
                "settings": settings,
            },
            "summary": {
                "count": len(rows),
                "answerable_count": sum(1 for row in rows if row["answerable"]),
                "unanswerable_count": sum(1 for row in rows if not row["answerable"]),
            },
            "by_type": {},
            "questions": rows,
        }
    result["config"]["agent"] = agent_config(models)
    result["summary"].update(summarize_agent(rows))
    for question_type in QUESTION_TYPES:
        selected = [row for row in rows if row["type"] == question_type]
        if selected:
            result["by_type"].setdefault(question_type, {}).update(
                summarize_agent(selected)
            )
    return result
