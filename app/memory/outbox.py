"""会话记忆外箱（Outbox）。

一次问答的结果要写两个库：runs（MySQL，对话框显示的问答）和会话记忆（PostgreSQL 的 LangGraph Checkpointer，
下一次提问时带给模型的历史）。两个库没法放进同一个事务，以前先写会话记忆、再写 runs，中间出错（会话锁过期、
MySQL 写入失败、服务重启）就会留下“对话框里没有、模型记忆里有”的问答。

现在的做法：
1. 写 runs 时，在同一个 MySQL 事务里插入一条 memory_outbox 任务（问题、答案、会话）。两条要么都写进去，要么都没有。
2. 提交后立刻按顺序写会话记忆，写成功标记 done。
3. 写失败就留着 pending，这个会话下次提问前（拿到会话锁之后）先补写，再读取记忆。
4. 写入按 request_id 幂等（ResponseAgent.remember_turn），重试不会写出重复的问答。

同一个会话的任务按时间顺序写；前一条写失败时后面的先不写，保证记忆里的顺序和对话一致。
重试 MAX_ATTEMPTS 次仍失败的标记 failed、不再重试，后面的任务继续写（这一轮会在对话里，但记忆里少这一条，失败原因留在表里）。
"""
from datetime import datetime, timezone

from sqlalchemy import select

from ..mysql.store import memory_outbox

MAX_ATTEMPTS = 3


def now():
    return datetime.now(timezone.utc).isoformat()


# 和 runs 在同一个事务里调用（connection 来自 engine.begin()）。
def enqueue(connection, request_id, owner, session_id, question, answer):
    connection.execute(memory_outbox.insert().values(request_id=request_id, owner=owner, session_id=session_id,
        question=question, answer=answer, status="pending", attempts=0, created=now()))


# 按顺序写入这个会话所有待写入的任务，返回 {request_id: 写入结果}。写入结果是 remember_turn 的返回值，
# 失败时是 {"error": 原因}。调用方要持有这个会话的锁，避免两个请求同时写同一个会话。
def apply_pending(engine, response_agent, owner, session_id):
    with engine.connect() as connection:
        rows = connection.execute(select(memory_outbox).where(memory_outbox.c.owner == owner,
            memory_outbox.c.session_id == session_id, memory_outbox.c.status == "pending")
            .order_by(memory_outbox.c.created, memory_outbox.c.request_id)).mappings().all()
    results = {}
    for row in rows:
        attempts = row["attempts"] + 1
        try:
            written = response_agent.remember_turn(owner, session_id, row["question"], row["answer"],
                request_id=row["request_id"])
        except Exception as error:  # noqa: BLE001
            message = f"{type(error).__name__}: {str(error)[:200]}"
            status = "failed" if attempts >= MAX_ATTEMPTS else "pending"
            with engine.begin() as connection:
                connection.execute(memory_outbox.update().where(memory_outbox.c.request_id == row["request_id"])
                    .values(status=status, attempts=attempts, error=message))
            results[row["request_id"]] = {"error": message, "attempts": attempts, "gave_up": status == "failed"}
            if status == "pending":
                break
            continue
        with engine.begin() as connection:
            connection.execute(memory_outbox.update().where(memory_outbox.c.request_id == row["request_id"])
                .values(status="done", attempts=attempts, error=None, applied=now()))
        # 没有聊天模型时 remember_turn 返回 None（演示模式不写会话记忆），同样算处理完。
        results[row["request_id"]] = written or {"skipped": True}
    return results
