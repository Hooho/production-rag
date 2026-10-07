# 运行概览：按天汇总线上问答的量、失败、拒答、耗时、Token 用量和用户反馈，给管理员看趋势。
# 数据全部来自已有的三张表：runs（成功的问答和追踪摘要）、run_errors（失败的问答）、feedback（点赞点踩）。
# 没有接 Prometheus 这类监控平台：这里看的是按天的趋势，不做实时告警。
# 统计在 Python 里做：拒答、耗时这些列可以直接查，但阶段耗时和 Token 用量在 trace 这个 JSON 里，
# MySQL 和测试用的 SQLite 取 JSON 字段的写法不同；单次最多看 90 天，按天汇总的数据量不大。
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .mysql.tables import feedback, run_errors, runs
from .observability import FEEDBACK_REASONS, intent_path
from .runtime_config import value as runtime_value


RANGES = (7, 30, 90)
# unknown：早期的问答记录没有存分流结果（追踪摘要是后来加的）。
ROUTE_LABELS = {"knowledge": "知识问答", "order": "订单查询", "data": "数据查询", "greeting": "问候", "blocked": "被安全拦截",
    "unknown": "未记录（早期问答）"}
# 问答各阶段，按处理顺序；只列耗时有意义的几步。
STAGES = [("input_guard", "安全检查"), ("memory", "读取对话记忆"), ("intent", "意图识别"), ("query", "问题改写"),
    ("retrieval", "检索"), ("sufficiency", "充分性判断"), ("retrieval_retry", "补充检索"), ("tool", "业务工具"),
    ("response", "生成回答"), ("output_guard", "回答检查")]
STAGE_LABELS = dict(STAGES)
# 失败记录里的 last_step 是失败前最后完成的一步，比上面多几个不计耗时的步骤。
# 意图识别的四个环节，按尝试顺序。
INTENT_STAGES = [("rule", "规则命中"), ("small_model", "本地小模型"), ("llm", "大模型"), ("fallback", "规则兜底")]
# 走到规则兜底的原因：大模型调用出错、输出不符合格式、没有启用大模型（演示模式）。
FALLBACK_CAUSES = {"error": "大模型调用失败", "invalid": "大模型输出不合规", "no_llm": "未启用大模型"}
STEP_LABELS = {**STAGE_LABELS, "request": "收到请求", "router": "分流", "context": "整理资料", "complete": "完成"}


def percentile(values, ratio):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(ratio * (len(ordered) - 1))))
    return ordered[index]


def rate(part, total):
    return round(part / total, 4) if total else None


# 把 UTC 时间字符串换成业务时区的日期（「今天」按业务时区算）。
def local_day(text, zone):
    try:
        moment = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone).date().isoformat()


