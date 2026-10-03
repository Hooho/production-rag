# 知识巡检：从问答日志中收集系统遇到的问题，合并成待处理清单。
# 第一期只做"被动收集"，不调用大模型：
#   knowledge_gap   知识缺口：拒答、资料不足或只能答一部分、用户反馈"没答全 / 资料里有却说找不到"的问题，按问题语义聚类；
#   suspect_content 可疑内容：被回答引用、却经常收到差评的分片，按跨版本稳定的 chunk_key 合并；
#   system_error    系统问题：处理失败（run_errors）和引用校验失败，按出错阶段和错误信息合并。
# 每条原始问答只挂到同一个问题一次（inspection_issue_events），重复巡检不会重复计数。
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import math
import os
import re
from uuid import uuid4

from sqlalchemy import and_, func, or_, select

from ..agent.replay import replay_question
from ..runtime_config import snapshot as runtime_snapshot
from .diagnosis import CATEGORIES as DIAGNOSIS_LABELS, QUESTION_LIMIT, diagnose_question, full_scope, overall_category, thresholds
from ..mysql.store import (chunks, document_chunks, document_heads, feedback, inspection_issue_events, inspection_issues,
    inspection_runs, run_errors, runs)


logger = logging.getLogger("production-rag-inspection")

KINDS = {"knowledge_gap": "知识缺口", "suspect_content": "可疑内容", "system_error": "系统问题"}
STATUSES = {"open": "待处理", "handled": "已处理", "resolved": "已解决", "ignored": "无需处理"}
# 标记"无需处理"时必须选的原因。原来只有"忽略"，看不出是拒答本来就对，还是懒得管；
# 记下原因后，列表可以按原因筛选，统计也能区分"合理拒答"和"真正需要处理的问题"。
CLOSE_REASONS = {
    "out_of_scope": "超出业务范围",
    "by_design_permission": "权限限制，按设计保密",
    "not_covered": "不打算覆盖",
    "invalid_feedback": "反馈不成立",
    "transient": "偶发问题",
    "other": "其他",
}
# 标记"已处理"时选择做了什么修复，方便以后回看哪类修复有效；验证失败重新打开时保留，便于看出"上次这么修没修好"。
FIX_TYPES = {
    "add_content": "补了资料",
    "update_content": "改了资料",
    "grant_permission": "调了权限",
    "tune_retrieval": "调了检索",
    "tune_routing": "调了分流",
    "update_prompt": "改了提示词",
    "fix_system": "修了系统配置",
    "other": "其他",
}
# 这个原因的"无需处理"会在巡检时复查，见 diagnose_gap_issues。
RECHECK_REASON = "by_design_permission"
# 这些原因说明"系统拒答是对的"，统计时算作合理拒答。
REASONABLE_REFUSALS = {"out_of_scope", "by_design_permission", "not_covered"}
# 管理员可以手动设置的状态。resolved 只由巡检自动设置（例如可疑分片已不在当前版本中），
# 避免没有验证就把问题关掉；以后接入自动验证后再开放。
MANUAL_STATUSES = {"open", "handled", "ignored"}
SIGNALS = {
    "refused": "拒答",
    "insufficient": "资料不足",
    "partial": "只能回答一部分",
    "feedback_missed": "差评：资料里有却说找不到",
    "feedback_incomplete": "差评：没答全",
    "negative_feedback": "差评",
    "citation_failure": "回答缺少引用被拦截",
    "run_error": "处理失败",
}
# 问答各步骤的中文名，与 app/agent/service.py 中 add_step 的标题对应；处理失败的标题和详情用它说明出错位置。
STEP_LABELS = {
    "start": "开始处理", "request": "接收问题", "input_guard": "输入安全检查", "memory": "读取记忆",
    "intent": "意图识别", "router": "问题分流", "query": "改写查询", "retrieval": "检索资料",
    "retrieval_retry": "补充检索", "sufficiency": "判断资料是否充分", "context": "组装上下文",
    "tool": "执行数据查询", "response": "生成回答", "output_guard": "输出安全检查", "complete": "完成处理",
}
TITLE_PREFIXES = ("知识缺口：", "可疑内容：")
CITATION_TITLE = "回答被拦截：模型没有按要求引用检索到的资料"


def error_title(step, message):
    return f"处理失败：「{STEP_LABELS.get(step, step)}」之后出错（{message[:60]}）"
# 与 app/observability.py 的 FIXED_REFUSALS 对应：这句是引用校验失败，不是知识库没有资料。
CITATION_FAILURE = "模型没有返回可校验的引用"
# 差评原因的去向：没答全、资料里有却找不到说明缺知识或没检索到，归入知识缺口；
# 其余原因（答错、引用不对、其他、未填写）说明被引用的内容可能有问题，归入可疑内容。
GAP_REASONS = {"missed", "incomplete"}

LOCK_KEY = "inspection:lock"
# 巡检的最长运行时间；进程被杀时锁会在这之后自动释放。
LOCK_SECONDS = 1800
SAMPLE_LIMIT = 5


class InspectionBusy(Exception):
    pass


def now_text():
    return datetime.now(timezone.utc).isoformat()


# 阈值都可以用环境变量调整，默认值偏保守：宁可漏报，也不让清单被噪声淹没。
def settings():
    config = runtime_snapshot()
    return {
        # 扫描最近多少天的问答。
        "days": int(os.getenv("INSPECTION_DAYS", "30")),
        # 新问题与某个缺口的相似度达到这个值才并入该缺口，否则新建缺口（设置页可改，见 app/runtime_config.py）。
        "gap_similarity": config["gap_similarity"],
        # 分片至少收到几次差评、差评占引用次数的比例至少多少，才算可疑内容。
        "content_min_negative": config["content_min_negative"],
        "content_min_rate": config["content_min_rate"],
    }


def fingerprint(*parts):
    return hashlib.sha256(":".join(parts).encode("utf-8")).hexdigest()


def cosine(a, b):
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / math.sqrt(norm_a * norm_b)


# 聚类中心取成员向量的平均值；只保存中心，不保存每个成员的向量。
def merge_vector(center, count, vector):
    merged = []
    for old, new in zip(center, vector):
        merged.append((old * count + new) / (count + 1))
    return merged


# 错误信息里的编号、数字和长度不同的细节会让同一类错误各成一组，合并前先去掉。
def normalize_error(text):
    text = re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27,}", "<id>", text or "", flags=re.I)
    text = re.sub(r"\d+", "<n>", text)
    return text.strip()[:120]


