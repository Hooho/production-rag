import json

from sqlalchemy import select

from ..mysql.store import runs


class Memory:
    """读取 MySQL 里本会话的问答记录（最近几个问题供问题改写）和 Redis 里的最近订单号。

    这两样和 LangGraph Checkpointer 一样只在同一个会话里用，都属于短期记忆；以前注释里把 MySQL 叫「长期历史」，
    是按存得久不久分的，容易和跨会话的长期记忆（app/memory/long_term.py）混淆。
    """

    # 获取当前用户最近六轮持久化问答。
    def history(self, store, session_id, owner):
        with store.engine.connect() as connection:
            rows = connection.execute(select(runs).where(
                runs.c.session_id == session_id, runs.c.owner == owner
            ).order_by(runs.c.created.desc()).limit(6)).mappings().all()
        result = []
        for row in reversed(rows):
            # 被输入检查拦截的问题含有注入内容，原来会作为"最近问题"交给下一轮的查询分析模型，
            # 等于把注入文字又送进了模型；这里跳过它们，审计记录仍保留在 runs 表中。
            if row.get("route") == "blocked":
                continue
            result.append(dict(row))
        return result

    # 从 Redis 读取最近订单；缓存缺失时从历史恢复。
    def last_order(self, store, owner, session_id, previous):
        revision = previous[-1]["id"] if previous else "new"
        memory_key = f"memory:{owner}:{session_id}:{revision}"
        cached = store.cache.get(memory_key)
        if cached is not None:
            return json.loads(cached)
        last_order = None
        if previous:
            last_order = previous[-1]["response"].get("last_order")
            store.cache.setex(memory_key, 600, json.dumps(last_order))
        return last_order