def overview(engine, days=7, now=None):
    zone = ZoneInfo(runtime_value("business_tz"))
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(zone).date()
    first_day = today - timedelta(days=days - 1)
    # 起点取业务时区那一天的零点，换回 UTC 和库里存的 ISO 字符串比较。
    start = datetime.combine(first_day, datetime.min.time(), zone).astimezone(timezone.utc).isoformat()
    with engine.connect() as connection:
        run_rows = connection.execute(select(runs.c.id, runs.c.created, runs.c.route, runs.c.refused, runs.c.duration_ms,
            runs.c.top_score, runs.c.trace).where(runs.c.created >= start)).mappings().all()
        # 追踪摘要里还没有识别路径的旧问答，从完整记录的意图识别步骤里补出来（只查这些行）。
        missing = [row["id"] for row in run_rows if needs_intent_path(row["trace"])]
        old_paths = {}
        for index in range(0, len(missing), 200):
            for row in connection.execute(select(runs.c.id, runs.c.response).where(
                    runs.c.id.in_(missing[index:index + 200]))).mappings():
                step = next((item for item in (row["response"] or {}).get("steps", []) if item.get("id") == "intent"), None)
                old_paths[row["id"]] = intent_path((step or {}).get("result") or {})
        error_rows = connection.execute(select(run_errors.c.created, run_errors.c.last_step,
            run_errors.c.status_code, run_errors.c.error).where(run_errors.c.created >= start)).mappings().all()
        feedback_rows = connection.execute(select(feedback.c.updated, feedback.c.rating, feedback.c.reason).where(
            feedback.c.updated >= start)).mappings().all()

    day_keys = [(first_day + timedelta(days=offset)).isoformat() for offset in range(days)]
    daily = {key: {"date": key, "runs": 0, "errors": 0, "refused": 0, "knowledge": 0, "durations": [],
        "tokens": 0, "up": 0, "down": 0} for key in day_keys}
    durations = []
    stage_values = {}
    routes = {}
    tokens = {"input": 0, "output": 0, "total": 0, "runs_with_usage": 0}
    knowledge = refused = 0
    retrieval = {"runs": 0, "returned_zero": 0, "filtered": 0, "top_scores": []}
    intent = {"runs": 0, "reached": {}, "accepted": {}, "causes": {}}
    for row in run_rows:
        day = daily.get(local_day(row["created"], zone))
        if day is None:
            continue
        trace = row["trace"] or {}
        day["runs"] += 1
        route = row["route"] or trace.get("route") or "unknown"
        routes[route] = routes.get(route, 0) + 1
        if route == "knowledge":
            knowledge += 1
            day["knowledge"] += 1
            if row["refused"]:
                refused += 1
                day["refused"] += 1
        if row["duration_ms"] is not None:
            durations.append(row["duration_ms"])
            day["durations"].append(row["duration_ms"])
        for stage, value in (trace.get("stage_ms") or {}).items():
            if stage in STAGE_LABELS and isinstance(value, (int, float)):
                stage_values.setdefault(stage, []).append(value)
        usage = ((trace.get("generation") or {}).get("token_usage")) or {}
        if usage.get("total"):
            tokens["runs_with_usage"] += 1
            for key in ("input", "output", "total"):
                tokens[key] += usage.get(key) or 0
            day["tokens"] += usage.get("total") or 0
        path = (trace.get("intent") or {}).get("path") or old_paths.get(row["id"])
        if path:
            count_intent(intent, path)
        search = trace.get("retrieval") or {}
        if search:
            retrieval["runs"] += 1
            if not search.get("returned"):
                retrieval["returned_zero"] += 1
            retrieval["filtered"] += search.get("filtered") or 0
            if row["top_score"] is not None:
                retrieval["top_scores"].append(row["top_score"])

    error_stages = {}
    error_codes = {}
    for row in error_rows:
        day = daily.get(local_day(row["created"], zone))
        if day is None:
            continue
        day["errors"] += 1
        stage = row["last_step"] or "request"
        error_stages[stage] = error_stages.get(stage, 0) + 1
        code = str(row["status_code"])
        error_codes[code] = error_codes.get(code, 0) + 1

    reasons = {}
    up = down = 0
    for row in feedback_rows:
        day = daily.get(local_day(row["updated"], zone))
        if day is None:
            continue
        if row["rating"] == 1:
            up += 1
            day["up"] += 1
        else:
            down += 1
            day["down"] += 1
            reason = row["reason"] or "other"
            reasons[reason] = reasons.get(reason, 0) + 1

    total_runs = sum(day["runs"] for day in daily.values())
    total_errors = sum(day["errors"] for day in daily.values())
    attempts = total_runs + total_errors
    scores = retrieval["top_scores"]
    min_score = runtime_value("rerank_min_score")
    return {
        "days": days, "timezone": str(zone), "from": day_keys[0], "to": day_keys[-1],
        "totals": {
            # 提问次数 = 成功 + 失败；失败率按提问次数算，拒答率只算知识问答。
            "requests": attempts, "runs": total_runs, "errors": total_errors, "error_rate": rate(total_errors, attempts),
            "knowledge": knowledge, "refused": refused, "refusal_rate": rate(refused, knowledge),
            "p50_ms": percentile(durations, 0.5), "p95_ms": percentile(durations, 0.95),
            "tokens": tokens, "avg_tokens": round(tokens["total"] / tokens["runs_with_usage"]) if tokens["runs_with_usage"] else None,
            "feedback": up + down, "up": up, "down": down, "down_rate": rate(down, up + down),
        },
        "daily": [{"date": day["date"], "requests": day["runs"] + day["errors"], "errors": day["errors"],
            "error_rate": rate(day["errors"], day["runs"] + day["errors"]),
            "knowledge": day["knowledge"], "refused": day["refused"], "refusal_rate": rate(day["refused"], day["knowledge"]),
            "p50_ms": percentile(day["durations"], 0.5), "p95_ms": percentile(day["durations"], 0.95),
            "tokens": day["tokens"], "up": day["up"], "down": day["down"]} for day in daily.values()],
        "stages": [{"stage": stage, "label": label, "count": len(stage_values[stage]),
            "p50_ms": percentile(stage_values[stage], 0.5), "p95_ms": percentile(stage_values[stage], 0.95)}
            for stage, label in STAGES if stage_values.get(stage)],
        "routes": sorted([{"route": key, "label": ROUTE_LABELS.get(key, key), "count": count}
            for key, count in routes.items()], key=lambda item: -item["count"]),
        "retrieval": {"runs": retrieval["runs"], "returned_zero": retrieval["returned_zero"],
            "returned_zero_rate": rate(retrieval["returned_zero"], retrieval["runs"]),
            "top_score_p50": percentile(scores, 0.5), "below_threshold": sum(1 for score in scores if score < min_score),
            "min_score": min_score},
        "intent": intent_view(intent),
        "errors": {"stages": sorted([{"stage": key, "label": STEP_LABELS.get(key, key), "count": count}
            for key, count in error_stages.items()], key=lambda item: -item["count"]),
            "codes": sorted([{"code": key, "count": count} for key, count in error_codes.items()],
                key=lambda item: -item["count"])},
        "feedback_reasons": sorted([{"reason": key, "label": FEEDBACK_REASONS.get(key, key), "count": count}
            for key, count in reasons.items()], key=lambda item: -item["count"]),
    }