# sufficiency.missing 可能是字符串、列表或空值。
def missing_items(value):
    if not value:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    items = []
    for item in value:
        if isinstance(item, str) and item.strip():
            items.append(item.strip())
    return items


# 回答真正用到的分片（status=returned）的 chunk_key，首次检索和补充检索都算。
def returned_keys(trace):
    keys = []
    for name in ("retrieval", "retrieval_retry"):
        for candidate in ((trace or {}).get(name) or {}).get("candidates") or []:
            key = candidate.get("chunk_key")
            if candidate.get("status") == "returned" and key and key not in keys:
                keys.append(key)
    return keys


# 判断一条问答命中了哪些信号：缺口信号、是否作为可疑内容的差评、是否引用校验失败。
def classify(row):
    trace = row["trace"] or {}
    answer = (row["response"] or {}).get("answer") or ""
    rating = row["rating"]
    reason = row["reason"]
    result = {"gap": [], "negative": False, "citation_failure": False}
    if row["route"] != "knowledge":
        return result
    if CITATION_FAILURE in answer:
        # 引用校验失败也会被记为拒答（refused），但原因在模型输出，不算知识缺口。
        result["citation_failure"] = True
    elif row["refused"]:
        result["gap"].append("refused")
    verdict = (trace.get("sufficiency") or {}).get("verdict")
    if verdict in ("insufficient", "partial") and not result["citation_failure"]:
        result["gap"].append(verdict)
    if rating == -1:
        if reason in GAP_REASONS:
            result["gap"].append("feedback_" + reason)
        else:
            result["negative"] = True
    return result


