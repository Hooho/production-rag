import hashlib
import json
import math
import os
import time
from uuid import uuid4

from sqlalchemy import select

from ..models import Models
from ..mysql.store import chunks, document_chunks, document_heads
from ..runtime_config import snapshot as runtime_snapshot
from ..tools.search import DocumentSearchTool
from .dataset import EVAL_DIR, QUESTION_TYPES, corpus_files, normalize, select_split


# 评测语料导入到专门的评测用户下，和 alice、bob 的真实知识库完全隔离：
# 评测数据不会混进用户的检索结果，用户上传或删除文档也不会改变评测分数。
EVAL_OWNER = "eval"
# 阈值扫描的取值：0.05 到 0.9，每 0.05 一档。
SWEEP_THRESHOLDS = []
for step in range(1, 19):
    SWEEP_THRESHOLDS.append(round(step * 0.05, 2))
# 消融实验与参数对比的变体。每个变体只改一个因素，其他保持默认，这样分数的差异才能归因到这个因素上。
VARIANTS = {
    "dense_only": {"label": "仅向量", "suite": "ablation", "options": {"methods": ["dense"]}},
    "keyword_only": {"label": "仅 BM25", "suite": "ablation", "options": {"methods": ["keyword"]}},
    "hybrid_no_rerank": {"label": "混合（不重排）", "suite": "ablation", "options": {"rerank": False}},
    "pool_12": {"label": "候选池 12", "suite": "params", "options": {"pool_size": 12}},
    "pool_30": {"label": "候选池 30", "suite": "params", "options": {"pool_size": 30}},
    "fusion_best": {"label": "多查询取最好名次", "suite": "params", "options": {"fusion": "best"}},
}
SUITES = {"ablation": "消融实验", "params": "参数对比"}


# 把 eval/corpus 下的文档导入评测用户，走和线上导入相同的"去重 → 新版本 → 切换当前版本"流程。
# 内容没变时 sha256 去重直接跳过，所以每次评测前都可以放心调用：语料改了才会重新切分和向量化。
def import_corpus(store, models):
    report = []
    for path in corpus_files():
        title = path.stem
        content = path.read_text(encoding="utf-8")
        content_sha256 = hashlib.sha256(content.encode()).hexdigest()
        with store.engine.connect() as connection:
            head = connection.execute(select(document_heads.c.current_document_id).where(
                document_heads.c.owner == EVAL_OWNER, document_heads.c.title == title)).first()
        replace_id = head[0] if head else None
        doc_key, version = store.next_version(EVAL_OWNER, replace_id)
        # 带上 Contextual Retrieval 开关：开关变化后语料要重新导入，评测才能反映开关的效果。
        duplicate = store.find_duplicate(EVAL_OWNER, content_sha256, doc_key, getattr(models, "contextual", False))
        if duplicate:
            report.append({"title": title, "document_id": duplicate, "status": "unchanged"})
            continue
        document_id = str(uuid4())
        store.mysql.create_document(document_id, EVAL_OWNER, title, path.name, "", {"sha256": content_sha256},
            doc_key=doc_key, version=version, version_note="评测语料", content_sha256=content_sha256)
        try:
            count = store.ingest(EVAL_OWNER, title, content, models, document_id, doc_key or document_id)
            store.activate_version(document_id, count)
        except Exception:
            store.mysql.update_document(document_id, "failed", "评测语料导入失败")
            store.remove_version_data(document_id)
            raise
        report.append({"title": title, "document_id": document_id, "status": "imported", "chunks": count})
    return report


# 读取评测用户当前版本的全部分片原文 {分片 id: 文本}。
# 检索诊断里只有 80 字预览，判断"分片是否包含证据原文"需要完整文本，所以一次性从 MySQL 取出。
def current_chunk_texts(store):
    joined = document_heads.join(document_chunks,
        document_chunks.c.document_id == document_heads.c.current_document_id).join(
        chunks, chunks.c.id == document_chunks.c.chunk_id)
    with store.engine.connect() as connection:
        rows = connection.execute(select(chunks.c.id, chunks.c.text).select_from(joined).where(
            document_heads.c.owner == EVAL_OWNER)).all()
    texts = {}
    for chunk_id, text in rows:
        texts[chunk_id] = normalize(text)
    return texts