def needs_intent_path(trace):
    item = (trace or {}).get("intent")
    return bool(item) and not item.get("path")


# 一次识别经过的环节：每一环「到达」加一，被采纳的那一环「命中」加一；走到兜底时记下原因。
def count_intent(intent, path):
    intent["runs"] += 1
    for item in path:
        stage = item["stage"]
        intent["reached"][stage] = intent["reached"].get(stage, 0) + 1
        if item.get("accepted"):
            intent["accepted"][stage] = intent["accepted"].get(stage, 0) + 1
    if any(item["stage"] == "fallback" for item in path):
        llm = next((item for item in path if item["stage"] == "llm"), None)
        cause = (llm or {}).get("failure") or "no_llm"
        intent["causes"][cause] = intent["causes"].get(cause, 0) + 1


# 命中率 = 这一环命中 / 到达这一环的次数；占比 = 这一环命中 / 全部识别次数，四环占比加起来是 100%。
# 规则兜底一到就采纳，命中率没有意义，只看占比和原因。
def intent_view(intent):
    total = intent["runs"]
    stages = []
    for stage, label in INTENT_STAGES:
        reached = intent["reached"].get(stage, 0)
        accepted = intent["accepted"].get(stage, 0)
        stages.append({"stage": stage, "label": label, "reached": reached, "accepted": accepted,
            "hit_rate": None if stage == "fallback" else rate(accepted, reached), "share": rate(accepted, total)})
    return {"runs": total, "stages": stages,
        "fallback_causes": sorted([{"cause": key, "label": FALLBACK_CAUSES.get(key, key), "count": count}
            for key, count in intent["causes"].items()], key=lambda item: -item["count"])}
