"""离线检查北海比较题的子查询召回和完整问题重排损失；只读取本机缓存模型。"""

import argparse
from datetime import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.import_beihai_questions import MATERIALS, load_materials  # noqa: E402


def verify(rank, score, items, documents, threshold, pool_size):
    """rank 返回全库的分片索引；score 返回 sigmoid 后的 BGE 分数。"""
    results = []
    for item in items:
        full = item["question"]
        full_ranks = rank(full)
        fused = {}
        ranks = []
        for group in item["scoring_items"]:
            order = rank(group["query"])
            ranks.append(order)
            for place, index in enumerate(order[:12], 1):
                fused[index] = fused.get(index, 0.0) + 1 / (60 + place)
        pool = sorted(fused, key=fused.get, reverse=True)[:pool_size]
        evidence = []
        for group, order in zip(item["scoring_items"], ranks):
            matches = [
                index
                for index, doc in enumerate(documents)
                if doc["section"] == group["section"] and doc["title"] == group["title"]
            ]
            if len(matches) != 1:
                raise ValueError(f"{item['id']} 的证据必须对应一片，请检查切分参数")
            index = matches[0]
            full_score = score(full, documents[index]["text"])
            sub_score = score(group["query"], documents[index]["text"])
            evidence.append(
                {
                    "section": group["section"],
                    "label": group["label"],
                    "subquery": group["query"],
                    "full_query_dense_rank": full_ranks.index(index) + 1,
                    "subquery_dense_rank": order.index(index) + 1,
                    "in_subquery_rrf_pool": index in pool,
                    "full_score": full_score,
                    "subquery_score": sub_score,
                    "full_filtered": full_score < threshold,
                    "subquery_kept": sub_score >= threshold,
                }
            )
        passed = all(
            row["subquery_dense_rank"] <= 12
            and row["in_subquery_rrf_pool"]
            and row["subquery_kept"]
            for row in evidence
        )
        passed = passed and any(row["full_filtered"] for row in evidence)
        # 至少一片仍通过，避免所有片都低分时的单片兜底改变过滤结论。
        passed = passed and any(not row["full_filtered"] for row in evidence)
        results.append(
            {
                "id": item["id"],
                "question": full,
                "qualified": passed,
                "evidence": evidence,
            }
        )
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MATERIALS / "比较重排验证.json")
    args = parser.parse_args()
    # 禁止下载；缓存不完整时失败，不请求远程模型服务。
    os.environ.update(
        HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false"
    )
    import torch
    from transformers import (
        AutoModel,
        AutoModelForSequenceClassification,
        AutoTokenizer,
    )
    from app.ingestion.chunking import chunk_document_records
    from app.runtime_config import BY_KEY

    spec, _ = load_materials()
    torch.set_num_threads(4)
    cache = Path.home() / ".cache/huggingface/hub"
    models = {}
    for name in ("bge-small-zh-v1.5", "bge-reranker-base"):
        root = cache / f"models--BAAI--{name}"
        revision = (root / "refs/main").read_text().strip()
        models[name] = (root / "snapshots" / revision, revision)
    embedding_path, embedding_revision = models["bge-small-zh-v1.5"]
    rerank_path, rerank_revision = models["bge-reranker-base"]
    tokenizer = AutoTokenizer.from_pretrained(embedding_path, local_files_only=True)
    encoder = AutoModel.from_pretrained(embedding_path, local_files_only=True).eval()
    rerank_tokenizer = AutoTokenizer.from_pretrained(rerank_path, local_files_only=True)
    reranker = AutoModelForSequenceClassification.from_pretrained(
        rerank_path, local_files_only=True
    ).eval()
    sources = [
        {"title": spec["title"], "file": "corpus/北海慢游指南.md"},
    ]
    documents = []
    source_hashes = {}
    for source in sources:
        content = (MATERIALS / source["file"]).read_bytes()
        source_hashes[source["title"]] = sha256(content).hexdigest()
        for record in chunk_document_records(
            content.decode(), chunk_size=400, chunk_overlap=40
        ):
            documents.append(
                {
                    "title": source["title"],
                    "section": record["section_title"].split("｜")[0],
                    "text": record["embedding_text"],
                }
            )

    def encode(texts):
        vectors = []
        for start in range(0, len(texts), 8):
            batch = tokenizer(
                texts[start : start + 8],
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            with torch.inference_mode():
                pooled = encoder(**batch).last_hidden_state[:, 0]
                vectors.append(torch.nn.functional.normalize(pooled, p=2, dim=1))
        return torch.cat(vectors)

    embeddings = encode([doc["text"] for doc in documents])
    ranks = {}
    scores = {}

    def rank(query):
        if query not in ranks:
            ranks[query] = (
                (embeddings @ encode([query])[0]).argsort(descending=True).tolist()
            )
        return ranks[query]

    def score(query, text):
        key = (query, text)
        if key not in scores:
            inputs = rerank_tokenizer(
                [[query, text]],
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            with torch.inference_mode():
                scores[key] = float(reranker(**inputs).logits.flatten().sigmoid()[0])
        return scores[key]

    threshold = BY_KEY["rerank_min_score"]["default"]
    pool_size = BY_KEY["rerank_candidates"]["default"]
    items = [item for item in spec["items"] if item["type"] == "比较"]
    results = verify(rank, score, items, documents, threshold, pool_size)
    for item, result in zip(items, results):
        indices = [
            next(
                index
                for index, doc in enumerate(documents)
                if doc["section"] == group["section"] and doc["title"] == group["title"]
            )
            for group in item["scoring_items"]
        ]
        result["cross_option_embedding_cosines"] = [
            {
                "left": documents[left]["section"],
                "right": documents[right]["section"],
                "cosine": float(embeddings[left] @ embeddings[right]),
            }
            for left in indices[:2]
            for right in indices[2:]
        ]
    baseline_sections = [
        ("B003", "B007"),
        ("B024", "B027"),
        ("B030", "B033"),
        ("B048", "B066"),
    ]
    baseline = []
    for item, sections in zip(items, baseline_sections):
        pair = [
            next(
                index
                for index, doc in enumerate(documents)
                if doc["section"] == section
            )
            for section in sections
        ]
        baseline.append(
            {
                "id": item["id"],
                "question": item["previous_question"],
                "cross_option_embedding_cosine": float(
                    embeddings[pair[0]] @ embeddings[pair[1]]
                ),
                "scores": [
                    {
                        "section": section,
                        "score": score(
                            item["previous_question"],
                            next(
                                doc["text"]
                                for doc in documents
                                if doc["section"] == section
                            ),
                        ),
                    }
                    for section in sections
                ],
            }
        )
    report = {
        "created": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "source_hashes": source_hashes,
        "questions_sha256": sha256(
            (MATERIALS / "questions.json").read_bytes()
        ).hexdigest(),
        "embedding_model": "BAAI/bge-small-zh-v1.5",
        "embedding_revision": embedding_revision,
        "rerank_model": "BAAI/bge-reranker-base",
        "rerank_revision": rerank_revision,
        "backend": "local PyTorch CPU, float32, CLS/L2 embeddings, sigmoid rerank logits",
        "config": {
            "threshold": threshold,
            "threshold_source": "repository default; online settings not read",
            "dense_limit": 12,
            "rrf_k": 60,
            "pool_size": pool_size,
            "chunk_size": 400,
            "overlap": 40,
        },
        "document_chunks": len(documents),
        "results": results,
        "old_questions": baseline,
        "limitations": [
            "不是线上或 Milvus 测试，未测 BM25、上下文增强、邻片恢复、工具预算和 Agent。",
            "同名缓存权重的 PyTorch 实测，不是部署中的 fastembed ONNX 后端，分数可能有差异。",
            "对子查询合并候选中的同一必要片做完整问题与对应子问题评分，未把召回差异归因于重排。",
        ],
    }
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for result in results:
        print(result["id"], "通过" if result["qualified"] else "未通过", flush=True)
        for row in result["evidence"]:
            print(
                f"  {row['section']} 子查询名次 {row['subquery_dense_rank']} / 候选池 {row['in_subquery_rrf_pool']}"
                f" / 完整问题 {row['full_score']:.4f} / 子问题 {row['subquery_score']:.4f}",
                flush=True,
            )
    print(f"报告：{args.output}")
    return 0 if all(result["qualified"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