# 读取缓存的查询改写结果。检索评测不调用大模型：改写结果每次可能不同，
# 会让两次评测的差异混进"改写碰巧不一样"的噪声；缓存一次后反复使用，分数只受检索参数影响。
def load_rewrites():
    path = EVAL_DIR / "rewrites.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


# 用线上相同的查询分析生成检索词，写入缓存；只在需要更新改写时手动执行（会调用大模型）。
def refresh_rewrites(models, items):
    rewrites = {}
    for item in items:
        history = []
        for question in item.get("history", []):
            history.append({"question": question})
        analysis = models.analyze_query(item["question"], history, None)
        rewrites[item["id"]] = {"question": item["question"], "queries": analysis["queries"],
            "standalone_query": analysis["standalone_query"], "classifier": analysis.get("classifier")}
    path = EVAL_DIR / "rewrites.json"
    path.write_text(json.dumps(rewrites, ensure_ascii=False, indent=1), encoding="utf-8")
    return rewrites


# 决定一道题的检索词和重排用的完整问题：优先用缓存的改写；缓存里没有（或题目已改）时，
# 用不调用模型的规则改写，多轮追问会把上一轮问题拼进来补全指代。
def plan_queries(item, rewrites):
    cached = rewrites.get(item["id"])
    if cached and cached.get("question") == item["question"]:
        return cached["queries"], cached["standalone_query"], "rewrite_cache"
    history = []
    for question in item.get("history", []):
        history.append({"question": question})
    analysis = Models.fallback_query(item["question"], history, None)
    return analysis["queries"], analysis["standalone_query"], "rule"


# 找出每条证据落在哪些候选分片里，返回 {候选 chunk_id: [证据序号]}。
def evidence_hits(candidates, evidence, chunk_texts):
    targets = []
    for text in evidence:
        targets.append(normalize(text))
    hits = {}
    for candidate in candidates:
        text = chunk_texts.get(candidate["chunk_id"], "")
        found = []
        for index, target in enumerate(targets):
            if target and target in text:
                found.append(index)
        if found:
            hits[candidate["chunk_id"]] = found
    return hits


# 一个阶段的证据覆盖率和倒数排名：ordered 是该阶段按名次排好的分片列表。
# 覆盖率 = 找到的证据条数 / 证据总数（多条证据按比例计分）；
# 倒数排名 = 1 / 第一个包含任一证据的分片名次，没找到为 0，对所有题取平均就是 MRR。
def stage_score(ordered, hits, evidence_count):
    found = set()
    first_rank = None
    for rank, chunk_id in enumerate(ordered, start=1):
        indexes = hits.get(chunk_id, [])
        if indexes and first_rank is None:
            first_rank = rank
        for index in indexes:
            found.add(index)
    coverage = len(found) / evidence_count if evidence_count else None
    reciprocal = 1 / first_rank if first_rank else 0.0
    return coverage, reciprocal, first_rank


# 按阈值重算"过滤后"阶段：重排顺序里概率不低于阈值的前 return_limit 个。
# 这和 DocumentSearchTool 的过滤逻辑一致，因此不用重新检索就能离线扫描任意阈值。
def filter_pool(pool, threshold, return_limit):
    kept = []
    for item in pool:
        if item["p"] is None or item["p"] >= threshold:
            kept.append(item)
        if len(kept) >= return_limit:
            break
    return kept


