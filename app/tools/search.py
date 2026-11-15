from contextvars import copy_context
from ..retrieval_policy import selected_methods, selected_scope
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import logging
import math
import os
import threading
import time

from ..graph import retrieve as graph_retrieve
from ..security import sanitize_source
from ..models import RerankError
from ..runtime_config import BY_KEY, snapshot as runtime_snapshot


logger = logging.getLogger("production-rag-search")


# 检索参数（RRF 平滑常数、候选池、交给模型的段数、相关度阈值、父子分块）都可以在设置页修改，
# 读取和默认值的来由见 app/runtime_config.py。下面两个只影响诊断页面的显示，不放进设置页。
# 原默认值留在这里，供还在引用它们的地方使用（例如诊断阈值的兜底）。
DEFAULT_RERANK_MIN_SCORE = BY_KEY["rerank_min_score"]["default"]
RERANK_CANDIDATES = BY_KEY["rerank_candidates"]["default"]
# 诊断信息里正文预览的字数；完整正文已在来源中返回，这里只用于辨认候选。
PREVIEW_CHARACTERS = 80
# 诊断里权限范围最多列出的文档数。
SCOPE_DOCUMENT_LIMIT = 50

# 某个账号这段时间只检索哪几份文档：{owner: 标题集合}。给评测用：评测开跑时勾选了语料库里的几份，
# 评测账号就只检索这几份（见 app/evaluation/corpus.py）。固定流程、补充检索、Agent 的 search_knowledge、
# 完整问答流程最后都调用 execute，所以只在这里过滤一次，不用把范围一层层传下去。
# 评测在后台线程里跑，同一时间只有一个（eval_lock），开跑时设、结束时清。
_title_limits = {}
_title_limits_lock = threading.Lock()


@contextmanager
def limit_titles(owner, titles):
    with _title_limits_lock:
        _title_limits[owner] = frozenset(titles)
    try:
        yield
    finally:
        with _title_limits_lock:
            _title_limits.pop(owner, None)


def title_limit(owner):
    with _title_limits_lock:
        return _title_limits.get(owner)


