# 线上问答的追踪摘要与用户反馈。
# runs.response 里已经保存了完整的阶段记录和检索诊断，但它是一大块 JSON，只适合逐条查看；
# 这里从中提取一份固定结构的摘要，单独存进 runs 的几个字段，才能按"拒答了吗、多慢、最高分多少"筛选和统计。

# 回答阶段的固定拒答文本，与生成评测的判定保持一致。
FIXED_REFUSALS = ("知识库中没有足够资料", "模型没有返回可校验的引用")

# 用户点踩时可选的原因，对应坏例排查时最常见的几类问题。
FEEDBACK_REASONS = {
    "wrong": "答错了",
    "incomplete": "没答全",
    "missed": "资料里有却说找不到",
    "citation": "引用不对",
    "other": "其他",
}

# 摘要里最多保留的候选数量：只存编号和分数，排查时按编号回查原文。
TRACE_CANDIDATES = 10


# 判断回答是否为固定拒答；模型自己措辞的拒答无法可靠识别，留给反馈和抽样评审发现。
def is_refusal(answer):
    for text in FIXED_REFUSALS:
        if text in (answer or ""):
            return True
    return False


# 从 Agent 返回结果中提取追踪摘要：各阶段耗时、改写结果、检索候选的编号与分数、模型、Token 用量。
def summarize_run(result):
    steps = {}
    for step in result.get("steps", []):
        steps[step["id"]] = step
    stage_ms = {}
    for step_id, step in steps.items():
        if step.get("duration_ms") is not None:
            stage_ms[step_id] = step["duration_ms"]
    complete = steps.get("complete", {}).get("result", {})
    summary = {
        "route": result.get("route"),
        "refused": result.get("route") == "knowledge" and is_refusal(result.get("answer")),
        "duration_ms": complete.get("total_duration_ms"),
        "stage_ms": stage_ms,
        "model_mode": result.get("model_mode"),
    }
    intent = steps.get("intent", {}).get("result", {})
    if intent:
        summary["intent"] = {"intent": intent.get("intent"), "classifier": intent.get("classifier"),
            "confidence": intent.get("confidence"), "path": intent_path(intent)}
    query = steps.get("query", {}).get("result", {})
    if query:
        summary["rewrite"] = {"standalone_query": query.get("standalone_query"),
            "queries": query.get("queries", [])}
    retrieval = steps.get("retrieval", {}).get("result", {})
    if retrieval:
        summary["retrieval"] = summarize_retrieval(retrieval)
    # 充分性判断认为资料不足或只能回答一部分时会补充检索一次，两次检索分开记录。
    retry = steps.get("retrieval_retry", {}).get("result", {})
    if retry:
        summary["retrieval_retry"] = summarize_retrieval(retry)
    sufficiency = steps.get("sufficiency", {}).get("result", {})
    if sufficiency:
        summary["sufficiency"] = {"checked": sufficiency.get("checked"), "verdict": sufficiency.get("verdict"),
            "retried": sufficiency.get("retried"), "retry_query": sufficiency.get("retry_query"), "retry_used": sufficiency.get("retry_used"),
            "refused": sufficiency.get("refused"), "missing": sufficiency.get("missing")}
    # 注入防护的结果：问题是否被拦截、来源清理了几条、回答处理了哪些问题，便于统计攻击和误拦。
    input_guard = steps.get("input_guard", {}).get("result", {})
    output_guard = steps.get("output_guard", {}).get("result", {})
    summary["security"] = {"blocked": bool(input_guard.get("blocked")), "rules": input_guard.get("rules", []),
        "redacted_sources": (retrieval.get("stats") or {}).get("injection_redacted", 0),
        "output_issues": output_guard.get("issues", [])}
    response = steps.get("response", {}).get("result", {})
    if response:
        # 新格式把模型名和类型合成 model_called（"名称（类型）"），旧记录还有单独的 model_name。
        model = response.get("model_name") or (response.get("model_called") or "").split("（")[0] or None
        summary["generation"] = {"model": model,
            "prompt_version": response.get("prompt_version"),
            "token_usage": response.get("token_usage")}
        # 引用检查结果（不含模型原话，原话在 response 的步骤里）：统计有多少回答因为引用问题被拦截。
        citation = response.get("citation_check")
        if citation:
            summary["citation"] = {"passed": citation.get("passed"), "reason": citation.get("reason"),
                "source_count": len(citation.get("source_ids") or []), "unknown": citation.get("unknown") or [],
                "self_refusal": citation.get("reason") == "no_citation" and looks_like_refusal(citation.get("raw_answer"))}
    if summary["refused"]:
        summary["refusal_reason"] = refusal_reason(summary)
    return summary