# 把一次检索结果换算成一道题的评测行：三个阶段各自的覆盖率、倒数排名、证据名次和丢失阶段。
def score_question(item, retrieval, chunk_texts, pool_size):
    diagnostics = retrieval["diagnostics"]
    config = diagnostics["config"]
    candidates = diagnostics["candidates"]
    evidence = item.get("evidence") or []
    return_limit = config["return_limit"]
    hits = evidence_hits(candidates, evidence, chunk_texts)
    # 阶段一：召回。RRF 前 pool_size 名就是交给重排的候选池，证据没进池子，后面再强的重排也救不回来。
    by_rrf = sorted(candidates, key=lambda row: row["rrf_rank"])
    pool_ids = []
    for row in by_rrf[:pool_size]:
        pool_ids.append(row["chunk_id"])
    # 阶段二：重排后前 return_limit 名，不考虑阈值；没启用重排时就是 RRF 顺序。
    pool_rows = []
    for row in candidates:
        if row["status"] != "not_in_pool":
            pool_rows.append(row)
    if config["reranked"]:
        pool_rows.sort(key=lambda row: row["rerank_rank"])
    else:
        pool_rows.sort(key=lambda row: row["rrf_rank"])
    top_ids = []
    for row in pool_rows[:return_limit]:
        top_ids.append(row["chunk_id"])
    # 阶段三：阈值过滤后真正交给回答模型的来源。
    final_rows = []
    for row in candidates:
        if row["status"] == "returned":
            final_rows.append(row)
    final_rows.sort(key=lambda row: int(row["source_id"][1:]))
    final_ids = []
    for row in final_rows:
        final_ids.append(row["chunk_id"])
    stages = {}
    for name, ordered in (("pool", pool_ids), ("top", top_ids), ("final", final_ids)):
        coverage, reciprocal, first_rank = stage_score(ordered, hits, len(evidence))
        stages[name] = {"recall": coverage, "rr": reciprocal, "rank": first_rank}
    # 丢失阶段：按顺序找第一个"证据比上一阶段少了"的地方，便于定位问题出在召回、重排还是阈值。
    lost = None
    if item.get("answerable"):
        if stages["pool"]["recall"] < 1:
            lost = "recall"
        elif stages["top"]["recall"] < 1:
            lost = "rerank"
        elif stages["final"]["recall"] < 1:
            lost = "threshold"
    # 每条证据的具体位置：所在分片的 RRF 名次、重排名次、来源编号。
    evidence_rows = []
    for index, text in enumerate(evidence):
        best = None
        for row in candidates:
            if index in hits.get(row["chunk_id"], []):
                if best is None or row["rrf_rank"] < best["rrf_rank"]:
                    best = row
        evidence_rows.append({"text": text, "chunk_id": best["chunk_id"] if best else None,
            "rrf_rank": best["rrf_rank"] if best else None,
            "rerank_rank": best.get("rerank_rank") if best else None,
            "rerank_probability": best.get("rerank_probability") if best else None,
            "source_id": best.get("source_id") if best else None,
            "status": best["status"] if best else "not_recalled"})
    # 候选池的精简记录（按重排顺序的概率和包含的证据），用于离线阈值扫描。
    pool = []
    for row in pool_rows:
        pool.append({"p": row["rerank_probability"] if config["reranked"] else None,
            "ev": hits.get(row["chunk_id"], [])})
    stats = retrieval["stats"]
    return {"id": item["id"], "question": item["question"], "type": item["type"],
        # 题目仍独立计分；保留题对关系只用于评测结果中的成对分析。
        "pair_id": item.get("pair_id"), "pair_role": item.get("pair_role"),
        "answerable": bool(item.get("answerable")), "evidence_count": len(evidence),
        "stages": stages, "lost_stage": lost, "evidence": evidence_rows,
        "returned": stats["returned"], "pool": pool,
        "max_probability": max((row["p"] for row in pool if row["p"] is not None), default=None),
        "recall_ms": stats.get("recall_ms"), "rerank_ms": stats.get("rerank_ms")}


# 求平均，空列表返回 None（表示这一组没有可统计的题），避免除零。
def mean(values):
    if not values:
        return None
    return round(sum(values) / len(values), 4)


# 取第 95 百分位，用来观察偶发的慢请求（例如重排冷启动）。
def percentile(values, ratio):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(ratio * len(ordered)) - 1)
    return ordered[index]


