# 拒答分类和自动验证：对答不上来的问题离线重跑检索（只做召回和重排，不调用大模型），判断原因：
#   answerable    现在能答：按提问人的权限已经能检索到资料，多半是之后补了文档或改了权限；
#   permission    权限缺口：提问人看不到，但全库里有相关资料；
#   retrieval     检索缺口：提问人范围里有接近阈值的资料，或用户反馈"资料里有却说找不到"，需要调检索；
#   content       内容缺口：全库都找不到足够相关的资料，需要补文档；
#   out_of_scope  疑似超出范围：全库里连沾边的资料都没有，多半是闲聊或与业务无关的问题；
#   routing       分错了路：问题提到了订单、库存这类业务数据，像是在查数据库，却被意图识别分到了知识库检索，
#                 当然找不到资料。要调的是意图识别和分流，不是补文档。
# "能不能检索到"沿用线上问答同一个重排阈值；它只说明找到了相关资料，不保证一定能答对。
# 分错了路的问题用当前的意图识别和分流规则再判断一次（不检索、不生成回答）：现在能分到数据查询，就算已经修好。

from sqlalchemy import select

from ..data.schema import DATA_TYPES
from ..mysql.store import chunks, document_heads
from ..router.router import Router
from ..tools.data_query import KNOWLEDGE_WORDS, TYPE_PRIORITY, mentions
from ..runtime_config import snapshot as runtime_snapshot
from ..tools.search import DocumentSearchTool


CATEGORIES = {
    "answerable": "现在能答",
    "permission": "权限缺口",
    "retrieval": "检索缺口",
    "content": "内容缺口",
    "out_of_scope": "疑似超出范围",
    "routing": "分错了路",
    "unknown": "无法判断",
}
ROUTE_LABELS = {"knowledge": "知识库检索", "data": "数据查询", "order": "订单查询", "greeting": "问候"}
# 同一个缺口里各问题结论不同时，按这个顺序取主结论：越靠前越需要管理员处理。
PRIORITY = ["permission", "routing", "retrieval", "content", "out_of_scope", "unknown"]
VISIBILITY_LABELS = {"private": "仅上传者可见", "shared": "共享给部门", "public": "所有人可见"}
# 每个缺口最多重跑几个问题：取最近的几个不重复的问题，控制巡检耗时。
QUESTION_LIMIT = 5
# 诊断结果里保留得分最高的那一段资料，页面折叠显示，管理员能看到分数对应的是什么内容。
CHUNK_LIMIT = 1
# 分片原文一般不超过 1500 字（800 字正文加上下文说明和标题路径），完整保存；
# 只有一段，不用为了控制大小截断。上限只防异常数据。
CHUNK_CHARACTERS = 6000


def thresholds():
    config = runtime_snapshot()
    min_score = config["rerank_min_score"]
    return {
        "min_score": min_score,
        # 提问人范围内最高分达到阈值的这个比例，算"差一点就找到"，归入检索缺口。
        "near_miss": round(min_score * config["near_miss_ratio"], 4),
        # 全库最高分低于它，算"连沾边的资料都没有"。
        "out_of_scope": config["out_of_scope_score"],
    }


# 全库范围：所有文档的当前版本，格式与 Storage.readable_scope 相同，另外带上文档编号到逻辑文档的映射。
def full_scope(store):
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_heads.c.doc_key, document_heads.c.owner, document_heads.c.title,
            document_heads.c.current_document_id, document_heads.c.current_version)).mappings().all()
    versions = {}
    documents = []
    heads = {}
    for row in rows:
        versions[row["current_document_id"]] = row["current_version"]
        documents.append({"document_id": row["current_document_id"], "title": row["title"],
            "version": row["current_version"], "source": "public", "owner": row["owner"], "groups": []})
        heads[row["current_document_id"]] = dict(row)
    return {"versions": versions, "documents": documents, "heads": heads}


# 重排后候选的最高分；没有召回到任何候选时为 0（这时不会调用重排），重排不可用时为 None。
def top_score(result):
    if not result["stats"].get("fused_candidates"):
        return 0.0
    if result["stats"].get("relevance_filter") != "on":
        return None
    best = 0.0
    for item in (result.get("diagnostics") or {}).get("candidates") or []:
        score = item.get("rerank_probability")
        if score is not None and score > best:
            best = score
    return round(best, 4)


# 来源对应的文档：分片编号是"版本编号:序号"。
def matched_documents(store, sources, scope):
    documents = []
    seen = set()
    for source in sources:
        document_id = str(source.get("chunk_id") or "").rsplit(":", 1)[0]
        head = scope["heads"].get(document_id)
        if head is None or head["doc_key"] in seen:
            continue
        seen.add(head["doc_key"])
        permission = store.document_permission(head["doc_key"]) if hasattr(store, "document_permission") else {
            "visibility": "private", "groups": []}
        documents.append({"title": head["title"], "doc_key": head["doc_key"], "owner": head["owner"],
            "visibility": permission["visibility"], "visibility_label": VISIBILITY_LABELS.get(permission["visibility"]),
            "groups": permission["groups"], "score": source.get("score")})
    return documents


