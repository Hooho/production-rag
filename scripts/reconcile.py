import argparse
import json
import sys

from sqlalchemy import func, select

from app.models import Models
from app.mysql.store import chunks, document_chunks, document_heads, documents
from app.storage import Storage
from scripts.worker import QUEUE


BATCH_SIZE = 32
KIND_TITLES = {
    "current_milvus_incomplete": "当前版本的向量不完整",
    "current_mysql_incomplete": "当前版本的 MySQL 分片不完整",
    "stale_data": "已失效版本的数据没有清理",
    "orphan": "MySQL 中已不存在的版本仍有数据",
    "bad_head": "当前版本指针指向不可用的版本",
    "ready_not_current": "状态为 ready 但不是当前版本",
}


# 对账：比对 MySQL 和 Milvus，找出重试和启动恢复覆盖不到的不一致（清理失败只记了日志、
# 代码缺陷、手动删过 Milvus 数据等）。默认只输出报告，加 --fix 才修复。
# 用法：docker compose exec api python -m scripts.reconcile [--fix]
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true", help="修复能自动修复的问题")
    args = parser.parse_args()
    models = Models()
    store = Storage(models)
    try:
        problems = check(store)
        for problem in problems:
            print(f"[{KIND_TITLES[problem['kind']]}] {problem['document_id']} {problem['title']}：{problem['detail']}")
        print(f"共发现 {len(problems)} 个问题")
        if args.fix:
            for line in fix(store, models, problems):
                print(line)
        elif problems:
            # 非零退出码方便定时任务或脚本判断是否需要处理。
            sys.exit(1)
    finally:
        store.close()


# 遍历整个集合，统计 Milvus 中每个版本的行数；一次遍历同时能发现 MySQL 里已经没有的版本。
def milvus_counts(store):
    return store.milvus.document_counts()


# 统计 MySQL 中每个版本的分片数。
def mysql_counts(store):
    with store.engine.connect() as connection:
        rows = connection.execute(select(document_chunks.c.document_id, func.count()).group_by(
            document_chunks.c.document_id)).all()
    counts = {}
    for document_id, count in rows:
        counts[document_id] = count
    return counts


# 返回发现的问题列表，每项包含 kind、document_id、title、detail，修复需要的字段也一并带上。
def check(store):
    in_milvus = milvus_counts(store)
    in_mysql = mysql_counts(store)
    with store.engine.connect() as connection:
        versions = connection.execute(select(documents)).mappings().all()
        heads = connection.execute(select(document_heads)).mappings().all()
    current_ids = set()
    for head in heads:
        current_ids.add(head["current_document_id"])
    problems = []
    statuses = {}
    for row in versions:
        document_id = row["id"]
        status = row["status"]
        statuses[document_id] = status
        # 还没处理完的版本归 worker 负责（中断的会在 worker 启动时恢复），这里不插手。
        if status == "queued" or status.startswith("processing"):
            continue
        # 待上架（staged:N）、有问题（flagged:N）、等审核（review:N）的版本还不是当前版本，但数据要保留，不算残留。
        if status.startswith(("review:", "staged:", "flagged:")):
            continue
        milvus_count = in_milvus.get(document_id, 0)
        mysql_count = in_mysql.get(document_id, 0)
        problem = {"document_id": document_id, "title": row["title"], "path": row["path"],
            "owner": row["owner"], "doc_key": row["doc_key"] or document_id}
        if document_id in current_ids:
            if not status.startswith("ready:"):
                continue
            expected = int(status.split(":", 1)[1])
            # MySQL 保存分片原文，是 Milvus 的数据来源，所以先看 MySQL，再看 Milvus。
            if mysql_count != expected:
                problem.update(kind="current_mysql_incomplete",
                    detail=f"应有 {expected} 个分片，MySQL 中有 {mysql_count} 个")
                problems.append(problem)
            elif milvus_count != expected:
                problem.update(kind="current_milvus_incomplete",
                    detail=f"应有 {expected} 个分片，Milvus 中有 {milvus_count} 个")
                problems.append(problem)
        elif status in ("superseded", "failed", "rejected"):
            if milvus_count or mysql_count:
                problem.update(kind="stale_data",
                    detail=f"状态 {status}，Milvus 仍有 {milvus_count} 行，MySQL 仍有 {mysql_count} 个分片")
                problems.append(problem)
        elif status.startswith("ready"):
            problem.update(kind="ready_not_current", detail="没有文档的当前版本指针指向它，需要人工确认")
            problems.append(problem)
    orphan_ids = set()
    for document_id in list(in_milvus) + list(in_mysql):
        if document_id not in statuses:
            orphan_ids.add(document_id)
    for document_id in sorted(orphan_ids):
        problems.append({"kind": "orphan", "document_id": document_id, "title": "",
            "detail": f"Milvus {in_milvus.get(document_id, 0)} 行，MySQL {in_mysql.get(document_id, 0)} 个分片"})
    for head in heads:
        status = statuses.get(head["current_document_id"])
        if status is None or not status.startswith("ready"):
            problems.append({"kind": "bad_head", "document_id": head["current_document_id"],
                "title": head["title"], "detail": f"版本状态为 {status}，需要人工确认"})
    return problems