# 汇总一组题目的检索指标。
# 误杀率 = 能回答的题中，来源被全部过滤掉（直接拒答）的比例；
# 漏放率 = 无法回答的题中，仍然留下了来源（模型可能据此硬凑答案）的比例。
def summarize(rows):
    answerable = []
    unanswerable = []
    for row in rows:
        if row["answerable"]:
            answerable.append(row)
        else:
            unanswerable.append(row)
    summary = {"count": len(rows), "answerable_count": len(answerable), "unanswerable_count": len(unanswerable)}
    for stage in ("pool", "top", "final"):
        recalls = []
        reciprocals = []
        for row in answerable:
            recalls.append(row["stages"][stage]["recall"])
            reciprocals.append(row["stages"][stage]["rr"])
        summary[f"recall_{stage}"] = mean(recalls)
        summary[f"mrr_{stage}"] = mean(reciprocals)
    rejected = 0
    for row in answerable:
        if row["returned"] == 0:
            rejected += 1
    accepted = 0
    for row in unanswerable:
        if row["returned"] > 0:
            accepted += 1
    summary["false_reject_rate"] = round(rejected / len(answerable), 4) if answerable else None
    summary["false_accept_rate"] = round(accepted / len(unanswerable), 4) if unanswerable else None
    latencies = []
    rerank_times = []
    for row in rows:
        latencies.append(row["latency_ms"])
        if row.get("rerank_ms") is not None:
            rerank_times.append(row["rerank_ms"])
    summary["latency_avg_ms"] = round(sum(latencies) / len(latencies)) if latencies else None
    summary["latency_p95_ms"] = percentile(latencies, 0.95)
    summary["rerank_max_ms"] = max(rerank_times) if rerank_times else None
    return summary


# 检索漏斗：能回答的题里，每个阶段证据全部找到的题数。从左到右只会减少，哪一步掉得最多就先优化哪一步。
def funnel(rows):
    result = {"total": 0, "pool": 0, "top": 0, "final": 0}
    for row in rows:
        if not row["answerable"]:
            continue
        result["total"] += 1
        for stage in ("pool", "top", "final"):
            if row["stages"][stage]["recall"] == 1:
                result[stage] += 1
    return result


# 按题目类型分别统计：整体分数可能掩盖某类题特别差，例如同义改写题更依赖向量召回。
def summarize_by_type(rows):
    groups = {}
    for question_type in QUESTION_TYPES:
        selected = []
        for row in rows:
            if row["type"] == question_type:
                selected.append(row)
        if selected:
            groups[question_type] = summarize(selected)
    return groups


# 同义改写沿用所有现有检索指标，额外按 pair_id 比较原问题和改写问题的变化。
def summarize_paraphrase_pairs(rows):
    grouped = {}
    for row in rows:
        pair_id = row.get("pair_id")
        if pair_id:
            grouped.setdefault(pair_id, {})[row.get("pair_role")] = row

    pairs = []
    original_rows = []
    paraphrase_rows = []
    for pair_id, members in grouped.items():
        original = members.get("original")
        paraphrase = members.get("paraphrase")
        if not original or not paraphrase:
            continue
        original_rows.append(original)
        paraphrase_rows.append(paraphrase)
        statuses = {}
        for stage in ("pool", "top", "final"):
            original_hit = original["stages"][stage]["recall"] == 1
            paraphrase_hit = paraphrase["stages"][stage]["recall"] == 1
            if original_hit and paraphrase_hit:
                statuses[stage] = "stable"
            elif original_hit:
                statuses[stage] = "lost"
            elif paraphrase_hit:
                statuses[stage] = "gained"
            else:
                statuses[stage] = "both_missed"
        pairs.append({
            "pair_id": pair_id,
            "original": {"id": original["id"], "question": original["question"]},
            "paraphrase": {"id": paraphrase["id"], "question": paraphrase["question"]},
            "statuses": statuses,
        })

    if not pairs:
        return None

    original_summary = summarize(original_rows)
    paraphrase_summary = summarize(paraphrase_rows)
    metric_keys = ["recall_pool", "recall_top", "recall_final", "mrr_top", "false_reject_rate", "false_accept_rate"]
    metrics = {}
    for key in metric_keys:
        original_value = original_summary.get(key)
        paraphrase_value = paraphrase_summary.get(key)
        metrics[key] = {
            "original": original_value,
            "paraphrase": paraphrase_value,
            "delta": round(paraphrase_value - original_value, 4) if original_value is not None and paraphrase_value is not None else None,
        }

    # 保持率只看原问题已经完整命中的题对，避免把原问题本身失败造成的噪声算成改写损失。
    retention = {}
    for stage in ("pool", "top", "final"):
        eligible = 0
        retained = 0
        for pair in pairs:
            original = next(row for row in original_rows if row["id"] == pair["original"]["id"])
            paraphrase = next(row for row in paraphrase_rows if row["id"] == pair["paraphrase"]["id"])
            if original["stages"][stage]["recall"] == 1:
                eligible += 1
                if paraphrase["stages"][stage]["recall"] == 1:
                    retained += 1
        retention[stage] = round(retained / eligible, 4) if eligible else None

    return {"pair_count": len(pairs), "question_count": len(pairs) * 2,
        "original": original_summary, "paraphrase": paraphrase_summary,
        "metrics": metrics, "retention": retention, "pairs": pairs}


