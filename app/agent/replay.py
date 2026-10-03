from uuid import uuid4

from ..observability import is_refusal, summarize_run
from .response import ResponseAgent
from .service import Agent


# 以某个用户的身份把一个问题完整再问一遍：意图识别、改写、检索、充分性判断、回答、引用校验，和线上 /chat 走同一张图。
# 用于知识巡检的"重新提问"和线上回归集的生成评测。和线上问答的区别：
#   不写 runs 表，不会被巡检当成新的问答再收进来；
#   用临时会话、没有历史，回答 Agent 用进程内记忆，不在 PostgreSQL 里留下会话；
#   原问题如果是多轮追问里的"那它呢"，调用方应传入改写后的完整问题。
def replay_question(store, models, owner, question):
    agent = Agent()
    agent.response_agent = ResponseAgent(models, use_postgres=False)
    try:
        result = agent.run(store, models, owner, f"replay:{uuid4()}", question, [], None)
    finally:
        agent.close()
    summary = summarize_run(result)
    sources = []
    for source in result.get("sources") or []:
        sources.append({"id": source.get("id"), "title": source.get("title"), "score": source.get("score"),
            "chunk_id": source.get("chunk_id"), "text": (source.get("text") or "")[:600]})
    top_scores = []
    for key in ("retrieval", "retrieval_retry"):
        score = (summary.get(key) or {}).get("top_score")
        if score is not None:
            top_scores.append(score)
    return {"question": question, "owner": owner, "answer": result.get("answer") or "",
        "route": result.get("route"), "refused": bool(summary.get("refused")) or (
            result.get("route") == "knowledge" and is_refusal(result.get("answer"))),
        "sources": sources, "top_score": max(top_scores) if top_scores else None,
        "citation": summary.get("citation"), "sufficiency": summary.get("sufficiency"),
        "duration_ms": summary.get("duration_ms"), "model_mode": result.get("model_mode"), "raw": result}
