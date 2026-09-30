import logging
import math
import os
import time

from ..security import sanitize_source
from ..models import RerankError


logger = logging.getLogger("production-rag-search")


# RRF 平滑常数，取论文和 Milvus、Elasticsearch 的常用默认值；越大越弱化头部名次的优势。
RRF_K = 60
# 开发集对比显示候选池 12 与 20 的可回答题 Recall 都是 1.0，但 12 的平均耗时约 9.2 秒（20 约 13.6 秒），
# 且无法回答题漏放率从 0.625 降到 0.5，因此缩小候选池，保留召回质量并减少重排开销。
RERANK_CANDIDATES = 12
# 最终交给回答模型的来源数。
RETURN_LIMIT = 6
# 开发集阈值扫描显示 0.85 仍保持可回答题 Recall 1.0，并将无法回答题漏放率从 0.625 降到 0.25，故采用该默认下限。
DEFAULT_RERANK_MIN_SCORE = 0.85
# 诊断信息里正文预览的字数；完整正文已在来源中返回，这里只用于辨认候选。
PREVIEW_CHARACTERS = 80
# 诊断里权限范围最多列出的文档数。
SCOPE_DOCUMENT_LIMIT = 50
# 父子分块：检索和重排仍用 800 字的分片（子块），交给回答模型前把命中分片扩展为同一小节里相邻分片拼成的父块。
# 子块小，向量和重排判断集中、准确；但一个观点常常跨两三个分片，只给命中的那一块，回答模型看不到前因后果。
# 父块上限约三个分片的长度，最多向前后各看 3 个分片。
PARENT_MAX_CHARS = 2400
PARENT_RADIUS = 3