class Inspector:
    def __init__(self, store, models, since, options=None, diagnose=True):
        self.store = store
        self.models = models
        self.since = since
        self.options = options or settings()
        self.now = now_text()
        self.stats = Counter()
        # 本次新增了关联问答的问题，最后统一重算计数和展示信息。
        self.touched = set()
        # 可疑内容问题对应分片在本次窗口内被引用的次数，用来计算差评率。
        self.content_cited = {}
        # 是否对知识缺口离线重跑检索做拒答分类和自动验证（会调用 Embedding 和重排模型）。
        self.diagnose = diagnose

    def run(self):
        with self.store.engine.begin() as connection:
            self.strip_title_prefixes(connection)
            rows = self.load_runs(connection)
            self.stats["scanned_runs"] = len(rows)
            self.collect_gaps(connection, rows)
            self.collect_content(connection, rows)
            self.collect_errors(connection, rows)
            # 系统问题数量少，每次都重算，旧问题也能用上新的标题和说明。
            self.touched.update(connection.execute(select(inspection_issues.c.id).where(
                inspection_issues.c.kind == "system_error")).scalars().all())
            for issue_id in self.touched:
                self.refresh_issue(connection, issue_id)
            self.resolve_updated_content(connection)
        # 拒答分类要调用检索，检索会自己开数据库连接，不能放在上面的事务里：先提交收集结果，再单独诊断。
        if self.diagnose:
            self.diagnose_gaps()
            # 系统问题用原问题重问一遍做验证，每次最多几条（设置页可改，0 表示不自动验证）。
            limit = runtime_snapshot()["system_recheck_limit"]
            if limit:
                verify_system_issues(self.store, self.models, self.now, self.stats, limit=limit)
        with self.store.engine.connect() as connection:
            for status, count in connection.execute(select(inspection_issues.c.status, func.count()).group_by(
                    inspection_issues.c.status)).all():
                self.stats["total_" + status] = count
        return dict(self.stats)

    # 标题不再带"知识缺口：""可疑内容："前缀，类型已经单独用标签显示，重复写在标题里多余；旧问题在这里改掉。
    def strip_title_prefixes(self, connection):
        for prefix in TITLE_PREFIXES:
            rows = connection.execute(select(inspection_issues.c.id, inspection_issues.c.title).where(
                inspection_issues.c.title.like(prefix + "%"))).all()
            for issue_id, title in rows:
                connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id).values(
                    title=title[len(prefix):]))

    # 时间窗口内的问答及其反馈。response 只用到 answer，但它和 trace 都在 JSON 列里，一并读出。
    def load_runs(self, connection):
        query = select(runs.c.id, runs.c.owner, runs.c.question, runs.c.response, runs.c.route, runs.c.refused,
            runs.c.trace, runs.c.created, feedback.c.rating, feedback.c.reason, feedback.c.comment).outerjoin(
                feedback, feedback.c.run_id == runs.c.id).where(runs.c.created >= self.since).order_by(runs.c.created)
        return connection.execute(query).mappings().all()

    # 某类问题已经关联过的原始记录，重复巡检时跳过。
    def linked(self, connection, kind, source):
        rows = connection.execute(select(inspection_issue_events.c.source_id).join(inspection_issues,
            inspection_issues.c.id == inspection_issue_events.c.issue_id).where(
                inspection_issues.c.kind == kind, inspection_issue_events.c.source == source)).scalars().all()
        return set(rows)

    def create_issue(self, connection, kind, key, title, created, vector=None, detail=None):
        issue_id = str(uuid4())
        connection.execute(inspection_issues.insert().values(id=issue_id, fingerprint=key, kind=kind, status="open",
            title=title[:200], occurrences=0, users=0, detail=detail or {}, vector=vector, first_seen=created,
            last_seen=created, created=self.now, updated=self.now))
        self.stats["created_" + kind] += 1
        return issue_id

    def add_event(self, connection, issue_id, source, source_id, owner, signals, created):
        connection.execute(inspection_issue_events.insert().values(issue_id=issue_id, source=source,
            source_id=source_id, owner=owner, signals=signals, created=created))
        self.touched.add(issue_id)

    # 知识缺口：每条新问题与已有缺口（含已处理、已忽略的）的聚类中心比较，足够相似就并入，否则新建缺口。
    # 用改写后的独立问题做比较：多轮追问的原话（"那海外的呢？"）脱离上下文后没法聚类。
    def collect_gaps(self, connection, rows):
        done = self.linked(connection, "knowledge_gap", "run")
        pending = []
        for row in rows:
            if row["id"] in done:
                continue
            signals = classify(row)["gap"]
            if signals:
                pending.append((row, signals))
        if not pending:
            return
        texts = []
        for row, _ in pending:
            rewrite = ((row["trace"] or {}).get("rewrite") or {}).get("standalone_query")
            texts.append(rewrite or row["question"])
        vectors = self.models.embed(texts)
        clusters = []
        for issue in connection.execute(select(inspection_issues.c.id, inspection_issues.c.vector,
                inspection_issues.c.occurrences).where(inspection_issues.c.kind == "knowledge_gap")).mappings().all():
            if issue["vector"]:
                clusters.append({"id": issue["id"], "vector": issue["vector"], "count": max(issue["occurrences"], 1)})
        for (row, signals), text, vector in zip(pending, texts, vectors):
            best = None
            best_score = 0.0
            for cluster in clusters:
                score = cosine(cluster["vector"], vector)
                if score > best_score:
                    best, best_score = cluster, score
            if best is None or best_score < self.options["gap_similarity"]:
                issue_id = self.create_issue(connection, "knowledge_gap", fingerprint("gap", row["id"]),
                    text, row["created"], vector=vector)
                best = {"id": issue_id, "vector": vector, "count": 0}
                clusters.append(best)
            else:
                best["vector"] = merge_vector(best["vector"], best["count"], vector)
            best["count"] += 1
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == best["id"]).values(
                vector=best["vector"]))
            self.add_event(connection, best["id"], "run", row["id"], row["owner"], signals, row["created"])

    # 可疑内容：统计窗口内每个分片被回答引用的次数和收到的差评次数，达到阈值的分片建一个问题。
    # 已经有问题的分片，新的差评直接挂上去，不再看阈值。
    def collect_content(self, connection, rows):
        cited = Counter()
        negative = {}
        for row in rows:
            keys = returned_keys(row["trace"])
            for key in keys:
                cited[key] += 1
            if keys and classify(row)["negative"]:
                for key in keys:
                    negative.setdefault(key, []).append(row)
        if not negative:
            return
        existing = {}
        for issue in connection.execute(select(inspection_issues.c.id, inspection_issues.c.fingerprint).where(
                inspection_issues.c.kind == "suspect_content")).mappings().all():
            existing[issue["fingerprint"]] = issue["id"]
        done = set(connection.execute(select(inspection_issue_events.c.issue_id, inspection_issue_events.c.source_id).join(
            inspection_issues, inspection_issues.c.id == inspection_issue_events.c.issue_id).where(
                inspection_issues.c.kind == "suspect_content")).all())
        for key, negative_rows in negative.items():
            key_fingerprint = fingerprint("content", key)
            issue_id = existing.get(key_fingerprint)
            if issue_id is None:
                rate = len(negative_rows) / max(cited[key], 1)
                if len(negative_rows) < self.options["content_min_negative"] or rate < self.options["content_min_rate"]:
                    continue
                info = self.chunk_info(connection, key)
                title = (f"《{info['title']}》" if info else "") + (info["preview"][:40] if info else key[:12])
                issue_id = self.create_issue(connection, "suspect_content", key_fingerprint, title,
                    negative_rows[0]["created"], detail={"chunk_key": key})
                existing[key_fingerprint] = issue_id
            for row in negative_rows:
                if (issue_id, row["id"]) in done:
                    continue
                self.add_event(connection, issue_id, "run", row["id"], row["owner"], ["negative_feedback"],
                    row["created"])
                done.add((issue_id, row["id"]))
            # 引用次数随窗口变化，每次巡检都更新。
            self.touched.add(issue_id)
            self.content_cited[issue_id] = cited[key]

    # 分片在当前版本中的标题和原文；不在任何当前版本中时返回 None。
    def chunk_info(self, connection, key):
        row = connection.execute(select(chunks.c.title, chunks.c.text, document_heads.c.doc_key).join(
            document_chunks, document_chunks.c.chunk_id == chunks.c.id).join(document_heads,
                document_heads.c.current_document_id == document_chunks.c.document_id).where(
                    chunks.c.chunk_key == key).limit(1)).mappings().first()
        if row is None:
            return None
        return {"title": row["title"], "preview": row["text"][:300], "doc_key": row["doc_key"]}

    # 系统问题：处理失败按"出错阶段 + 错误信息"合并，引用校验失败合并成一个问题。
    def collect_errors(self, connection, rows):
        done_errors = self.linked(connection, "system_error", "error")
        done_runs = self.linked(connection, "system_error", "run")
        existing = {}
        for issue in connection.execute(select(inspection_issues.c.id, inspection_issues.c.fingerprint).where(
                inspection_issues.c.kind == "system_error")).mappings().all():
            existing[issue["fingerprint"]] = issue["id"]

        def issue_for(key, title, created, detail):
            if key not in existing:
                existing[key] = self.create_issue(connection, "system_error", key, title, created, detail=detail)
            return existing[key]

        errors = connection.execute(select(run_errors).where(run_errors.c.created >= self.since).order_by(
            run_errors.c.created)).mappings().all()
        self.stats["scanned_errors"] = len(errors)
        for error in errors:
            if error["id"] in done_errors:
                continue
            step = error["last_step"] or "start"
            message = normalize_error(error["error"])
            issue_id = issue_for(fingerprint("error", step, message), error_title(step, message),
                error["created"], {"last_step": step, "error": error["error"], "status_code": error["status_code"]})
            self.add_event(connection, issue_id, "error", error["id"], error["owner"], ["run_error"], error["created"])
        for row in rows:
            if row["id"] in done_runs or not classify(row)["citation_failure"]:
                continue
            issue_id = issue_for(fingerprint("error", "citation_failure"), CITATION_TITLE,
                row["created"], {"error": CITATION_FAILURE})
            self.add_event(connection, issue_id, "run", row["id"], row["owner"], ["citation_failure"], row["created"])

    # 按关联记录重算问题的计数、时间和展示信息；处理过的问题又出现新记录时重新打开。
    def refresh_issue(self, connection, issue_id):
        issue = connection.execute(select(inspection_issues).where(inspection_issues.c.id == issue_id)).mappings().first()
        events = connection.execute(select(inspection_issue_events).where(
            inspection_issue_events.c.issue_id == issue_id).order_by(inspection_issue_events.c.created)).mappings().all()
        if not events:
            return
        signals = Counter()
        owners = set()
        for event in events:
            owners.add(event["owner"])
            for signal in event["signals"]:
                signals[signal] += 1
        detail = dict(issue["detail"] or {})
        detail["signals"] = dict(signals)
        run_ids = [event["source_id"] for event in events if event["source"] == "run"]
        if issue["kind"] in ("knowledge_gap", "suspect_content") and run_ids:
            detail.update(self.run_samples(connection, run_ids))
        if issue["kind"] == "system_error":
            # 标题措辞调整过，旧问题在重算时一并更新。
            if signals["citation_failure"]:
                values_title = CITATION_TITLE
            else:
                values_title = error_title(detail.get("last_step") or "start", normalize_error(detail.get("error")))
            detail["last_step_label"] = STEP_LABELS.get(detail.get("last_step"), detail.get("last_step"))
        if issue["kind"] == "suspect_content":
            cited = self.content_cited.get(issue_id)
            if cited is not None:
                detail["cited"] = cited
                detail["negative_rate"] = round(signals["negative_feedback"] / max(cited, 1), 3)
            info = self.chunk_info(connection, detail.get("chunk_key"))
            if info:
                detail.update({"document_title": info["title"], "preview": info["preview"], "doc_key": info["doc_key"]})
        values = {"occurrences": len(events), "users": len(owners), "first_seen": events[0]["created"],
            "last_seen": events[-1]["created"], "detail": detail, "updated": self.now}
        if issue["kind"] == "system_error":
            values["title"] = values_title
        latest = events[-1]["created"]
        if issue["status"] in ("handled", "resolved") and latest > (issue["status_updated"] or ""):
            new_count = 0
            for event in events:
                if event["created"] > (issue["status_updated"] or ""):
                    new_count += 1
            values.update({"status": "open", "status_by": "system", "status_updated": self.now})
            detail["reopened"] = {"at": self.now, "previous_status": issue["status"], "new_occurrences": new_count}
            detail.pop("resolution", None)
            self.stats["reopened"] += 1
        connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id).values(**values))

    # 最近几条问题原文、缺失内容和用户填写的说明，详情页和列表摘要都用得上。
    def run_samples(self, connection, run_ids):
        rows = connection.execute(select(runs.c.question, runs.c.trace, runs.c.created, feedback.c.comment).outerjoin(
            feedback, feedback.c.run_id == runs.c.id).where(runs.c.id.in_(run_ids)).order_by(
                runs.c.created.desc())).mappings().all()
        questions = []
        missing = Counter()
        comments = []
        for row in rows:
            if row["question"] not in questions and len(questions) < SAMPLE_LIMIT:
                questions.append(row["question"])
            for item in missing_items(((row["trace"] or {}).get("sufficiency") or {}).get("missing")):
                missing[item] += 1
            if row["comment"] and len(comments) < SAMPLE_LIMIT:
                comments.append(row["comment"])
        top_missing = []
        for text, count in missing.most_common(SAMPLE_LIMIT):
            top_missing.append({"text": text, "count": count})
        return {"questions": questions, "missing": top_missing, "comments": comments}

    # 拒答分类和自动验证，具体规则见 diagnose_gap_issues。
    def diagnose_gaps(self):
        diagnose_gap_issues(self.store, self.models, self.now, self.stats)

    # 可疑分片已经不在任何文档的当前版本中：说明内容被修改或删除了，自动标记为已解决。
    # 忽略的问题保持忽略；分片没变的问题继续保留。
    def resolve_updated_content(self, connection):
        issues = connection.execute(select(inspection_issues).where(inspection_issues.c.kind == "suspect_content",
            inspection_issues.c.status.in_(["open", "handled"]))).mappings().all()
        for issue in issues:
            key = (issue["detail"] or {}).get("chunk_key")
            if not key or self.chunk_info(connection, key) is not None:
                continue
            detail = dict(issue["detail"] or {})
            detail["resolution"] = "内容已更新：这个分片已不在任何文档的当前版本中"
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue["id"]).values(
                status="resolved", status_by="system", status_updated=self.now, detail=detail, updated=self.now))
            self.stats["auto_resolved"] += 1