# 离线阈值扫描：对每个阈值重算误杀率、漏放率和过滤后召回率。
# 阈值越高，无关来源越容易被挡住（漏放率下降），但相关来源也更容易被误杀（误杀率上升），两条曲线的交叉附近通常是合适的取值。
def threshold_sweep(rows, return_limit):
    points = []
    for threshold in SWEEP_THRESHOLDS:
        answerable = 0
        rejected = 0
        recalls = []
        unanswerable = 0
        accepted = 0
        for row in rows:
            kept = filter_pool(row["pool"], threshold, return_limit)
            if row["answerable"]:
                answerable += 1
                if not kept:
                    rejected += 1
                found = set()
                for item in kept:
                    for index in item["ev"]:
                        found.add(index)
                recalls.append(len(found) / row["evidence_count"] if row["evidence_count"] else 0)
            else:
                unanswerable += 1
                if kept:
                    accepted += 1
        points.append({"threshold": threshold,
            "false_reject_rate": round(rejected / answerable, 4) if answerable else None,
            "false_accept_rate": round(accepted / unanswerable, 4) if unanswerable else None,
            "recall_final": mean(recalls)})
    return points


# 离线扫描「交给模型的段数」：在当前阈值下，段数取 1 到候选池大小时，证据召回和平均实际交给模型几段。
# 和阈值扫描一样用候选池里每条的重排概率重算，不用重新检索。段数只能截掉排在后面的资料，
# 证据都排在前面时召回不受影响，这时它的作用只剩控制输入长度。
def return_limit_sweep(rows, threshold, pool_size):
    points = []
    for limit in range(1, pool_size + 1):
        recalls = []
        complete = 0
        multi = []
        returned = []
        capped = 0
        for row in rows:
            kept = filter_pool(row["pool"], threshold, limit)
            returned.append(len(kept))
            passing = sum(1 for item in row["pool"] if item["p"] is None or item["p"] >= threshold)
            if passing > limit:
                capped += 1
            if not row["answerable"] or not row["evidence_count"]:
                continue
            found = set()
            for item in kept:
                for index in item["ev"]:
                    found.add(index)
            recall = len(found) / row["evidence_count"]
            recalls.append(recall)
            complete += recall == 1
            if row["evidence_count"] > 1:
                multi.append(recall)
        points.append({"return_limit": limit, "recall_final": mean(recalls), "complete": complete,
            "answerable": len(recalls), "multi_evidence_recall": mean(multi) if multi else None,
            "multi_evidence": len(multi), "avg_returned": mean(returned), "capped": capped, "total": len(rows)})
    return points


