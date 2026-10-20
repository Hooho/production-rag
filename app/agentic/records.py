"""保存和读取 Agent 模式的执行记录（agent_runs / agent_rounds）。"""
from datetime import datetime, timezone

from sqlalchemy import select

from ..mysql.store import agent_rounds, agent_runs


def save_run(connection, run_id, session_id, owner, outcome):
    """写入一次 Agent 问答的统计和全部轮次。outcome 是 AgentMode.run 返回的 agent 字段（含 rounds）。"""
    usage = outcome.get("usage") or {}
    citation = outcome.get("citation")
    connection.execute(agent_runs.insert().values(id=run_id, session_id=session_id, owner=owner,
        status=outcome["status"], stop_reason=outcome.get("stop_reason"), rounds=len(outcome.get("rounds") or []),
        tool_calls=outcome.get("tool_calls_used") or 0, tool_budget=outcome.get("tool_budget") or 0,
        citation_retried=bool(outcome.get("citation_retried")),
        citation_passed=None if citation is None else bool(citation.get("passed")),
        prompt_tokens=usage.get("prompt_tokens") or 0, completion_tokens=usage.get("completion_tokens") or 0,
        cached_tokens=usage.get("cached_tokens") or 0, duration_ms=outcome.get("duration_ms"),
        model=outcome.get("model"), prompt_version=outcome.get("prompt_version"),
        error=(outcome.get("error") or None) and str(outcome["error"])[:500],
        created=datetime.now(timezone.utc).isoformat()))
    rows = []
    for record in outcome.get("rounds") or []:
        rows.append({"run_id": run_id, "round": record["round"], "kind": record["kind"], "record": record,
            "duration_ms": record.get("duration_ms")})
    if rows:
        connection.execute(agent_rounds.insert(), rows)


def load_run(engine, run_id, owner):
    """读取一次 Agent 问答的统计和每一轮；只能读自己的记录，不存在或不是自己的返回 None。"""
    with engine.connect() as connection:
        run = connection.execute(select(agent_runs).where(agent_runs.c.id == run_id,
            agent_runs.c.owner == owner)).mappings().first()
        if run is None:
            return None
        rounds = connection.execute(select(agent_rounds.c.record).where(agent_rounds.c.run_id == run_id)
            .order_by(agent_rounds.c.round)).scalars().all()
    # agent_runs.rounds 是轮数；返回时 rounds 换成每一轮的记录列表，轮数放进 round_count。
    return {**dict(run), "round_count": run["rounds"], "rounds": list(rounds)}


# 写进 runs.response 的 Agent 摘要：去掉每一轮的细节和资料原文（资料在 response.sources 里已经有一份），
# 会话历史只读这份摘要，执行链展开时再调用 /agent/runs/{id} 读取每一轮。
def summary(outcome):
    return {key: value for key, value in outcome.items() if key not in ("rounds", "sources")}