# 拒答分类和自动验证：对知识缺口按提问人现在的权限重跑检索，写入诊断结论。
#   全部问题现在都能检索到资料：自动标为已解决（"已处理"的问题就是验证通过）；
#   标记"已处理"但仍有问题检索不到：验证不通过，重新打开并说明还差多少。
# 标记"无需处理 · 权限限制，按设计保密"的缺口也会复查：权限和文档会变，保密的理由可能已经不成立。
#   提问人现在能检索到资料：权限已经放开，自动标为已解决；
#   全库里也找不到当初那份资料了（文档被删或改了）：变成内容缺口，重新打开；
#   仍然是没有权限：保持无需处理，只更新诊断时间。
# 其他原因的"无需处理"（超出范围、不打算覆盖等）是人的决定，不会自己变化，不复查。
# 巡检时只处理待处理、已处理和需要复查的缺口；管理员在页面上点"重新检索"时传入 issue_ids，任何状态都会更新诊断，
# 但只有上面这几种会改状态。
# 分三步：先读出要诊断的问题和关联问答，再逐个重跑检索（检索会自己开连接，不能占着事务），最后一次性写回。
def diagnose_gap_issues(store, models, now, stats, issue_ids=None, trigger="inspection", by=None):
    with store.engine.connect() as connection:
        query = select(inspection_issues).where(inspection_issues.c.kind == "knowledge_gap")
        if issue_ids is None:
            query = query.where(or_(inspection_issues.c.status.in_(["open", "handled"]), and_(
                inspection_issues.c.status == "ignored", inspection_issues.c.close_reason == RECHECK_REASON)))
        else:
            query = query.where(inspection_issues.c.id.in_(issue_ids))
        issues = connection.execute(query).mappings().all()
        issue_rows = {}
        for issue in issues:
            issue_rows[issue["id"]] = connection.execute(select(runs.c.question, runs.c.trace, runs.c.owner,
                inspection_issue_events.c.signals).join(inspection_issue_events,
                    inspection_issue_events.c.source_id == runs.c.id).where(
                        inspection_issue_events.c.issue_id == issue["id"], inspection_issue_events.c.source == "run").order_by(
                            inspection_issue_events.c.created.desc())).mappings().all()
    if not issues:
        return []
    scope = full_scope(store)
    updates = []
    for issue in issues:
        checked = []
        seen = set()
        for row in issue_rows[issue["id"]]:
            rewrite = (row["trace"] or {}).get("rewrite") or {}
            standalone = rewrite.get("standalone_query") or row["question"]
            if (row["owner"], standalone) in seen:
                continue
            seen.add((row["owner"], standalone))
            queries = rewrite.get("queries") or [standalone]
            result = diagnose_question(store, models, row["owner"], queries, standalone, scope,
                feedback_missed="feedback_missed" in (row["signals"] or []))
            checked.append({"question": row["question"], "owner": row["owner"], **result,
                "label": DIAGNOSIS_LABELS[result["category"]]})
            if len(checked) >= QUESTION_LIMIT:
                break
        if not checked:
            continue
        category = overall_category([item["category"] for item in checked])
        counts = Counter(item["category"] for item in checked)
        detail = dict(issue["detail"] or {})
        detail["diagnosis"] = {"category": category, "label": DIAGNOSIS_LABELS[category], "checked_at": now,
            "counts": dict(counts), "questions": checked,
            # 谁触发的验证：巡检（含定时）自动验证，或管理员手动点"重新检索"。
            "trigger": trigger, "checked_by": by,
            # 判断用的门槛，页面据此把分数解释成"差多少才算相关"。
            "thresholds": thresholds()}
        values = {"detail": detail, "updated": now, "diagnosis_category": category}
        stats["diagnosed"] += 1
        recheck = issue["status"] == "ignored" and issue["close_reason"] == RECHECK_REASON
        if recheck:
            if category == "answerable":
                detail["resolution"] = (f"权限已调整：标记为权限保密后复查，这 {len(checked)} 个问题按提问人现在的权限"
                    "都能检索到资料，自动标为已解决。")
                detail.pop("verification", None)
                values.update(status="resolved", status_by="system", status_updated=now, close_reason=None)
                stats["recheck_resolved"] += 1
            elif category != "permission":
                detail["verification"] = {"passed": False, "at": now, "message": (
                    f"标记为权限保密后复查：整个知识库里已经找不到当初那份资料（{DIAGNOSIS_LABELS[category]}），"
                    "保密的理由不成立，已重新打开。")}
                values.update(status="open", status_by="system", status_updated=now, close_reason=None)
                stats["recheck_reopened"] += 1
        elif issue["status"] in ("open", "handled") and category == "answerable":
            titles = []
            for item in checked:
                for document in item["documents"]:
                    if document["title"] not in titles:
                        titles.append(document["title"])
            verified = issue["status"] == "handled"
            rerouted = sum(1 for item in checked if item.get("rerouted"))
            if rerouted == len(checked):
                found = f"这 {len(checked)} 个问题现在都会分到数据查询，不再去知识库检索"
            else:
                found = f"这 {len(checked)} 个问题按提问人的权限都能检索到相关资料" + (
                    "（" + "、".join(f"《{title}》" for title in titles[:3]) + "）" if titles else "") + (
                    f"，其中 {rerouted} 个现在会分到数据查询" if rerouted else "")
            detail["resolution"] = ("验证通过：" if verified else "现在能答：") + found + "，自动标为已解决。"
            detail.pop("verification", None)
            values.update(status="resolved", status_by="system", status_updated=now)
            stats["verified" if verified else "auto_resolved"] += 1
        elif issue["status"] == "handled":
            unanswered = len(checked) - counts["answerable"]
            detail["verification"] = {"passed": False, "at": now, "message": (
                f"标记已处理后重新验证，{len(checked)} 个问题里还有 {unanswered} 个没解决"
                f"（{DIAGNOSIS_LABELS[category]}），已重新打开。")}
            values.update(status="open", status_by="system", status_updated=now)
            stats["verification_failed"] += 1
        updates.append((issue["id"], issue["status"], values))
    # 诊断期间管理员可能改了状态（比如点了忽略），只在状态没变时写回，不覆盖管理员的操作。
    with store.engine.begin() as connection:
        for issue_id, status, values in updates:
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id,
                inspection_issues.c.status == status).values(**values))
    return [issue_id for issue_id, _, _ in updates]