# 模型没标引用、但原话是在说「资料里没有」：这是模型自己拒答，不是忘了标引用。按常见说法粗略判断。
SELF_REFUSAL_WORDS = ("资料不足", "没有足够", "无法回答", "未找到", "没有找到", "未提及", "没有提及", "无法确定",
    "没有相关", "未包含", "没有包含", "不包含")


def looks_like_refusal(text):
    return any(word in (text or "") for word in SELF_REFUSAL_WORDS)


# 拒答原因，按发生的先后判断：充分性判断拒答 → 检索没有资料（没召回到 / 都低于阈值）→ 引用检查拦截。
# 只对固定拒答文本的问答判断；模型自己措辞、又标了引用的拒答识别不出来，不在统计里。
def refusal_reason(summary):
    if (summary.get("sufficiency") or {}).get("refused"):
        return "sufficiency"
    citation = summary.get("citation") or {}
    if citation and not citation.get("passed"):
        if citation.get("reason") == "unknown_source":
            return "unknown_source"
        return "self_refusal" if citation.get("self_refusal") else "no_citation"
    retry = summary.get("retrieval_retry") if (summary.get("sufficiency") or {}).get("retry_used") else None
    search = retry or summary.get("retrieval") or {}
    if search and not search.get("returned"):
        hits = (search.get("dense_hits") or 0) + (search.get("keyword_hits") or 0)
        return "below_threshold" if hits and search.get("filtered") else "no_hits"
    return "other"


# 意图识别经过的环节（规则 → 本地小模型 → 大模型 → 规则兜底），每环是否采纳；大模型没被采纳时记下原因，
# 运行概览按它统计每一环的命中率。没有识别过程记录的旧问答返回 None。
INTENT_STAGES = ("rule", "small_model", "llm", "fallback")


def intent_path(intent):
    trace = intent.get("trace")
    if not isinstance(trace, list):
        return None
    path = []
    for item in trace:
        if not isinstance(item, dict) or item.get("stage") not in INTENT_STAGES:
            continue
        entry = {"stage": item["stage"], "accepted": bool(item.get("accepted"))}
        if item["stage"] == "llm" and not entry["accepted"]:
            entry["failure"] = "error" if "调用失败" in str(item.get("result") or "") else "invalid"
        path.append(entry)
    return path or None


# 检索摘要：统计数字、阈值、最高分，以及排在前面的候选（含跨版本稳定的 chunk_key，转成评测题时用得上）。
def summarize_retrieval(retrieval):
    stats = retrieval.get("stats", {})
    diagnostics = retrieval.get("diagnostics") or {}
    config = diagnostics.get("config", {})
    candidates = []
    top_score = None
    for item in (diagnostics.get("candidates") or [])[:TRACE_CANDIDATES]:
        score = item.get("rerank_probability")
        if score is None:
            score = item.get("rrf_score")
        if score is not None and (top_score is None or score > top_score):
            top_score = score
        candidates.append({"chunk_id": item.get("chunk_id"), "chunk_key": item.get("chunk_key"),
            "source_id": item.get("source_id"), "status": item.get("status"),
            "rrf_rank": item.get("rrf_rank"), "rerank_probability": item.get("rerank_probability")})
    return {"dense_hits": stats.get("dense_hits"), "keyword_hits": stats.get("keyword_hits"),
        "fused_candidates": stats.get("fused_candidates"), "returned": stats.get("returned"),
        "filtered": stats.get("filtered"), "min_score": stats.get("min_score"),
        "reranked": config.get("reranked"), "rerank_model": stats.get("rerank_model"),
        "recall_ms": stats.get("recall_ms"), "rerank_ms": stats.get("rerank_ms"),
        "top_score": top_score, "candidates": candidates}


# runs 表上用于筛选统计的列，与摘要一起写入。
# top_score 取首次检索和补充检索中的最高分。
def run_columns(summary):
    scores = []
    for key in ("retrieval", "retrieval_retry"):
        score = (summary.get(key) or {}).get("top_score")
        if score is not None:
            scores.append(score)
    return {"route": summary.get("route"), "refused": summary.get("refused"),
        "duration_ms": summary.get("duration_ms"), "top_score": max(scores) if scores else None,
        "trace": summary}