class DocumentSearchTool:
    """执行向量、关键词召回和结果融合。"""

    # 两阶段检索：第一阶段向量 + BM25 召回并用 RRF 融合，追求"全"；
    # 第二阶段交叉编码器只对候选池逐条细看，追求"准"，由它决定最终排序。
    # 以前只返回最终分数，无法看出每条来源为什么排在这里、为什么被丢弃；
    # 现在同时返回 diagnostics，记录每张排名表、RRF 贡献、重排概率和最终去向，供前端逐项展示。
    # 后面几个参数只供评测做消融和参数对比，线上问答全部使用默认值，行为与以前一致：
    # methods 选择召回方式（仅向量 / 仅 BM25 / 混合），pool_size 是进入重排的候选数，
    # fusion 决定多个检索词的 RRF 贡献是全部累加（sum）还是每路只取最好名次（best），
    # rerank=False 跳过重排，min_score 覆盖环境变量里的阈值。
    # 以前这些都是写死的常量，想比较"候选池 12 还是 20 更好"只能改代码重启，无法在同一份评测集上并排对比。
    def execute(self, store, models, owner, queries, rerank_query, methods=("dense", "keyword"),
                pool_size=RERANK_CANDIDATES, fusion="sum", rerank=True, min_score=None, parent=True):
        candidates = {}
        lists = []
        dense_hits = 0
        keyword_hits = 0
        # 分别记录召回和重排耗时：重排调用本地交叉编码器，是整条链路最慢、最可能超时的一步，评测需要单独观察它。
        recall_started = time.monotonic()
        # 权限范围每次检索只查一次，所有检索词和召回方式共用；范围由服务端按登录身份从 MySQL 查出，模型和前端改不了。
        # 测试和评测里的替身存储没有权限范围，这时退回各自查询、诊断里不记范围。
        scope = store.readable_scope(owner) if hasattr(store, "readable_scope") else None
        scoped = {"versions": scope["versions"]} if scope else {}
        for query in queries:
            if "dense" in methods:
                dense = store.search(owner, query, models, limit=12, **scoped)
                dense_hits += len(dense)
                lists.append(self.add_candidates(candidates, dense, "dense", query))
            if "keyword" in methods:
                keyword = store.search_keyword(owner, query, limit=30, **scoped)
                keyword_hits += len(keyword)
                lists.append(self.add_candidates(candidates, keyword, "keyword", query))
        recall_ms = round((time.monotonic() - recall_started) * 1000)
        ranked = []
        for candidate in candidates.values():
            if fusion == "best":
                candidate["rrf_score"] = self.best_rank_score(candidate["contributions"])
            candidate["final_score"] = candidate["rrf_score"]
            ranked.append(candidate)
        ranked.sort(key=lambda item: item["final_score"], reverse=True)
        for rrf_rank, item in enumerate(ranked, start=1):
            item["rrf_rank"] = rrf_rank
            item["status"] = "not_in_pool"
        # RRF 只负责挑出进入重排的候选池；池子比最终返回数大，给重排留出纠正召回排序的空间。
        pool = ranked[:pool_size]
        rerank_documents = []
        for item in pool:
            item["status"] = "in_pool"
            rerank_documents.append(item["text"])
        # 用补全了上下文的完整问题打分：交叉编码器判断"文档能否回答这个问题"，
        # 检索用的短句会丢掉指代和限定条件，例如"那它能退吗"里的"它"。
        rerank_started = time.monotonic()
        rerank_error = None
        try:
            rerank_scores = models.rerank(rerank_query, rerank_documents) if rerank and rerank_documents else None
        except RerankError as error:
            # 重排失败时仍按 RRF 顺序返回，不让问答整体失败；把原因记进统计和诊断，面板上显示"重排失败"而不是"未启用"。
            logger.warning("rerank_failed error=%s", error)
            rerank_scores = None
            rerank_error = str(error)
        rerank_ms = round((time.monotonic() - rerank_started) * 1000)
        rerank_count = 0
        filtered = 0
        threshold = min_score
        min_score = None
        if rerank_scores:
            rerank_count = len(rerank_scores)
            for item, score in zip(pool, rerank_scores):
                item["rerank_probability"] = score
                item["rerank_logit"] = self.probability_to_logit(score)
                # 以前是把截断后的重排分乘 0.5 叠加到旧分数上，截断后并列的候选又由粗糙的分数决定先后。
                # 重排是整条链路最准的信号，因此直接用它替换排序分数，不再与 RRF 混合。
                item["final_score"] = score
            pool.sort(key=lambda item: item["final_score"], reverse=True)
            for rerank_rank, item in enumerate(pool, start=1):
                item["rerank_rank"] = rerank_rank
            # 以前排序后固定取前几条，即使重排判定全部不相关也会交给模型，模型容易据此硬凑答案。
            # 现在低于阈值的候选直接丢弃；全部被丢弃时来源为空，由回答阶段确定性地拒答。
            # 阈值只能设在重排概率上：RRF 分数只反映名次，第一名永远约为 1/61，没有绝对含义；
            # 余弦相似度在不同问题和模型之间波动大，无关文本也常有 0.3 以上的分数。
            min_score = threshold
            if min_score is None:
                min_score = float(os.getenv("RERANK_MIN_SCORE", str(DEFAULT_RERANK_MIN_SCORE)))
            ranked = []
            for item in pool:
                if item["final_score"] >= min_score:
                    ranked.append(item)
                else:
                    item["status"] = "filtered_low_score"
                    filtered += 1
        # 重排关闭或调用失败时 ranked 保持 RRF 顺序且不做相关性过滤：此时没有可靠的分数可设阈值，
        # 统计中标记 relevance_filter 为 off，避免误以为结果已经过相关性检查。
        sources = []
        # 已被某个父块包含的分片 {分片 id: 来源编号}。两个命中分片在同一小节里相邻时，
        # 后一个直接归入前一个父块，不再重复给模型同一段文字；诊断里它的来源编号指向那个父块。
        covered = {}
        use_parent = parent and os.getenv("PARENT_CONTEXT", "on") != "off"
        parent_characters = 0
        injection_redacted = 0
        for index, item in enumerate(ranked, start=1):
            if index > RETURN_LIMIT:
                item["status"] = "beyond_limit"
                continue
            item["status"] = "returned"
            if item["id"] in covered:
                item["source_id"] = covered[item["id"]]
                continue
            item["source_id"] = f"S{len(sources) + 1}"
            text = item["text"]
            chunk_ids = [item["id"]]
            if use_parent:
                expanded = self.parent_context(store, item, covered)
                if expanded:
                    text, chunk_ids = expanded
            for chunk_id in chunk_ids:
                covered[chunk_id] = item["source_id"]
            # 来源在交给充分性判断和回答模型之前先清理注入：命中规则的整句替换掉，伪造的 <source> 标签失效。
            # 放在检索工具里而不是回答节点，补充检索、评测检索拿到的来源也都经过同一道清理。
            text, injection_hits = sanitize_source(text)
            if injection_hits:
                injection_redacted += 1
            parent_characters += len(text)
            # 带上版本号、页码和标题路径，回答来源和诊断面板可以确认命中的是当前版本的哪个位置。
            # text 是交给回答模型的父块；chunk_id 是实际命中的子块，parent_chunk_ids 是父块由哪些分片拼成。
            sources.append({"id": item["source_id"], "title": item["title"], "text": text,
                "score": round(item["final_score"], 6),
                "retrieval_methods": item["retrieval_methods"], "version": item.get("version"),
                "page_start": item.get("page_start"), "heading": item.get("heading"),
                "chunk_id": item["id"], "parent_chunk_ids": chunk_ids, "injection": injection_hits})
        stats = {"queries": len(queries), "dense_hits": dense_hits,
            "keyword_hits": keyword_hits, "fused_candidates": len(candidates),
            "rerank_query": rerank_query, "reranked": rerank_count,
            "rerank_model": getattr(models, "rerank_model", os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-base")),
            "relevance_filter": "on" if min_score is not None else "off",
            "min_score": min_score, "filtered": filtered, "returned": len(sources),
            "parent_context": "on" if use_parent else "off", "source_characters": parent_characters,
            "recall_ms": recall_ms, "rerank_ms": rerank_ms, "injection_redacted": injection_redacted,
            "rerank_error": rerank_error}
        reranked = rerank_count > 0
        diagnostics = self.build_diagnostics(candidates, lists, stats, reranked, pool_size, fusion, methods)
        if scope:
            diagnostics["scope"] = self.scope_summary(scope["documents"])
        return {"sources": sources, "stats": stats, "diagnostics": diagnostics}

    # 权限范围的摘要：按自己上传 / 共享给我 / 公开分别计数，文档列表最多保留 50 份，避免追踪记录过大。
    @staticmethod
    def scope_summary(documents_in_scope):
        counts = {"own": 0, "shared": 0, "public": 0}
        groups = []
        for item in documents_in_scope:
            counts[item["source"]] += 1
            for name in item["groups"]:
                if name not in groups:
                    groups.append(name)
        return {"total": len(documents_in_scope), **counts, "groups": groups,
            "documents": documents_in_scope[:SCOPE_DOCUMENT_LIMIT]}

    # 余弦分数和 BM25 分数量纲不同，不直接相加；每张排名表只贡献 1 / (RRF_K + 名次)。
    # 同时返回这张排名表本身，诊断信息据此展示每一路召回的原始名次和分数。
    @staticmethod
    def add_candidates(candidates, rows, method, query):
        hits = []
        for rank, row in enumerate(rows, start=1):
            key = row.get("id") or f"{row['title']}:{row['text']}"
            item = candidates.setdefault(key, {"id": key, "title": row["title"], "text": row["text"],
                "rrf_score": 0.0, "retrieval_methods": [], "contributions": [],
                "version": row.get("version"), "page_start": row.get("page_start"),
                "heading": row.get("heading"), "chunk_key": row.get("chunk_key"),
                "document_id": row.get("document_id"), "position": row.get("position")})
            contribution = 1 / (RRF_K + rank)
            item["rrf_score"] += contribution
            if method not in item["retrieval_methods"]:
                item["retrieval_methods"].append(method)
            item["contributions"].append({"query": query, "method": method, "rank": rank,
                "raw_score": round(float(row.get("score", 0)), 6), "rrf": round(contribution, 6)})
            hits.append({"rank": rank, "chunk_id": str(key), "title": row["title"],
                "raw_score": round(float(row.get("score", 0)), 6), "rrf": round(contribution, 6)})
        return {"query": query, "method": method, "hits": hits}

    # 检索充分性判断与补充检索。第一次判断为 insufficient 或 partial 且模型给出了补充检索词时，
    # 把补充检索词加进原来的检索词再检索一次（重排仍用完整问题），然后再判断一次；
    # 补充检索后判断反而变差（partial 变 insufficient）或检索为空时，退回第一次的来源和结论，
    # 补充检索只能让结果变好，不能把原本能回答一部分的问题变成拒答。
    # 最终仍是 insufficient 就清空来源，由回答阶段确定性地拒答，不让模型拿无关资料硬凑答案。
    # 只补检索一次：多轮循环会让延迟成倍增加，而第二次还找不到时再换说法通常也找不到。
    # partial 不拒答，把缺少的内容交给回答阶段，让模型只回答资料支持的部分并说明缺什么。
    # 演示模式没有聊天模型、或 SUFFICIENCY_CHECK=off、或来源已为空（重排阈值已过滤光）时不判断。
    VERDICT_RANK = {"insufficient": 0, "partial": 1, "sufficient": 2}

    def check_sufficiency(self, store, models, owner, queries, rerank_query, retrieval):
        result = {"checked": False, "verdict": None, "missing": "", "judgements": [], "retried": False,
            "retry_query": None, "retrieval": retrieval, "sources": retrieval["sources"], "refused": False}
        if models.mode != "openai" or os.getenv("SUFFICIENCY_CHECK", "on") == "off" or not retrieval["sources"]:
            return result
        result["checked"] = True
        judgement = models.judge_sufficiency(rerank_query, retrieval["sources"])
        result["judgements"].append(judgement)
        rewrite = judgement["rewrite_query"]
        if judgement["verdict"] in {"insufficient", "partial"} and rewrite and rewrite not in queries:
            retry_queries = list(queries)
            retry_queries.append(rewrite)
            retry = self.execute(store, models, owner, retry_queries, rerank_query)
            result.update({"retried": True, "retry_query": rewrite, "retry_retrieval": retry})
            if retry["sources"]:
                second = models.judge_sufficiency(rerank_query, retry["sources"])
                result["judgements"].append(second)
                if self.VERDICT_RANK[second["verdict"]] >= self.VERDICT_RANK[judgement["verdict"]]:
                    judgement = second
                    result["retrieval"] = retry
            result["retry_used"] = result["retrieval"] is retry
        result["verdict"] = judgement["verdict"]
        result["missing"] = judgement["missing"]
        result["refused"] = judgement["verdict"] == "insufficient"
        result["sources"] = [] if result["refused"] else result["retrieval"]["sources"]
        return result

    # 把命中的子块扩展为父块，返回 (父块文字, 组成父块的分片 id 列表)；找不到分片记录时返回 None，沿用子块。
    # 父块只在同一小节（标题路径相同）内扩展：跨小节拼接会把无关话题塞给模型。
    # 从命中分片开始交替向前、向后各加一个相邻分片，直到超出长度上限、离开小节或碰到已被其他父块包含的分片。
    @staticmethod
    def parent_context(store, item, covered):
        if item.get("document_id") is None or item.get("position") is None:
            return None
        rows = store.neighbor_chunks(item["document_id"], item["position"], PARENT_RADIUS)
        hit = None
        for index, row in enumerate(rows):
            if row["id"] == item["id"]:
                hit = index
        if hit is None:
            return None
        path = (rows[hit]["chunk_metadata"] or {}).get("heading_path") or []

        # 相邻分片可以并入父块：同一小节、未被其他父块包含。
        def joinable(index):
            if index < 0 or index >= len(rows) or rows[index]["id"] in covered:
                return False
            return ((rows[index]["chunk_metadata"] or {}).get("heading_path") or []) == path

        start = hit
        end = hit
        total = len(rows[hit]["content"] or rows[hit]["text"] or "")
        grew = True
        while grew:
            grew = False
            for index in (start - 1, end + 1):
                if not joinable(index):
                    continue
                length = len(rows[index]["content"] or rows[index]["text"] or "")
                if total + length > PARENT_MAX_CHARS:
                    continue
                total += length
                start = min(start, index)
                end = max(end, index)
                grew = True
        parts = []
        chunk_ids = []
        for index in range(start, end + 1):
            row = rows[index]
            content = row["content"] or row["text"] or ""
            # 相邻分片开头有和上一片重叠的文字（effective_overlap 个字），拼接时去掉，避免同一句话出现两次。
            if index > start:
                overlap = (row["chunk_metadata"] or {}).get("effective_overlap") or 0
                content = content[overlap:].lstrip("\n")
            parts.append(content)
            chunk_ids.append(row["id"])
        body = "\n".join(parts)
        heading = " / ".join(path)
        text = f"标题路径：{heading}\n{body}" if heading else body
        return text, chunk_ids

    # "取最好名次"：同一路召回（向量或 BM25）在多个检索词下命中同一片段时，只保留名次最好的那次贡献，再把各路相加。
    # 默认的"全部累加"会让被多个检索词同时命中的片段得分翻倍；如果改写出的检索词彼此相近，
    # 这种翻倍只是重复计数，未必说明更相关。两种做法哪个好需要评测决定，因此都保留。
    @staticmethod
    def best_rank_score(contributions):
        best = {}
        for contribution in contributions:
            method = contribution["method"]
            if contribution["rrf"] > best.get(method, 0):
                best[method] = contribution["rrf"]
        total = 0.0
        for value in best.values():
            total += value
        return total

    # 重排接口只返回 sigmoid 后的概率；logit 由概率反推，便于对照模型原始输出。
    # 概率落在 0 或 1 时 logit 为无穷大，返回 None 避免 JSON 无法序列化。
    @staticmethod
    def probability_to_logit(probability):
        if probability <= 0 or probability >= 1:
            return None
        return round(math.log(probability / (1 - probability)), 4)

    # 汇总每个候选从召回到最终去向的完整计算过程，排序与最终处理顺序一致。
    @staticmethod
    def build_diagnostics(candidates, lists, stats, reranked, pool_size=RERANK_CANDIDATES, fusion="sum",
                          methods=("dense", "keyword")):
        status_order = {"returned": 0, "beyond_limit": 1, "filtered_low_score": 2,
            "in_pool": 3, "not_in_pool": 4}
        items = []
        for item in candidates.values():
            items.append(item)
        items.sort(key=lambda item: (status_order[item["status"]],
            item.get("rerank_rank", 0) if reranked else item["rrf_rank"], item["rrf_rank"]))
        rows = []
        for item in items:
            # 主键是"版本 id:序号"，不能再截断前几位，否则同一版本的分片会显示成同一个 ID。
            rows.append({"chunk_id": str(item["id"]), "chunk_key": item.get("chunk_key"), "title": item["title"],
                "version": item.get("version"), "page_start": item.get("page_start"),
                "heading": item.get("heading"),
                "preview": item["text"][:PREVIEW_CHARACTERS],
                "status": item["status"], "source_id": item.get("source_id"),
                "retrieval_methods": item["retrieval_methods"],
                "contributions": item["contributions"],
                "rrf_score": round(item["rrf_score"], 6), "rrf_rank": item["rrf_rank"],
                "rerank_logit": item.get("rerank_logit"),
                "rerank_probability": round(item["rerank_probability"], 6)
                    if "rerank_probability" in item else None,
                "rerank_rank": item.get("rerank_rank")})
        # 候选池、融合方式和召回方式写进诊断配置，评测对比不同参数时能看出每次实际用的是哪一组。
        config = {"rrf_k": RRF_K, "rerank_candidates": pool_size, "fusion": fusion, "methods": list(methods),
            "return_limit": RETURN_LIMIT, "reranked": reranked,
            "min_score": stats["min_score"], "rerank_query": stats["rerank_query"],
            "rerank_model": stats["rerank_model"], "rerank_error": stats.get("rerank_error")}
        return {"config": config, "lists": lists, "candidates": rows}