# 系统问题的自动验证：用最近一条关联记录的原问题，以原提问人的身份完整重问一遍（见 app/agent/replay.py）。
#   处理失败类：这次没有报错就算恢复；
#   引用被拦截类：回答没有再被拦截才算恢复；
#   恢复了：待处理的自动标为已解决，已处理的就是验证通过；
#   没恢复：已处理的重新打开并说明，待处理的保持不变，结果记在 detail.recheck。
# 巡检时按出现次数从多到少取前 limit 个待处理、已处理的问题；管理员手动验证时传入 issue_ids。
# 和拒答分类一样分三步：先读出问题和问法，再逐个重问（不占着事务），最后只在状态没变时写回。
def verify_system_issues(store, models, now, stats, issue_ids=None, limit=None, trigger="inspection", by=None):
    with store.engine.connect() as connection:
        query = select(inspection_issues.c.id, inspection_issues.c.status, inspection_issues.c.detail).where(
            inspection_issues.c.kind == "system_error")
        if issue_ids is None:
            query = query.where(inspection_issues.c.status.in_(["open", "handled"])).order_by(
                inspection_issues.c.occurrences.desc(), inspection_issues.c.last_seen.desc()).limit(limit or 5)
        else:
            query = query.where(inspection_issues.c.id.in_(issue_ids))
        issues = connection.execute(query).mappings().all()
        plans = []
        for issue in issues:
            event = connection.execute(select(inspection_issue_events).where(
                inspection_issue_events.c.issue_id == issue["id"]).order_by(
                    inspection_issue_events.c.created.desc()).limit(1)).mappings().first()
            if event is None:
                continue
            if event["source"] == "run":
                row = connection.execute(select(runs.c.question, runs.c.trace).where(runs.c.id == event["source_id"])).mappings().first()
                question = (((row["trace"] or {}).get("rewrite") or {}).get("standalone_query") or row["question"]) if row else None
            else:
                question = connection.execute(select(run_errors.c.question).where(run_errors.c.id == event["source_id"])).scalar()
            if question:
                plans.append((issue, question, event["owner"]))
    updates = []
    for issue, question, owner in plans:
        detail = dict(issue["detail"] or {})
        citation = bool((detail.get("signals") or {}).get("citation_failure"))
        recheck = {"at": now, "trigger": trigger, "by": by, "question": question, "owner": owner}
        try:
            result = replay_question(store, models, owner, question)
            rejected = CITATION_FAILURE in (result["answer"] or "") or (result.get("citation") or {}).get("passed") is False
            passed = not rejected if citation else True
            recheck.update({"answer": (result["answer"] or "")[:1000], "route": result["route"]})
            if passed:
                recheck["message"] = "重新提问后正常回答了" + ("，引用校验通过" if citation else "，没有再报错")
            else:
                recheck["message"] = "重新提问后回答仍然因为引用问题被拦截"
        except Exception as error:
            passed = False
            recheck.update({"error": f"{type(error).__name__}: {error}"[:500], "message": "重新提问时仍然出错"})
        recheck["passed"] = passed
        detail["recheck"] = recheck
        values = {"detail": detail, "updated": now}
        stats["system_rechecked"] += 1
        if passed and issue["status"] in ("open", "handled"):
            verified = issue["status"] == "handled"
            detail["resolution"] = ("验证通过：" if verified else "已恢复：") + f"用原问题「{question}」以 {owner} 的身份重新提问，" + \
                recheck["message"].replace("重新提问后", "") + "，自动标为已解决。"
            detail.pop("verification", None)
            values.update(status="resolved", status_by="system", status_updated=now)
            stats["system_resolved"] += 1
        elif not passed and issue["status"] == "handled":
            detail["verification"] = {"passed": False, "at": now,
                "message": f"标记已处理后用原问题重新提问，{recheck['message'].replace('重新提问后', '')}，已重新打开。"}
            values.update(status="open", status_by="system", status_updated=now)
            stats["system_failed"] += 1
        elif not passed:
            stats["system_failed"] += 1
        updates.append((issue["id"], issue["status"], values))
    with store.engine.begin() as connection:
        for issue_id, status, values in updates:
            connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id,
                inspection_issues.c.status == status).values(**values))
    return [issue_id for issue_id, _, _ in updates]


