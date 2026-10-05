# 「会话记忆」页面：用户查看自己每个会话的对话记忆。只能看自己的会话，管理员也看不到别人的（对话内容属于个人数据）。
#
# 数据来源：
#   当前记忆      LangGraph Checkpointer（PostgreSQL）里这个会话的最新状态：滚动摘要 + 保留原文的最近几条消息；
#   记忆时间线    MySQL runs 表里每一轮的处理记录：问题被改写成了什么、回答前记忆多大、这一轮有没有触发压缩、
#                压缩后实际交给模型的摘要和原文（回答步骤里的 ai_memory_sent）；
#   存储占用      Checkpointer 的快照数和占用空间（PostgreSQL 时按表统计，进程内存储时只能数快照）；
#   最近订单      最近一轮记录里的 last_order（和 Redis 里缓存的是同一个值）。
from sqlalchemy import func, select

from ..models import strip_think
from ..mysql.tables import runs, sessions


# 不经过回答模型、不写对话记忆的分流：订单查询、数据查询、问候、被安全拦截。
NO_MEMORY_ROUTES = {"order", "data", "greeting", "blocked"}


def steps_by_id(response):
    result = {}
    for step in (response or {}).get("steps") or []:
        result.setdefault(step.get("id"), step.get("result") or {})
    return result


def memory_sent(response_step):
    for item in response_step.get("ai_memory_sent") or []:
        if "memory_summary" in item or "history_turns" in item:
            return item
    return None


# 回答里的 <think> 思考过程不展示（页面看的是记住了什么内容）。
def clean_turns(turns):
    if turns is None:
        return None
    return [{"question": turn.get("question", ""), "answer": strip_think(turn.get("answer") or "").strip()}
        for turn in turns]


# 一轮问答在记忆里的情况。entered：这一轮有没有进入回答模型（订单、数据查询、问候、没检索到资料的拒答都不进入，
# 也就不会写进对话记忆）；None 表示记录里没有保存这些信息（早期格式的记录），无法判断。
# compressed：回答前触发了压缩（SummarizationMiddleware 把较早的消息压成了摘要）。
def turn_view(index, row):
    steps = steps_by_id(row["response"])
    response_step = steps.get("response") or {}
    sent = memory_sent(response_step)
    route = row["route"] or (row["trace"] or {}).get("route")
    if "checkpoint_messages_sent" in response_step:
        entered = bool(response_step["checkpoint_messages_sent"])
    else:
        entered = False if route in NO_MEMORY_ROUTES else None
    return {
        "index": index, "run_id": row["id"], "created": row["created"], "question": row["question"],
        "rewritten": (steps.get("query") or {}).get("standalone_query"),
        "route": route,
        "entered": entered,
        "memory_tokens": (steps.get("context") or {}).get("estimated_memory_tokens"),
        "messages_before": response_step.get("checkpoint_messages_before"),
        "compressed": bool(response_step.get("summary_updated")),
        "summary": sent.get("memory_summary") if sent else None,
        "kept_turns": clean_turns(sent.get("history_turns")) if sent else None,
        "answer": strip_think((row["response"] or {}).get("answer") or "").strip()[:2000],
    }


# 压缩那一轮被压掉了哪些问答：上一轮回答时记忆里的原文 + 上一轮自己的问答，减去这一轮压缩后仍保留的原文。
def compressed_turns(previous, current):
    if previous is None or previous.get("kept_turns") is None:
        return None
    before = list(previous["kept_turns"]) + [{"question": previous["question"], "answer": previous["answer"]}]
    kept = {turn.get("question") for turn in current.get("kept_turns") or []}
    return [turn for turn in before if turn.get("question") not in kept]


def session_rows(engine, owner, session_ids):
    query = select(runs.c.id, runs.c.session_id, runs.c.question, runs.c.created, runs.c.route, runs.c.trace,
        runs.c.response).where(runs.c.owner == owner, runs.c.session_id.in_(session_ids))
    with engine.connect() as connection:
        return connection.execute(query.order_by(runs.c.created)).mappings().all()


def current_memory(framework, owner, session_id):
    state = framework.inspect(owner, session_id)
    summary_tokens = None
    if state["summary"] and framework.middleware is not None:
        from langchain_core.messages import HumanMessage
        summary_tokens = framework.middleware.token_counter([HumanMessage(content=state["summary"])])
    return {**state, "summary_tokens": summary_tokens}


# 会话列表：最近 50 个有问答记录的会话，每个会话的轮数、压缩次数、当前记忆大小、快照数和占用空间。
def list_sessions(engine, framework, owner, limit=50):
    with engine.connect() as connection:
        ids = [row[0] for row in connection.execute(select(runs.c.session_id).where(runs.c.owner == owner).group_by(
            runs.c.session_id).order_by(func.max(runs.c.created).desc()).limit(limit)).all()]
    if not ids:
        return {"items": [], "trigger_tokens": framework.trigger_tokens, "keep_tokens": framework.keep_tokens}
    grouped = {}
    for row in session_rows(engine, owner, ids):
        grouped.setdefault(row["session_id"], []).append(row)
    storage = framework.storage(owner, ids)
    items = []
    for session_id in ids:
        rows = grouped.get(session_id, [])
        turns = [turn_view(index + 1, row) for index, row in enumerate(rows)]
        state = framework.inspect(owner, session_id)
        stats = storage.get(session_id, {})
        items.append({"session_id": session_id, "title": rows[0]["question"] if rows else "",
            "turns": len(rows), "compressions": sum(1 for turn in turns if turn["compressed"]),
            "memory_tokens": state["estimated_tokens"], "message_count": state["message_count"],
            "snapshots": stats.get("snapshots"), "bytes": stats.get("bytes"),
            "last_active": rows[-1]["created"] if rows else None})
    return {"items": items, "trigger_tokens": framework.trigger_tokens, "keep_tokens": framework.keep_tokens,
        "backend": framework.backend}


def session_detail(engine, framework, owner, session_id):
    with engine.connect() as connection:
        exists = connection.execute(select(sessions.c.id).where(sessions.c.id == session_id,
            sessions.c.owner == owner)).first()
    rows = session_rows(engine, owner, [session_id])
    if not exists and not rows:
        return None
    turns = [turn_view(index + 1, row) for index, row in enumerate(rows)]
    entered = [turn for turn in turns if turn["entered"]]
    for previous, current in zip([None] + entered[:-1], entered):
        if current["compressed"]:
            current["compressed_turns"] = compressed_turns(previous, current)
    # 保留的原文对应第几轮：这一轮之前、最近进入回答模型的那几轮（早期记录无法判断，按进入过算）。
    possible = [turn for turn in turns if turn["entered"] is not False]
    for position, current in enumerate(possible):
        if current["entered"]:
            kept = len(current["kept_turns"] or [])
            current["kept_rounds"] = [turn["index"] for turn in possible[max(0, position - kept):position]]
    for turn in turns:
        turn.pop("answer", None)
    last_order = None
    if rows:
        last_order = (rows[-1]["response"] or {}).get("last_order")
    return {"session_id": session_id, "title": rows[0]["question"] if rows else "",
        "current": current_memory(framework, owner, session_id), "last_order": last_order,
        "trigger_tokens": framework.trigger_tokens, "keep_tokens": framework.keep_tokens,
        "timeline": turns, "storage": {**framework.storage(owner, [session_id]).get(session_id, {}),
            "backend": framework.backend}}