# 检索结果里得分最高的几段资料（不论是否达标），带上原文和"提问人能不能看到"。
# 诊断信息里候选只有 80 字预览，原文按分片编号从 MySQL 取。
def top_chunks(store, result, scope_name, visible_versions, limit=CHUNK_LIMIT):
    candidates = []
    for item in (result.get("diagnostics") or {}).get("candidates") or []:
        if item.get("rerank_probability") is not None:
            candidates.append(item)
    candidates.sort(key=lambda item: item["rerank_probability"], reverse=True)
    candidates = candidates[:limit]
    texts = {}
    if candidates:
        with store.engine.connect() as connection:
            for chunk_id, text in connection.execute(select(chunks.c.id, chunks.c.text).where(
                    chunks.c.id.in_([item["chunk_id"] for item in candidates]))).all():
                texts[chunk_id] = text
    minimum = thresholds()["min_score"]
    items = []
    for item in candidates:
        document_id = str(item["chunk_id"]).rsplit(":", 1)[0]
        text = texts.get(item["chunk_id"]) or item.get("preview") or ""
        items.append({"chunk_id": item["chunk_id"], "scope": scope_name, "title": item.get("title"),
            "version": item.get("version"), "page_start": item.get("page_start"), "heading": item.get("heading"),
            "score": round(item["rerank_probability"], 4), "passed": item["rerank_probability"] >= minimum,
            "visible": document_id in visible_versions, "text": text[:CHUNK_CHARACTERS],
            "truncated": len(text) > CHUNK_CHARACTERS})
    return items


# 问题里提到了哪些业务数据（用数据查询识别数据类型的同一套关键词）。
# 带"政策、规定、流程"这类词的是在问制度，不算：例如"售后服务的规定"应该查知识库。
def data_types_in(question):
    for word in KNOWLEDGE_WORDS:
        if word in question:
            return []
    found = []
    for data_type in TYPE_PRIORITY:
        if mentions(question, data_type):
            found.append(data_type)
    return found


# 用当前的意图识别和分流规则判断这个问题会被分到哪里；规则或本地小模型能识别时不调用大模型。
def current_route(models, question):
    analysis = models.analyze_query(question, [], None)
    decision = Router().inspect(question, None, analysis)
    return {"route": decision["route"], "route_label": ROUTE_LABELS.get(decision["route"], decision["route"]),
        "classifier": analysis.get("classifier"), "reason": decision.get("reason")}


# 判断一个问题现在属于哪一类。feedback_missed：用户反馈过"资料里有却说找不到"。
def diagnose_question(store, models, owner, queries, rerank_query, scope, feedback_missed=False):
    tool = DocumentSearchTool()
    limits = thresholds()
    mine = tool.execute(store, models, owner, queries, rerank_query, parent=False)
    user_top = top_score(mine)
    if user_top is None:
        return {"category": "unknown", "reason": "重排模型不可用，无法按相关度判断", "user_top": None, "full_top": None,
            "documents": [], "chunks": []}
    visible = set(store.readable_scope(owner)["versions"]) if hasattr(store, "readable_scope") else set(scope["versions"])
    found = top_chunks(store, mine, "mine", visible)
    if mine["sources"]:
        return {"category": "answerable", "user_top": user_top, "full_top": None,
            "documents": matched_documents(store, mine["sources"], scope), "chunks": found}
    everything = tool.execute(store, models, owner, queries, rerank_query, parent=False,
        scope={"versions": scope["versions"], "documents": scope["documents"]})
    full_top = top_score(everything)
    # 只保留得分最高的一段：全库里有比提问人能看到的更高的（提问人看不到），就换成它。
    best_all = top_chunks(store, everything, "all", visible)
    if best_all and (not found or best_all[0]["score"] > found[0]["score"]):
        found = best_all
    result = {"user_top": user_top, "full_top": full_top, "documents": [], "chunks": found}
    if everything["sources"]:
        result.update(category="permission", documents=matched_documents(store, everything["sources"], scope))
        return result
    # 知识库里找不到，又提到了业务数据：看现在会被分到哪里。分到数据查询说明分流已经修好，算现在能处理。
    data_types = data_types_in(rerank_query)
    if data_types:
        routing = current_route(models, rerank_query)
        routing["data_types"] = [DATA_TYPES[data_type]["label"] for data_type in data_types]
        result["routing"] = routing
        if routing["route"] == "data":
            result.update(category="answerable", rerouted=True)
        else:
            result["category"] = "routing"
        return result
    if feedback_missed or user_top >= limits["near_miss"]:
        result["category"] = "retrieval"
    elif (full_top or 0) < limits["out_of_scope"]:
        result["category"] = "out_of_scope"
    else:
        result["category"] = "content"
    return result


# 缺口的主结论：全部现在能答才算 answerable；否则在没解决的问题里取出现最多的类别，同样多时按 PRIORITY。
def overall_category(categories):
    if categories and all(category == "answerable" for category in categories):
        return "answerable"
    remaining = [category for category in categories if category != "answerable"]
    if not remaining:
        return "unknown"
    return max(PRIORITY, key=lambda category: (remaining.count(category), -PRIORITY.index(category)))