# 管理员在问题详情里点"重新检索"（知识缺口）或"重新提问验证"（系统问题）：只处理这一个问题，规则和巡检时相同。
def verify_issue(store, models, issue_id, username):
    with store.engine.connect() as connection:
        kind = connection.execute(select(inspection_issues.c.kind).where(inspection_issues.c.id == issue_id)).scalar()
    if kind is None:
        return None
    stats = Counter()
    if kind == "knowledge_gap":
        diagnose_gap_issues(store, models, now_text(), stats, issue_ids=[issue_id], trigger="manual", by=username)
    elif kind == "system_error":
        verify_system_issues(store, models, now_text(), stats, issue_ids=[issue_id], trigger="manual", by=username)
    else:
        raise ValueError("可疑内容在文档更新后自动关闭，不需要手动验证")
    issue = get_issue(store, issue_id)
    issue["verify_result"] = dict(stats)
    return issue


# 关联记录上的"重新提问"：以这条记录的提问人身份，把问题完整再问一遍（见 app/agent/replay.py），
# 结果存进问题详情的 replays，按记录分开，只保留最近一次；不改问题状态，也不会被巡检收成新的问答。
# 多轮追问用改写后的完整问题，否则"那它呢"单独问没有意义。
def replay_event(store, models, issue_id, source, source_id, username):
    with store.engine.connect() as connection:
        event = connection.execute(select(inspection_issue_events).where(inspection_issue_events.c.issue_id == issue_id,
            inspection_issue_events.c.source == source, inspection_issue_events.c.source_id == source_id)).mappings().first()
        if event is None:
            return None
        if source == "run":
            row = connection.execute(select(runs.c.question, runs.c.trace).where(runs.c.id == source_id)).mappings().first()
            question = (((row["trace"] or {}).get("rewrite") or {}).get("standalone_query") or row["question"]) if row else None
        else:
            question = connection.execute(select(run_errors.c.question).where(run_errors.c.id == source_id)).scalar()
    if not question:
        raise ValueError("找不到这条记录的原始问题")
    entry = {"at": now_text(), "by": username, "question": question, "owner": event["owner"]}
    try:
        result = replay_question(store, models, event["owner"], question)
        entry.update({"answer": result["answer"][:4000], "route": result["route"], "refused": result["refused"],
            "top_score": result["top_score"], "citation": result["citation"], "duration_ms": result["duration_ms"],
            "sources": [{"id": item["id"], "title": item["title"], "score": item["score"]} for item in result["sources"]]})
    except Exception as error:
        logger.exception("inspection_replay_failed issue_id=%s source_id=%s", issue_id, source_id)
        entry["error"] = f"{type(error).__name__}: {error}"[:500]
    with store.engine.begin() as connection:
        detail = connection.execute(select(inspection_issues.c.detail).where(inspection_issues.c.id == issue_id)).scalar()
        detail = dict(detail or {})
        replays = dict(detail.get("replays") or {})
        replays[f"{source}:{source_id}"] = entry
        detail["replays"] = replays
        connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id).values(detail=detail))
    return entry


# 执行一次巡检并记录到 inspection_runs。同一时间只允许一次巡检（命令行和页面共用 Redis 锁）。
def run_inspection(store, models, trigger="cli", triggered_by=None, days=None, run_id=None):
    options = settings()
    if days is not None:
        options["days"] = days
    run_id = run_id or str(uuid4())
    if not store.cache.set(LOCK_KEY, run_id, nx=True, ex=LOCK_SECONDS):
        raise InspectionBusy("已有巡检正在运行，请稍后再试")
    since = (datetime.now(timezone.utc) - timedelta(days=options["days"])).isoformat()
    try:
        with store.engine.begin() as connection:
            connection.execute(inspection_runs.insert().values(id=run_id, status="running", trigger=trigger,
                triggered_by=triggered_by, since=since, started=now_text()))
        try:
            summary = Inspector(store, models, since, options).run()
        except Exception as error:
            logger.exception("inspection_failed run_id=%s", run_id)
            with store.engine.begin() as connection:
                connection.execute(inspection_runs.update().where(inspection_runs.c.id == run_id).values(
                    status="failed", error=str(error)[:500], finished=now_text()))
            raise
        with store.engine.begin() as connection:
            connection.execute(inspection_runs.update().where(inspection_runs.c.id == run_id).values(
                status="completed", summary=summary, finished=now_text()))
        return {"id": run_id, "since": since, "summary": summary}
    finally:
        if store.cache.get(LOCK_KEY) == run_id:
            store.cache.delete(LOCK_KEY)


def issue_view(row):
    return {"id": row["id"], "kind": row["kind"], "kind_label": KINDS.get(row["kind"], row["kind"]),
        "status": row["status"], "status_label": STATUSES.get(row["status"], row["status"]), "title": row["title"],
        "occurrences": row["occurrences"], "users": row["users"], "detail": row["detail"] or {}, "note": row["note"],
        "status_by": row["status_by"], "status_updated": row["status_updated"], "first_seen": row["first_seen"],
        "last_seen": row["last_seen"], "created": row["created"], "updated": row["updated"],
        "close_reason": row["close_reason"],
        "close_reason_label": CLOSE_REASONS.get(row["close_reason"], "未注明") if row["status"] == "ignored" else None,
        "suggested_close_reason": suggest_close_reason(row),
        "fix_type": row["fix_type"],
        "fix_type_label": FIX_TYPES.get(row["fix_type"]) or ("未注明" if row["status"] == "handled" else None),
        "suggested_fix_type": suggest_fix_type(row)}