# 交给回答模型的一条图谱关系：起点 → 终点（分类）：描述。原文引用：「……」。不写出处，出处由 G 编号在界面上对应。
def relation_context_text(row):
    description = (row.get("description") or "").strip().rstrip("。")
    text = f"{row.get('source')} → {row.get('target')}（{row.get('category')}）：{description}"
    quotes = [
        part.strip() for part in (row.get("evidence") or "").split("||") if part.strip()
    ]
    if quotes:
        text += "。原文引用：" + "".join(f"「{quote}」" for quote in quotes)
    return text


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
    def execute(
        self,
        store,
        models,
        owner,
        queries,
        rerank_query,
        methods=None,
        pool_size=None,
        fusion="sum",
        rerank=True,
        min_score=None,
        parent=True,
        scope=None,
        return_limit=None,
        excellent_score=None,
        graph_keywords=None,
        graph_question=None,
        graph_question_source=None,
    ):
        # 一次检索只读一次参数，整条检索用同一份；实际用到的值写进诊断配置，事后能查到这次用的是哪组参数。
        config = runtime_snapshot()
        # 召回方式：不传就是向量 + 关键词，设置页打开了图检索再加上图（固定流程、Agent 的 hybrid 都走这里）。
        # 调用方明确传了 methods（Agent 的 vector / keyword 模式、评测的消融）时，只有里面有 graph 才走图。
        if selected_methods() is not None:
            methods = selected_methods()
        if methods is None:
            methods = ("dense", "keyword") + (
                ("graph",) if config.get("graph_retrieval") else ()
            )
        methods = tuple(methods)
        # pool_size 只管按 RRF 名次进重排的那一份；只被图找到的分片另有上限（graph_chunk_rerank_candidates）。
        if pool_size is None:
            pool_size = config["rerank_candidates"]
        graph_pool_size = (
            int(config.get("graph_chunk_rerank_candidates") or 0)
            if "graph" in methods
            else 0
        )
        candidates = {}
        lists = []
        dense_hits = 0
        keyword_hits = 0
        # 分别记录召回和重排耗时：重排调用本地交叉编码器，是整条链路最慢、最可能超时的一步，评测需要单独观察它。
        recall_started = time.monotonic()
        # 权限范围每次检索只查一次，所有检索词和召回方式共用；范围由服务端按登录身份从 MySQL 查出，模型和前端改不了。
        # 测试和评测里的替身存储没有权限范围，这时退回各自查询、诊断里不记范围。
        # scope 只给知识巡检用：传入全库范围，判断"提问人看不到、但知识库里其实有"的权限缺口。线上问答不传。
        scope_started = time.monotonic()
        if selected_scope() is not None:
            scope = selected_scope()
        if scope is None and owner == "eval" and hasattr(store, "engine"):
            from ..evaluation.document_refs import scope as evaluation_scope

            scope = evaluation_scope(store.engine)
        if scope is None:
            scope = (
                store.readable_scope(owner)
                if hasattr(store, "readable_scope")
                else None
            )
        scope_ms = round((time.monotonic() - scope_started) * 1000)
        limit = title_limit(owner)
        if limit is not None and scope is not None:
            kept = [item for item in scope["documents"] if item["title"] in limit]
            scope = {
                "versions": {item["document_id"]: item["version"] for item in kept},
                "documents": kept,
            }
        scoped = {"versions": scope["versions"]} if scope else {}
        # 图检索（提关键词要调用模型，最慢）放到另一个线程，和向量、关键词两路同时进行。
        graph_future = None
        graph_executor = None
        if "graph" in methods:
            graph_executor = ThreadPoolExecutor(max_workers=1)
            graph_future = graph_executor.submit(
                copy_context().run,
                self.graph_recall,
                store,
                models,
                graph_question or rerank_query,
                scope,
                config,
                graph_keywords,
                graph_question_source,
            )
        dense_ms = 0
        keyword_ms = 0
        for query in queries:
            if "dense" in methods:
                started = time.monotonic()
                dense = store.search(owner, query, models, limit=12, **scoped)
                dense_ms += round((time.monotonic() - started) * 1000)
                dense_hits += len(dense)
                lists.append(
                    self.add_candidates(
                        candidates, dense, "dense", query, config["rrf_k"]
                    )
                )
            if "keyword" in methods:
                started = time.monotonic()
                keyword = store.search_keyword(owner, query, limit=30, **scoped)
                keyword_ms += round((time.monotonic() - started) * 1000)
                keyword_hits += len(keyword)
                lists.append(
                    self.add_candidates(
                        candidates, keyword, "keyword", query, config["rrf_k"]
                    )
                )
        graph = None
        graph_hits = 0
        if graph_future is not None:
            graph = graph_future.result()
            graph_executor.shutdown(wait=False)
            graph_tables = (
                (("unified", "图检索"),)
                if "unified" in graph.get("sources", {})
                else (("entity", "图 · 实体"), ("relation", "图 · 关系"))
            )
            for table, label in graph_tables:
                rows = graph.get("sources", {}).get(table) or []
                graph_hits += len(rows)
                listing = self.add_candidates(
                    candidates, rows, "graph", label, config["rrf_k"]
                )
                listing["table"] = table
                for row, hit in zip(rows, listing["hits"]):
                    hit["relation_ids"] = row.get("relation_ids") or []
                    item = candidates[hit["chunk_id"]]
                    linked = item.setdefault("graph_relation_ids", [])
                    for relation_id in hit["relation_ids"]:
                        if relation_id not in linked:
                            linked.append(relation_id)
                if graph.get("status") == "ok":
                    lists.append(listing)
        recall_ms = round((time.monotonic() - recall_started) * 1000)
        ranked = []
        for candidate in candidates.values():
            if fusion == "best":
                candidate["rrf_score"] = self.best_rank_score(
                    candidate["contributions"]
                )
            candidate["final_score"] = candidate["rrf_score"]
            ranked.append(candidate)
        ranked.sort(key=lambda item: item["final_score"], reverse=True)
        for rrf_rank, item in enumerate(ranked, start=1):
            item["rrf_rank"] = rrf_rank
            item["status"] = "not_in_pool"

        # 交给重排的候选分两份：
        #   1. RRF 候选：向量、关键词找到的分片（图也找到的照样有图的 RRF 分），按 RRF 名次取前 pool_size 个；
        #   2. 图独有候选：只被图找到的分片不和其他分片比 RRF 名次，按图检索的名次取前 graph_pool_size 个。
        # 图只有一张排名表，向量、关键词每个检索词各一张，只被图找到的分片 RRF 分数天生低，比名次几乎进不了候选池。
        # LightRAG 也是把图带回的分片直接和向量分片一起交给重排，不先按名次筛。
        def graph_only(item):
            return set(item["retrieval_methods"]) == {"graph"}

        def graph_rank(item):
            return min(
                contribution["rank"]
                for contribution in item["contributions"]
                if contribution["method"] == "graph"
            )

        pool = [item for item in ranked if not graph_only(item)][:pool_size]
        for item in pool:
            item["pool_via"] = "rrf"
        graph_candidates = sorted(
            (item for item in ranked if graph_only(item)),
            key=lambda item: (graph_rank(item), item["rrf_rank"]),
        )
        for graph_only_rank, item in enumerate(graph_candidates, start=1):
            item["graph_only_rank"] = graph_only_rank
            if graph_only_rank <= graph_pool_size:
                item["pool_via"] = "graph"
                pool.append(item)
        graph_pool_count = min(len(graph_candidates), graph_pool_size)
        rerank_documents = []
        for item in pool:
            item["status"] = "in_pool"
            rerank_documents.append(item["text"])
        # 用补全了上下文的完整问题打分：交叉编码器判断"文档能否回答这个问题"，
        # 检索用的短句会丢掉指代和限定条件，例如"那它能退吗"里的"它"。
        rerank_started = time.monotonic()
        rerank_error = None
        try:
            rerank_scores = (
                models.rerank(rerank_query, rerank_documents)
                if rerank and rerank_documents
                else None
            )
        except RerankError as error:
            # 重排失败时仍按 RRF 顺序返回，不让问答整体失败；把原因记进统计和诊断，面板上显示"重排失败"而不是"未启用"。
            logger.warning("rerank_failed error=%s", error)
            rerank_scores = None
            rerank_error = str(error)
        rerank_ms = round((time.monotonic() - rerank_started) * 1000)
        rerank_count = 0
        filtered = 0
        fallback_used = False
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
                min_score = config["rerank_min_score"]
            ranked = []
            for item in pool:
                if item["final_score"] >= min_score:
                    ranked.append(item)
                else:
                    item["status"] = "filtered_low_score"
                    filtered += 1
            # 兜底：全部低于阈值时，最高的一条只要高于兜底分数线，就单独返回这一条并标明相关性较低，
            # 交给后面的模型（充分性判断、回答模型、Agent）自己判断是否切题，不再直接当作没找到。
            fallback = config["rerank_fallback_min_score"]
            if not ranked and pool and pool[0]["final_score"] > fallback:
                pool[0]["low_relevance"] = True
                ranked = [pool[0]]
                filtered -= 1
                fallback_used = True
        # 重排关闭或调用失败时 ranked 保持 RRF 顺序且不做相关性过滤：此时没有可靠的分数可设阈值，
        # 统计中标记 relevance_filter 为 off，避免误以为结果已经过相关性检查。
        sources = []
        budget_mode = config.get("source_selection_mode") == "tokens"
        token_budget = config.get("source_token_budget", 8000)
        tokens_used = 0
        child_tokens = 0
        expansion_skipped = 0
        budget_skipped = 0
        if budget_mode:
            from ..memory.framework import text_tokens
        graph_budget = (
            int(token_budget * config.get("source_graph_budget_ratio", 0.25))
            if budget_mode and "graph" in methods
            else 0
        )
        graph_guaranteed = set()
        graph_budget_used = 0
        # 图谱关系：图检索统一重排后留下的关系，按关系重排名次先放进图保底额度（不设占比上限），
        # 剩下的保底额度再给只有图找到的分片。放不下的关系跳过、试下一条，和分片的填充规则一致。
        relations, relation_rows, relation_reason = self.select_relations(
            graph,
            budget_mode,
            graph_budget,
            bool(rerank_count) and not fallback_used,
        )
        for row in relations:
            graph_budget_used += row["tokens"]
        # 只保底真正通过相关性过滤的图候选；没有可靠重排分数时仍按公共排名选取。
        # 只保底「仅图检索找到」的分片：向量 / 关键词也找到的分片本来就在公共竞争里，
        # 让它占保底等于把保底用在本来就能入选的内容上，挤掉图独有的证据。
        if graph_budget and rerank_count and not fallback_used:
            for item in ranked:
                if set(item["retrieval_methods"]) != {"graph"}:
                    continue
                clean_text, _ = sanitize_source(item["text"])
                size = text_tokens(clean_text)
                if graph_budget_used + size <= graph_budget:
                    graph_guaranteed.add(item["id"])
                    graph_budget_used += size
            tokens_used = graph_budget_used
        # 已被某个父块包含的分片 {分片 id: 来源编号}。两个命中分片在同一小节里相邻时，
        # 后一个直接归入前一个父块，不再重复给模型同一段文字；诊断里它的来源编号指向那个父块。
        covered = {}
        use_parent = parent and config["parent_context"]
        # 最多返回几条：不传就用设置页的 return_limit（固定流程）；Agent 传自己的 agent_return_limit。
        limit = config["return_limit"] if return_limit is None else return_limit
        # 优秀阈值：重排得分不低于它的全部返回，不受上面的条数限制；不传就用设置页的（固定流程），Agent 传自己的。
        # 1.0 表示不启用。没有重排分（重排关闭或失败）、兜底返回时也不启用。ranked 已按得分从高到低排好，
        # 优秀的都在最前面，所以遇到优秀分片时直接放行，不用把条数整体放宽。
        excellent = (
            config["rerank_excellent_score"]
            if excellent_score is None
            else excellent_score
        )
        if excellent >= 1 or not rerank_count or fallback_used:
            excellent = None
        base_limit = limit
        beyond_limit = 0
        parent_characters = 0
        injection_redacted = 0
        for item in ranked:
            # 已经被前面的父块包含：内容就在某条来源里，不单独成源，也不占返回名额。
            # 诊断里它的来源编号指向那个父块，并标出「已并入」，免得看成重复返回。
            if item["id"] in covered:
                item["status"] = "returned"
                item["source_id"] = covered[item["id"]]
                item["merged"] = True
                continue
            # 返回条数按实际产出的来源数算：并进来的分片不占名额，所以这里数的是已产出的来源条数。
            # 优秀阈值之上的分片不受条数限制，照样单独成源。
            if (
                not budget_mode
                and len(sources) >= limit
                and not (excellent is not None and item["final_score"] >= excellent)
            ):
                item["status"] = "beyond_limit"
                beyond_limit += 1
                continue
            if budget_mode:
                clean_text, _ = sanitize_source(item["text"])
                size = text_tokens(clean_text)
                item["source_tokens"] = size
                item["graph_budget_guaranteed"] = item["id"] in graph_guaranteed
                additional = 0 if item["graph_budget_guaranteed"] else size
                if tokens_used + additional > token_budget:
                    item["status"] = "beyond_budget"
                    budget_skipped += 1
                    continue
                tokens_used += additional
            item["status"] = "returned"
            item["source_id"] = f"S{len(sources) + 1}"
            text = item["text"]
            chunk_ids = [item["id"]]
            # 父块由哪几片组成、每片多长：回答步骤据此显示"命中第几片、拼接了哪几片"，并在全文里高亮命中的那片。
            parts = [
                {
                    "chunk_id": item["id"],
                    "position": item.get("position"),
                    "chars": len(text),
                    "context": item.get("context"),
                }
            ]
            if use_parent and not budget_mode:
                expanded = self.parent_context(
                    store,
                    item,
                    covered,
                    config["parent_radius"],
                    config["parent_max_chars"],
                )
                if expanded:
                    text, chunk_ids, parts = expanded
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
            sources.append(
                {
                    "id": item["source_id"],
                    "title": item["title"],
                    "text": text,
                    "score": round(item["final_score"], 6),
                    "retrieval_methods": item["retrieval_methods"],
                    "version": item.get("version"),
                    "page_start": item.get("page_start"),
                    "heading": item.get("heading"),
                    "chunk_id": item["id"],
                    "position": item.get("position"),
                    "document_id": item.get("document_id"),
                    "parent_chunk_ids": chunk_ids,
                    "parent_parts": parts,
                    "injection": injection_hits,
                    # relevance：重排模型给出的相关性（0～1），交给模型时一起写上；没有重排时 score 只是名次分，不写。
                    "relevance": round(item["final_score"], 2)
                    if rerank_count
                    else None,
                    "low_relevance": bool(item.get("low_relevance")),
                }
            )
        if budget_mode:
            child_tokens = tokens_used
            # 所有原始命中先占预算、登记覆盖；第二轮扩展不能吞掉其他命中。
            if use_parent:
                by_id = {item["id"]: item for item in ranked}
                for source in sources:
                    expanded = self.parent_context(
                        store,
                        by_id[source["chunk_id"]],
                        covered,
                        config["parent_radius"],
                        config["parent_max_chars"],
                    )
                    if not expanded:
                        continue
                    text, chunk_ids, parts = expanded
                    if len(chunk_ids) <= 1:
                        continue
                    clean, injection_hits = sanitize_source(text)
                    new_tokens = text_tokens(clean)
                    old_tokens = text_tokens(source["text"])
                    if tokens_used - old_tokens + new_tokens > token_budget:
                        expansion_skipped += 1
                        continue
                    tokens_used += new_tokens - old_tokens
                    source.update(
                        text=clean,
                        parent_chunk_ids=chunk_ids,
                        parent_parts=parts,
                        injection=injection_hits,
                    )
                    for chunk_id in chunk_ids:
                        covered[chunk_id] = source["id"]
                for item in ranked:
                    if item["id"] in covered and item["status"] == "beyond_budget":
                        item.update(
                            status="returned",
                            source_id=covered[item["id"]],
                            merged=True,
                        )
                        budget_skipped -= 1
            parent_characters = sum(len(source["text"]) for source in sources)
        stats = {
            "queries": len(queries),
            "dense_hits": dense_hits,
            "keyword_hits": keyword_hits,
            "graph_hits": graph_hits,
            "scope_ms": scope_ms,
            "dense_ms": dense_ms,
            "keyword_ms": keyword_ms,
            "graph_ms": (graph or {}).get("timings", {}).get("total_ms"),
            "fused_candidates": len(candidates),
            "rerank_query": rerank_query,
            "reranked": rerank_count,
            "rerank_model": getattr(
                models,
                "rerank_model",
                os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-base"),
            ),
            "relevance_filter": "on" if min_score is not None else "off",
            "min_score": min_score,
            "filtered": filtered,
            "returned": len(sources),
            "parent_context": "on" if use_parent else "off",
            "source_characters": parent_characters,
            "graph_pool_size": graph_pool_size,
            "graph_pool_count": graph_pool_count,
            "source_graph_budget_ratio": config.get("source_graph_budget_ratio", 0.25),
            "source_graph_budget_reserved": graph_budget,
            "source_graph_budget_used": graph_budget_used,
            "source_graph_budget_count": len(graph_guaranteed),
            "source_graph_relation_count": len(relations),
            "source_graph_relation_tokens": sum(row["tokens"] for row in relations),
            "source_graph_relation_skipped": sum(
                1 for row in relation_rows if row["status"] == "beyond_budget"
            ),
            "source_selection_mode": "tokens" if budget_mode else "count",
            "source_token_budget": token_budget if budget_mode else None,
            "source_tokens_used": tokens_used if budget_mode else None,
            "source_child_tokens": child_tokens if budget_mode else None,
            "source_tokens_estimated": budget_mode,
            "source_budget_skipped": budget_skipped,
            "source_expansion_skipped": expansion_skipped,
            "recall_ms": recall_ms,
            "rerank_ms": rerank_ms,
            "injection_redacted": injection_redacted,
            "rerank_error": rerank_error,
            "fallback_used": fallback_used,
            "fallback_min_score": config["rerank_fallback_min_score"]
            if rerank_count
            else None,
            "return_limit": base_limit,
            "beyond_limit": beyond_limit,
            # 优秀阈值（没启用是 None）和返回的资料里有几条不低于它；Agent 据此不受自己要的 top_k 限制。
            "excellent_score": excellent,
            "excellent": sum(1 for source in sources if source["score"] >= excellent)
            if excellent is not None
            else 0,
        }
        reranked = rerank_count > 0
        # 诊断里记实际生效的返回上限和是否做了父块扩展（调用方可能传了和设置页不同的值）。
        diagnostics = self.build_diagnostics(
            candidates,
            lists,
            stats,
            reranked,
            pool_size,
            fusion,
            methods,
            {
                **config,
                "return_limit": base_limit,
                "parent_context": use_parent,
                "excellent_score": excellent,
            },
        )
        if scope:
            diagnostics["scope"] = self.scope_summary(scope["documents"])
        # 每一步、每一路的耗时：检索过程拆成「权限范围 / 混合检索 / 重排与过滤」三步显示时用。
        diagnostics["timings"] = {
            "scope_ms": scope_ms,
            "dense_ms": dense_ms,
            "keyword_ms": keyword_ms,
            "graph_ms": stats["graph_ms"],
            "recall_ms": recall_ms,
            "rerank_ms": rerank_ms,
        }
        if graph is not None:
            # 两张图排名表的来源正文已经在候选里，诊断里不再重复存。
            diagnostics["graph"] = {
                key: value for key, value in graph.items() if key != "sources"
            }
            if scope:
                diagnostics["scope"]["graph_versions"] = graph.get("scope") or []
            # 图检索留下的关系和去向：放进上下文（G 编号）还是额度不够没放；没放任何关系时写明原因。
            diagnostics["context_relations"] = {
                "reason": relation_reason,
                "items": relation_rows,
            }
        return {
            "sources": sources,
            "relations": relations,
            "stats": stats,
            "diagnostics": diagnostics,
        }

    # 选出放进上下文的图谱关系。返回 (交给模型的关系, 诊断里每条留下的关系及去向, 一条关系都没放时的原因)。
    # 只在 token 预算模式、图保底比例大于 0、分片重排成功、关系重排成功时放；
    # 关系的条数不单独设上限，由图检索留下的关系（关系重排分数线、关系保留上限）和图保底额度决定。
    @staticmethod
    def select_relations(graph, budget_mode, graph_budget, reranked):
        if graph is None or graph.get("status") != "ok":
            return [], [], None
        kept = [
            row for row in graph.get("relation_candidates") or [] if row.get("kept")
        ]
        kept.sort(
            key=lambda row: (
                row.get("selection_rank") or float("inf"),
                row.get("rerank_rank") or float("inf"),
                row.get("fusion_rank") or float("inf"),
            )
        )
        if not budget_mode:
            reason = "按条数选来源时不放图谱关系，只在 token 预算模式下放"
        elif not graph_budget:
            reason = "图保底比例为 0，不放图谱关系"
        elif not reranked:
            reason = "分片重排未成功或走了兜底，未启用图保底"
        elif graph.get("relation_rerank_error"):
            reason = "关系重排失败，不放图谱关系"
        elif not kept:
            reason = "图检索没有留下关系"
        else:
            reason = None
        relations = []
        rows = []
        used = 0
        if reason is None:
            from ..memory.framework import text_tokens
        for row in kept:
            text, injection_hits = sanitize_source(relation_context_text(row))
            item = {
                "relation_id": row["relation_id"],
                "source": row.get("source"),
                "target": row.get("target"),
                "category": row.get("category"),
                "description": row.get("description"),
                "evidence": row.get("evidence"),
                "chunk_id": row.get("chunk_id"),
                "document_id": row.get("document_id"),
                "title": row.get("title"),
                "version": row.get("version_number"),
                "rerank_score": row.get("rerank_score"),
                "rerank_rank": row.get("rerank_rank"),
                "text": text,
                "injection": injection_hits,
                "tokens": None,
                "context_id": None,
                "status": "off",
            }
            if reason is None:
                size = text_tokens(text)
                item["tokens"] = size
                if used + size <= graph_budget:
                    used += size
                    item.update(status="context", context_id=f"G{len(relations) + 1}")
                    relations.append(
                        {
                            "id": item["context_id"],
                            **{
                                key: value
                                for key, value in item.items()
                                if key not in ("context_id", "status")
                            },
                        }
                    )
                else:
                    item["status"] = "beyond_budget"
            rows.append(item)
        return relations, rows, reason

    # 图检索这一路：失败不影响向量、关键词两路，诊断里写明原因。
    @staticmethod
    def graph_recall(
        store, models, question, scope, config, keywords=None, question_source=None
    ):
        if scope is None:
            return graph_retrieve.empty(
                "skipped", "这次检索没有权限范围（测试替身），不走图检索"
            )
        keywords = keywords or {}
        try:
            return graph_retrieve.retrieve(
                store,
                models,
                question,
                scope,
                config,
                entities=keywords.get("entities"),
                themes=keywords.get("themes"),
                question_source=question_source,
            )
        except Exception as error:
            logger.exception("graph_recall_failed")
            return graph_retrieve.empty("failed", f"图检索失败：{str(error)[:300]}")

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
        return {
            "total": len(documents_in_scope),
            **counts,
            "groups": groups,
            "documents": documents_in_scope[:SCOPE_DOCUMENT_LIMIT],
        }

    # 余弦分数和 BM25 分数量纲不同，不直接相加；每张排名表只贡献 1 / (rrf_k + 名次)。
    # 同时返回这张排名表本身，诊断信息据此展示每一路召回的原始名次和分数。
    @staticmethod
    def add_candidates(candidates, rows, method, query, rrf_k):
        hits = []
        for rank, row in enumerate(rows, start=1):
            key = row.get("id") or f"{row['title']}:{row['text']}"
            item = candidates.setdefault(
                key,
                {
                    "id": key,
                    "title": row["title"],
                    "text": row["text"],
                    "rrf_score": 0.0,
                    "retrieval_methods": [],
                    "contributions": [],
                    "version": row.get("version"),
                    "page_start": row.get("page_start"),
                    "heading": row.get("heading"),
                    "chunk_key": row.get("chunk_key"),
                    "document_id": row.get("document_id"),
                    "position": row.get("position"),
                },
            )
            contribution = 1 / (rrf_k + rank)
            item["rrf_score"] += contribution
            if method not in item["retrieval_methods"]:
                item["retrieval_methods"].append(method)
            item["contributions"].append(
                {
                    "query": query,
                    "method": method,
                    "rank": rank,
                    "raw_score": round(float(row.get("score", 0)), 6),
                    "rrf": round(contribution, 6),
                }
            )
            hits.append(
                {
                    "rank": rank,
                    "chunk_id": str(key),
                    "title": row["title"],
                    "raw_score": round(float(row.get("score", 0)), 6),
                    "rrf": round(contribution, 6),
                }
            )
        return {"query": query, "method": method, "hits": hits}

    # 检索充分性判断与补充检索。第一次判断为 insufficient 或 partial 且模型给出了补充检索词时，
    # 把补充检索词加进原来的检索词再检索一次（重排仍用完整问题），然后再判断一次；
    # 补充检索后判断反而变差（partial 变 insufficient）或检索为空时，退回第一次的来源和结论，
    # 补充检索只能让结果变好，不能把原本能回答一部分的问题变成拒答。
    # 最终仍是 insufficient 就清空来源，由回答阶段确定性地拒答，不让模型拿无关资料硬凑答案。
    # 只补检索一次：多轮循环会让延迟成倍增加，而第二次还找不到时再换说法通常也找不到。
    # partial 不拒答，把缺少的内容交给回答阶段，让模型只回答资料支持的部分并说明缺什么。
    # 演示模式没有聊天模型、或设置页关闭了充分性判断、或来源已为空（重排阈值已过滤光）时不判断。
    VERDICT_RANK = {"insufficient": 0, "partial": 1, "sufficient": 2}

    # 有图谱关系时才把关系传给判断，没有时调用方式和以前一样。
    @staticmethod
    def judge(models, question, retrieval):
        relations = retrieval.get("relations") or []
        if relations:
            return models.judge_sufficiency(question, retrieval["sources"], relations)
        return models.judge_sufficiency(question, retrieval["sources"])

    # options 原样传给补充检索（评测的专项可以只用一路检索，补充检索也要用同样的方式）。
    def check_sufficiency(
        self, store, models, owner, queries, rerank_query, retrieval, **options
    ):
        result = {
            "checked": False,
            "verdict": None,
            "missing": "",
            "judgements": [],
            "retried": False,
            "retry_query": None,
            "retrieval": retrieval,
            "sources": retrieval["sources"],
            "relations": retrieval.get("relations") or [],
            "refused": False,
        }
        if (
            models.mode != "openai"
            or not runtime_snapshot()["sufficiency_check"]
            or not retrieval["sources"]
        ):
            return result
        result["checked"] = True
        # 图谱关系和检索来源一起交给充分性判断：关系也是回答模型会看到的资料。
        judgement = self.judge(models, rerank_query, retrieval)
        result["judgements"].append(judgement)
        rewrite = judgement["rewrite_query"]
        if (
            judgement["verdict"] in {"insufficient", "partial"}
            and rewrite
            and rewrite not in queries
        ):
            retry_queries = list(queries)
            retry_queries.append(rewrite)
            retry_started = time.monotonic()
            # 图检索用补充检索词重新提关键词：原问题的关键词第一次已经用过了。
            retry = self.execute(
                store,
                models,
                owner,
                retry_queries,
                rerank_query,
                **{
                    **options,
                    "graph_question": rewrite,
                    "graph_question_source": "补充检索词",
                },
            )
            result["retry_ms"] = round((time.monotonic() - retry_started) * 1000)
            result.update(
                {"retried": True, "retry_query": rewrite, "retry_retrieval": retry}
            )
            if retry["sources"]:
                second = self.judge(models, rerank_query, retry)
                result["judgements"].append(second)
                if (
                    self.VERDICT_RANK[second["verdict"]]
                    >= self.VERDICT_RANK[judgement["verdict"]]
                ):
                    judgement = second
                    result["retrieval"] = retry
            result["retry_used"] = result["retrieval"] is retry
        result["verdict"] = judgement["verdict"]
        result["missing"] = judgement["missing"]
        result["refused"] = judgement["verdict"] == "insufficient"
        result["sources"] = [] if result["refused"] else result["retrieval"]["sources"]
        result["relations"] = (
            [] if result["refused"] else result["retrieval"].get("relations") or []
        )
        return result

    # 把命中的子块扩展为父块，返回 (父块文字, 组成父块的分片 id 列表, 每片的 id/序号/字数/上下文说明)；找不到分片记录时返回 None，沿用子块。
    # 父块只在同一小节（标题路径相同）内扩展：跨小节拼接会把无关话题塞给模型。
    # 从命中分片开始交替向前、向后各加一个相邻分片，直到超出长度上限、离开小节或碰到已被其他父块包含的分片。
    @staticmethod
    def parent_context(store, item, covered, radius, max_chars):
        if item.get("document_id") is None or item.get("position") is None:
            return None
        rows = store.neighbor_chunks(item["document_id"], item["position"], radius)
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
            return (
                (rows[index]["chunk_metadata"] or {}).get("heading_path") or []
            ) == path

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
                if total + length > max_chars:
                    continue
                total += length
                start = min(start, index)
                end = max(end, index)
                grew = True
        parts = []
        chunk_ids = []
        layout = []
        for index in range(start, end + 1):
            row = rows[index]
            content = row["content"] or row["text"] or ""
            # 相邻分片开头有和上一片重叠的文字（effective_overlap 个字），拼接时去掉，避免同一句话出现两次。
            if index > start:
                overlap = (row["chunk_metadata"] or {}).get("effective_overlap") or 0
                content = content[overlap:].lstrip("\n")
            parts.append(content)
            chunk_ids.append(row["id"])
            # 上下文说明（Contextual Retrieval 导入时为分片写的一两句话）：回答步骤里用它说明每一片讲的是什么，不用存全文。
            layout.append(
                {
                    "chunk_id": row["id"],
                    "position": row.get("position"),
                    "chars": len(content),
                    "context": (row["chunk_metadata"] or {}).get("context"),
                }
            )
        body = "\n".join(parts)
        heading = " / ".join(path)
        text = f"标题路径：{heading}\n{body}" if heading else body
        return text, chunk_ids, layout

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
    def build_diagnostics(
        candidates,
        lists,
        stats,
        reranked,
        pool_size,
        fusion="sum",
        methods=("dense", "keyword"),
        settings=None,
    ):
        methods = methods or ("dense", "keyword")
        settings = settings or runtime_snapshot()
        status_order = {
            "returned": 0,
            "beyond_limit": 1,
            "beyond_budget": 1,
            "filtered_low_score": 2,
            "in_pool": 3,
            "not_in_pool": 4,
        }
        items = []
        for item in candidates.values():
            items.append(item)
        items.sort(
            key=lambda item: (
                status_order[item["status"]],
                item.get("rerank_rank", 0) if reranked else item["rrf_rank"],
                item["rrf_rank"],
            )
        )
        rows = []
        for item in items:
            # 主键是"版本 id:序号"，不能再截断前几位，否则同一版本的分片会显示成同一个 ID。
            rows.append(
                {
                    "chunk_id": str(item["id"]),
                    "chunk_key": item.get("chunk_key"),
                    "title": item["title"],
                    "version": item.get("version"),
                    "page_start": item.get("page_start"),
                    "heading": item.get("heading"),
                    "preview": item["text"][:PREVIEW_CHARACTERS],
                    "status": item["status"],
                    "source_id": item.get("source_id"),
                    "source_tokens": item.get("source_tokens"),
                    "graph_budget_guaranteed": bool(
                        item.get("graph_budget_guaranteed")
                    ),
                    # 并入了前面某个父块：内容已经在那条来源里，不单独成源，也不占返回名额。
                    "merged": bool(item.get("merged")),
                    "retrieval_methods": item["retrieval_methods"],
                    "contributions": item["contributions"],
                    "rrf_score": round(item["rrf_score"], 6),
                    "rrf_rank": item["rrf_rank"],
                    "rerank_logit": item.get("rerank_logit"),
                    "rerank_probability": round(item["rerank_probability"], 6)
                    if "rerank_probability" in item
                    else None,
                    "rerank_rank": item.get("rerank_rank"),
                    "graph_relation_ids": item.get("graph_relation_ids") or [],
                    # 怎么进的重排：rrf = 按 RRF 名次；graph = 只被图找到，按图的名次（graph_only_rank）进的。
                    "pool_via": item.get("pool_via"),
                    "graph_only_rank": item.get("graph_only_rank"),
                }
            )
        # 候选池、融合方式和召回方式写进诊断配置，评测对比不同参数时能看出每次实际用的是哪一组。
        config = {
            "rrf_k": settings["rrf_k"],
            "rerank_candidates": pool_size,
            # 只被图找到的分片进重排的上限和实际进了几个；没走图检索时为 0。
            "graph_pool_size": stats.get("graph_pool_size", 0),
            "graph_pool_count": stats.get("graph_pool_count", 0),
            "fusion": fusion,
            "methods": list(methods),
            "return_limit": settings["return_limit"],
            **{
                key: stats.get(key)
                for key in (
                    "source_graph_budget_ratio",
                    "source_graph_budget_reserved",
                    "source_graph_budget_used",
                    "source_graph_budget_count",
                    "source_graph_relation_count",
                    "source_graph_relation_tokens",
                    "source_graph_relation_skipped",
                    "source_selection_mode",
                    "source_token_budget",
                    "source_tokens_used",
                    "source_child_tokens",
                    "source_tokens_estimated",
                    "source_budget_skipped",
                    "source_expansion_skipped",
                )
            },
            "reranked": reranked,
            "parent_context": settings["parent_context"],
            "parent_max_chars": settings["parent_max_chars"],
            "parent_radius": settings["parent_radius"],
            "excellent_score": settings.get("excellent_score"),
            "min_score": stats["min_score"],
            "rerank_query": stats["rerank_query"],
            "rerank_model": stats["rerank_model"],
            "rerank_error": stats.get("rerank_error"),
        }
        return {"config": config, "lists": lists, "candidates": rows}