# 修复能安全自动处理的问题，返回每一项的处理结果。
def fix(store, models, problems):
    lines = []
    for problem in problems:
        kind = problem["kind"]
        document_id = problem["document_id"]
        if kind in ("stale_data", "orphan"):
            # 这些版本不在检索范围内，删除只是回收空间，不影响正在服务的内容。
            store.remove_version_data(document_id)
            lines.append(f"已清理 {document_id}")
        elif kind == "current_milvus_incomplete":
            count = rebuild_vectors(store, models, document_id)
            lines.append(f"已按 MySQL 分片重建 {document_id} 的 {count} 个向量")
        elif kind == "current_mysql_incomplete" and problem["path"]:
            # 分片原文本身不全，只能从原文件重新处理。重建期间 worker 会先清掉这个版本的数据，
            # 这份文档会短暂检索不到；它本来就不完整，重建完成后 activate_version 保持指针不变。
            store.mysql.update_document(document_id, "queued")
            store.cache.rpush(QUEUE, json.dumps({"document_id": document_id, "owner": problem["owner"],
                "title": problem["title"], "path": problem["path"], "doc_key": problem["doc_key"]}))
            lines.append(f"已把 {document_id} 重新交给 worker 处理")
        else:
            lines.append(f"未修复 {document_id}：{KIND_TITLES[kind]}，需要人工处理")
    return lines


# 用 MySQL 里保存的分片原文重新计算向量并写回 Milvus，返回写入数量。
# 用 upsert 按原主键覆盖，不先删除，重建过程中已有的向量仍然可以检索。
# Milvus 比 MySQL 多出的行（正常流程不会出现）不会因此删除，下次对账仍会报告，需要人工确认。
def rebuild_vectors(store, models, document_id):
    with store.engine.connect() as connection:
        rows = connection.execute(select(chunks.c.id, chunks.c.owner, chunks.c.title, chunks.c.text,
            chunks.c.chunk_key, document_chunks.c.position, document_chunks.c.chunk_metadata).select_from(
                document_chunks.join(chunks, chunks.c.id == document_chunks.c.chunk_id)).where(
                document_chunks.c.document_id == document_id)).mappings().all()
    items = []
    for row in rows:
        item = dict(row)
        item["position"] = item["position"] or 0
        items.append(item)
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start:start + BATCH_SIZE]
        texts = []
        for item in batch:
            texts.append(item["text"])
        vectors = models.embed(texts)
        data = []
        for item, vector in zip(batch, vectors):
            item["vector"] = vector
            data.append(store.vector_row(item, document_id, item["chunk_metadata"]))
        store.milvus.upsert(data, timeout=30)
    return len(items)


if __name__ == "__main__":
    main()