# "已处理"时默认选中的修复方式，按问题类型和诊断结论推测。
def suggest_fix_type(row):
    detail = row["detail"] or {}
    if row["kind"] == "knowledge_gap":
        category = (detail.get("diagnosis") or {}).get("category")
        if category == "permission":
            return "grant_permission"
        if category == "retrieval":
            return "tune_retrieval"
        if category == "routing":
            return "tune_routing"
        return "add_content"
    if row["kind"] == "suspect_content":
        return "update_content"
    if (detail.get("signals") or {}).get("citation_failure"):
        return "update_prompt"
    return "fix_system"


# "无需处理"时默认选中的原因，按问题类型和诊断结论推测，管理员确认即可。
def suggest_close_reason(row):
    detail = row["detail"] or {}
    if row["kind"] == "knowledge_gap":
        category = (detail.get("diagnosis") or {}).get("category")
        if category == "permission":
            return "by_design_permission"
        if category in ("content", "retrieval"):
            return "not_covered"
        if category == "routing":
            return "other"
        return "out_of_scope"
    if row["kind"] == "suspect_content":
        return "invalid_feedback"
    if re.search(r"connection|timeout|timed out|连不上|超时", detail.get("error") or "", re.I):
        return "transient"
    return "other"


def run_view(row):
    if row is None:
        return None
    return {"id": row["id"], "status": row["status"], "trigger": row["trigger"], "triggered_by": row["triggered_by"],
        "since": row["since"], "summary": row["summary"] or {}, "error": row["error"], "started": row["started"],
        "finished": row["finished"]}


# 问题列表：按出现次数和影响人数排序；同时返回各状态、各类型的数量和最近一次巡检。
def list_issues(store, status=None, kind=None, page=1, page_size=20, reason=None, days=None, diagnosis=None):
    conditions = []
    if status:
        conditions.append(inspection_issues.c.status == status)
    if kind:
        conditions.append(inspection_issues.c.kind == kind)
    # reason=none 筛选没有注明原因的旧数据。
    if reason == "none":
        conditions.append(inspection_issues.c.close_reason.is_(None))
    elif reason:
        conditions.append(inspection_issues.c.close_reason == reason)
    # 按拒答分类结论筛选（只有知识缺口有）；none 是还没诊断过的。
    if diagnosis == "none":
        conditions.append(inspection_issues.c.diagnosis_category.is_(None))
    elif diagnosis:
        conditions.append(inspection_issues.c.diagnosis_category == diagnosis)
    columns = [column for column in inspection_issues.c if column.name != "vector"]
    with store.engine.connect() as connection:
        total = connection.execute(select(func.count()).select_from(inspection_issues).where(*conditions)).scalar()
        rows = connection.execute(select(*columns).where(*conditions).order_by(inspection_issues.c.occurrences.desc(),
            inspection_issues.c.users.desc(), inspection_issues.c.last_seen.desc()).limit(page_size).offset(
                (page - 1) * page_size)).mappings().all()
        status_counts = dict(connection.execute(select(inspection_issues.c.status, func.count()).group_by(
            inspection_issues.c.status)).all())
        kind_query = select(inspection_issues.c.kind, func.count()).group_by(inspection_issues.c.kind)
        if status:
            kind_query = kind_query.where(inspection_issues.c.status == status)
        kind_counts = dict(connection.execute(kind_query).all())
        reason_counts = {}
        for value, count in connection.execute(select(inspection_issues.c.close_reason, func.count()).where(
                inspection_issues.c.status == "ignored").group_by(inspection_issues.c.close_reason)).all():
            reason_counts[value or "none"] = count
        # 知识缺口按诊断结论计数，跟随当前的状态筛选。
        diagnosis_query = select(inspection_issues.c.diagnosis_category, func.count()).where(
            inspection_issues.c.kind == "knowledge_gap").group_by(inspection_issues.c.diagnosis_category)
        if status:
            diagnosis_query = diagnosis_query.where(inspection_issues.c.status == status)
        diagnosis_counts = {}
        for value, count in connection.execute(diagnosis_query).all():
            diagnosis_counts[value or "none"] = count
        gap_summary = summarize_gaps(connection, days or settings()["days"])
        last_run = connection.execute(select(inspection_runs).order_by(inspection_runs.c.started.desc()).limit(
            1)).mappings().first()
    return {"items": [issue_view(row) for row in rows], "total": total, "page": page, "page_size": page_size,
        "status_counts": status_counts, "kind_counts": kind_counts, "reason_counts": reason_counts,
        "diagnosis_counts": diagnosis_counts, "diagnoses": DIAGNOSIS_LABELS,
        "gap_summary": gap_summary, "last_run": run_view(last_run),
        "kinds": KINDS, "statuses": STATUSES, "signals": SIGNALS, "close_reasons": CLOSE_REASONS, "fix_types": FIX_TYPES}


# 页面顶部的统计：最近 N 天没答上来的问答（知识缺口关联的问答）按所属问题的处理结果分组，
# 区分合理拒答（无需处理且原因是超出范围、权限保密、不打算覆盖）、已解决、仍需处理。
def summarize_gaps(connection, days):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = connection.execute(select(inspection_issues.c.status, inspection_issues.c.close_reason, func.count()).join(
        inspection_issue_events, inspection_issue_events.c.issue_id == inspection_issues.c.id).where(
            inspection_issues.c.kind == "knowledge_gap", inspection_issue_events.c.created >= since).group_by(
                inspection_issues.c.status, inspection_issues.c.close_reason)).all()
    summary = {"days": days, "total": 0, "reasonable": 0, "reasonable_by_reason": {}, "other_ignored": 0,
        "resolved": 0, "pending": 0}
    for status, reason, count in rows:
        summary["total"] += count
        if status == "ignored" and reason in REASONABLE_REFUSALS:
            summary["reasonable"] += count
            summary["reasonable_by_reason"][reason] = summary["reasonable_by_reason"].get(reason, 0) + count
        elif status == "ignored":
            summary["other_ignored"] += count
        elif status == "resolved":
            summary["resolved"] += count
        else:
            summary["pending"] += count
    return summary