# 对一组题执行一次检索并打分；options 是传给 DocumentSearchTool 的变体参数。
def evaluate_items(store, models, items, chunk_texts, rewrites, options, keep_diagnostics, on_item=None):
    tool = DocumentSearchTool()
    pool_size = options.get("pool_size") or runtime_snapshot()["rerank_candidates"]
    rows = []
    for item in items:
        queries, rerank_query, query_source = plan_queries(item, rewrites)
        started = time.monotonic()
        retrieval = tool.execute(store, models, EVAL_OWNER, queries, rerank_query, **options)
        latency_ms = round((time.monotonic() - started) * 1000)
        row = score_question(item, retrieval, chunk_texts, pool_size)
        row.update({"latency_ms": latency_ms, "queries": queries, "rerank_query": rerank_query,
            "query_source": query_source})
        if keep_diagnostics:
            row["diagnostics"] = retrieval["diagnostics"]
            row["sources"] = retrieval["sources"]
        rows.append(row)
        if on_item:
            on_item(item, row, retrieval)
    return rows


# 运行一次完整的检索评测：导入语料 → 基线逐题评测 → 汇总、分组、漏斗、阈值扫描 → 可选的消融与参数对比。
# on_progress(已完成, 总数) 用于把进度写回结果文件，前端据此显示进度条。
def run_retrieval(store, models, items, split, suites=(), on_progress=None, on_item=None):
    corpus = import_corpus(store, models)
    chunk_texts = current_chunk_texts(store)
    rewrites = load_rewrites()
    selected = select_split(items, split)
    variant_names = []
    for name, variant in VARIANTS.items():
        if variant["suite"] in suites:
            variant_names.append(name)
    total = len(selected) * (1 + len(variant_names))
    done = [0]

    # 每完成一道题推进一次进度；基线题目还要交给 on_item（生成评测在这里接着生成回答）。
    def advance(item=None, row=None, retrieval=None):
        done[0] += 1
        if on_progress:
            on_progress(done[0], total)

    def advance_baseline(item, row, retrieval):
        if on_item:
            on_item(item, row, retrieval)
        advance()

    rows = evaluate_items(store, models, selected, chunk_texts, rewrites, {}, True, advance_baseline)
    # 重排关闭或调用失败时没有相关性阈值，也无法做阈值扫描；配置里如实记录，避免把"未过滤"误读成"阈值很低"。
    min_score = None
    reranked = False
    for row in rows:
        config = row["diagnostics"]["config"]
        if config["reranked"]:
            reranked = True
            min_score = config["min_score"]
    query_sources = set()
    for row in rows:
        query_sources.add(row["query_source"])
    variants = []
    for name in variant_names:
        variant = VARIANTS[name]
        variant_rows = evaluate_items(store, models, selected, chunk_texts, rewrites, variant["options"], False,
            advance)
        variants.append({"name": name, "label": variant["label"], "suite": variant["suite"],
            "options": variant["options"], "summary": summarize(variant_rows), "funnel": funnel(variant_rows),
            "by_type": summarize_by_type(variant_rows)})
    # 记下这次评测实际用的全部系统参数（设置页可改），对比两次评测时能看出参数是否相同。
    settings = runtime_snapshot()
    config = {"split": split, "dataset_size": len(selected), "suites": list(suites), "rrf_k": settings["rrf_k"],
        "pool_size": settings["rerank_candidates"], "return_limit": settings["return_limit"], "min_score": min_score,
        "reranked": reranked, "fusion": "sum", "methods": ["dense", "keyword"],
        "model_mode": models.mode, "embedding_mode": models.embedding_mode,
        "embedding_model": models.embedding_model, "rerank_model": models.rerank_model,
        "rerank_mode": "local" if settings["rerank_enabled"] else "off", "query_source": sorted(query_sources),
        "corpus": corpus, "settings": settings}
    return {"config": config, "summary": summarize(rows), "by_type": summarize_by_type(rows),
        "funnel": funnel(rows), "sweep": threshold_sweep(rows, settings["return_limit"]) if reranked else [],
        "limit_sweep": return_limit_sweep(rows, min_score, settings["rerank_candidates"]) if reranked else [],
        "variants": variants, "paraphrase": summarize_paraphrase_pairs(rows), "questions": rows}