# 问题详情：问题本身和最近的关联记录（问题原文、回答摘要、反馈、缺失内容或错误信息）。
def get_issue(store, issue_id, limit=50):
    columns = [column for column in inspection_issues.c if column.name != "vector"]
    with store.engine.connect() as connection:
        row = connection.execute(select(*columns).where(inspection_issues.c.id == issue_id)).mappings().first()
        if row is None:
            return None
        events = connection.execute(select(inspection_issue_events).where(
            inspection_issue_events.c.issue_id == issue_id).order_by(inspection_issue_events.c.created.desc()).limit(
                limit)).mappings().all()
        run_ids = [event["source_id"] for event in events if event["source"] == "run"]
        error_ids = [event["source_id"] for event in events if event["source"] == "error"]
        run_rows = {}
        if run_ids:
            for item in connection.execute(select(runs.c.id, runs.c.question, runs.c.response, runs.c.trace,
                    runs.c.top_score, runs.c.duration_ms, feedback.c.rating, feedback.c.reason, feedback.c.comment).outerjoin(
                        feedback, feedback.c.run_id == runs.c.id).where(runs.c.id.in_(run_ids))).mappings().all():
                run_rows[item["id"]] = item
        error_rows = {}
        if error_ids:
            for item in connection.execute(select(run_errors).where(run_errors.c.id.in_(error_ids))).mappings().all():
                error_rows[item["id"]] = item
    items = []
    for event in events:
        item = {"source": event["source"], "source_id": event["source_id"], "owner": event["owner"],
            "signals": event["signals"], "created": event["created"]}
        if event["source"] == "run" and event["source_id"] in run_rows:
            found = run_rows[event["source_id"]]
            answer = (found["response"] or {}).get("answer") or ""
            sufficiency = (found["trace"] or {}).get("sufficiency") or {}
            # 回答返回全文（含推理模型的 <think> 思考过程），由页面拆出思考过程折叠显示；原来截到 300 字，
            # 推理模型的回答前面全是思考过程，截完只剩半句思考，看不到真正的回答。
            item.update({"question": found["question"], "answer": answer[:8000], "top_score": found["top_score"],
                "returned": returned_count(found["trace"]), "citation": citation_check(found["response"]),
                "sources": source_views(found["response"]),
                "call": call_summary((found["response"] or {}).get("steps"), found["trace"], found["duration_ms"]),
                "missing": missing_items(sufficiency.get("missing")),
                "feedback": None if found["rating"] is None else {"rating": found["rating"], "reason": found["reason"],
                    "comment": found["comment"]}})
        elif event["source"] == "error" and event["source_id"] in error_rows:
            found = error_rows[event["source_id"]]
            item.update({"question": found["question"], "error": found["error"], "last_step": found["last_step"],
                "status_code": found["status_code"], "call": call_summary(found["steps"], duration_ms=found["duration_ms"])})
        items.append(item)
    return {**issue_view(row), "events": items}


# 这次问答最终交给模型的资料段数：补充检索用上时以补充检索为准。
def returned_count(trace):
    trace = trace or {}
    if (trace.get("sufficiency") or {}).get("retry_used") and trace.get("retrieval_retry"):
        return trace["retrieval_retry"].get("returned")
    return (trace.get("retrieval") or {}).get("returned")


# 回答步骤里的引用检查明细（含被拦截的模型原话）；记录这项信息之前的问答没有。
def citation_check(response):
    for step in (response or {}).get("steps") or []:
        if step.get("id") == "response":
            return (step.get("result") or {}).get("citation_check")
    return None


# 这次问答交给模型的资料（S1、S2…）：编号、出处和原文，详情页折叠显示，排查时能看到模型实际拿到了什么。
# 原文按父子分块扩展过，可能很长，只保留前一部分。
def source_views(response, limit=1500):
    items = []
    for source in (response or {}).get("sources") or []:
        text = source.get("text") or ""
        items.append({"id": source.get("id"), "title": source.get("title"), "heading": source.get("heading"),
            "page_start": source.get("page_start"), "version": source.get("version"), "score": source.get("score"),
            "text": text[:limit], "truncated": len(text) > limit})
    return items


# 一次问答的调用摘要：调用了哪些模型（用在哪几步）、重排模型、提示词版本、Token 用量和总耗时。
# 模型信息取自各步骤记录的 model_called，失败的问答用 run_errors.steps，能看到出错前已经调用过什么。
def call_summary(steps, trace=None, duration_ms=None):
    trace = trace or {}
    models = {}
    for step in steps or []:
        name = (step.get("result") or {}).get("model_called")
        if name:
            models.setdefault(name, [])
            label = STEP_LABELS.get(step.get("id"), step.get("title") or step.get("id"))
            if label not in models[name]:
                models[name].append(label)
    generation = trace.get("generation") or {}
    rerank_model = (trace.get("retrieval") or {}).get("rerank_model")
    return {"models": [{"name": name, "steps": labels} for name, labels in models.items()],
        "rerank_model": rerank_model, "prompt_version": generation.get("prompt_version"),
        "token_usage": generation.get("token_usage"), "duration_ms": duration_ms if duration_ms is not None else trace.get("duration_ms")}


# 管理员修改问题状态和备注。
# 标记"无需处理"必须选原因，标记"已处理"必须选修复方式，选"其他"时都要写备注；
# 改成别的状态时清空不相关的那一项。
def update_issue(store, issue_id, status, note, username, close_reason=None, fix_type=None):
    values = {"updated": now_text()}
    if status is not None:
        if status not in MANUAL_STATUSES:
            raise ValueError(f"不能手动设置为这个状态：{status}")
        if status == "ignored":
            if close_reason not in CLOSE_REASONS:
                raise ValueError("标记无需处理时请选择原因")
            if close_reason == "other" and not (note or "").strip():
                raise ValueError("原因选择「其他」时请在备注里说明")
        if status == "handled":
            if fix_type not in FIX_TYPES:
                raise ValueError("标记已处理时请选择做了什么修复")
            if fix_type == "other" and not (note or "").strip():
                raise ValueError("修复方式选择「其他」时请在备注里说明")
        values.update({"status": status, "status_by": username, "status_updated": values["updated"],
            "close_reason": close_reason if status == "ignored" else None,
            "fix_type": fix_type if status == "handled" else None})
    if note is not None:
        values["note"] = note or None
    with store.engine.begin() as connection:
        result = connection.execute(inspection_issues.update().where(inspection_issues.c.id == issue_id).values(**values))
        if result.rowcount == 0:
            return None
    return get_issue(store, issue_id)


def list_runs(store, limit=20):
    with store.engine.connect() as connection:
        rows = connection.execute(select(inspection_runs).order_by(inspection_runs.c.started.desc()).limit(
            limit)).mappings().all()
    return [run_view(row) for row in rows]
