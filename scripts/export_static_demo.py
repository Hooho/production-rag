"""Export a small, read-only static demo snapshot from the running RAG database.

Run this inside the API container. The output intentionally excludes credentials,
token tables, upload paths and full customer phone numbers.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/app")

from sqlalchemy import and_, create_engine, func, or_, select

from app.auth import create_access_token
from app.business.definitions import DATA_TYPES, public_schema
from app.mysql.tables import inspection_issues
from app.evaluation.dataset import QUESTION_TYPES, corpus_files, load_dataset, select_split
from app.evaluation.results import list_runs, load_run
from app.evaluation.suites import list_suites
from app.runtime_config import bind, value as runtime_value
from app.evaluation.retrieval import SUITES, VARIANTS
from app.mysql.store import (
    after_sales,
    chunks,
    customers,
    data_permissions,
    database_url,
    document_chunks,
    document_heads,
    document_permissions,
    document_shares,
    document_steps,
    documents,
    feedback,
    inventory,
    orders,
    products,
    promotions,
    reviews,
    runs,
    settings,
    shipments,
    user_group_members,
    user_groups,
    users,
)


SNAPSHOT_USER = "admin"
RUN_IDS = [
    "dab3a654-5be1-41aa-9464-3a2253c39efe",  # 现在有什么订单
    "07a3248a-1dd0-4fee-be55-1172bf99060e",  # A1003
    "259e5530-3cfe-4c86-b704-03a129413ae4",  # 现在有什么商品
    "19116bb0-c968-4114-9b17-be30f1b96814",  # 最贵的商品是什么
    "2861caeb-bec7-48d0-9934-014acd09c063",  # YouTube 最初是什么网站
    "2c1e68b8-6877-406d-ba77-f042719689c2",  # CCSS 是什么
    "6c80d609-66b4-4829-845d-db791b943537",  # 投资最重要的是什么
    "0847289d-8942-4ddf-b9ce-69d5a70d233e",  # 老板应该怎么做
]

# One complete run is enough to teach the evaluation drill-down. Other runs
# retain their real summaries and per-question outcomes without duplicating
# several megabytes of candidate diagnostics.
FULL_EVAL_RUN_ID = "20260929-060256_unknown"


def plain(row):
    return dict(row._mapping if hasattr(row, "_mapping") else row)


def mask_phone(value):
    value = str(value or "")
    if len(value) >= 7:
        return value[:3] + "****" + value[-4:]
    return "***" if value else value


def compact_response(response):
    """Keep the persisted answer and its complete, real execution trace.

    The teaching page renders retrieval diagnostics, sufficiency judgements,
    model-call metadata and persistence summaries directly from each step's
    result. Filtering those fields left several otherwise valid stages empty.
    Selected runs are already a bounded snapshot, so retaining their complete
    result objects keeps the demo truthful without issuing live requests.
    """
    compact = {key: value for key, value in response.items() if key != "steps"}
    compact["steps"] = []
    for step in response.get("steps") or []:
        item = {key: step[key] for key in (
            "id", "stage", "title", "status", "detail", "duration_ms", "elapsed_ms", "field_order"
        ) if key in step}
        result = step.get("result")
        if isinstance(result, dict):
            item["result"] = result
        compact["steps"].append(item)
    return compact


def compact_eval_run(run, include_diagnostics=False):
    """Retain one complete run and compact the repeated diagnostics in the rest."""
    if include_diagnostics:
        return run
    compact = {key: value for key, value in run.items() if key not in {"questions"}}
    compact["questions"] = []
    for question in run.get("questions") or []:
        item = {key: value for key, value in question.items() if key not in {"diagnostics", "pool"}}
        compact["questions"].append(item)
    return compact


def document_view(connection, row, current_id, group_ids):
    item = {
        "document_id": row["id"],
        "doc_key": row["doc_key"] or row["id"],
        "owner": row["owner"],
        "title": row["title"],
        "filename": row["filename"],
        "status": row["status"],
        "error": row["error"],
        "created": row["created"],
        "updated": row["updated"],
        "version": row["version"] or 1,
        "version_note": row["version_note"],
        "is_current": row["id"] == current_id,
        "document_metadata": row["document_metadata"] or {},
        "steps": [plain(step) for step in connection.execute(select(document_steps).where(
            document_steps.c.document_id == row["id"]
        ).order_by(document_steps.c.step_order)).mappings()],
    }
    permission = connection.execute(select(document_permissions.c.visibility).where(
        document_permissions.c.doc_key == item["doc_key"]
    )).scalar_one_or_none()
    shared = list(connection.execute(select(document_shares.c.group_id).where(
        document_shares.c.doc_key == item["doc_key"]
    )).scalars())
    item.update({
        "visibility": permission or "private",
        "groups": shared,
        "can_edit": row["owner"] == SNAPSHOT_USER,
        "contextual_enabled": runtime_value("contextual_retrieval"),
    })
    missing = connection.execute(select(func.count()).select_from(
        document_chunks.join(chunks, document_chunks.c.chunk_id == chunks.c.id)
    ).where(document_chunks.c.document_id == row["id"], or_(
        document_chunks.c.chunk_metadata["context"].as_string().is_(None),
        document_chunks.c.chunk_metadata["context"].as_string() == "",
    ))).scalar_one()
    item["context_missing"] = missing
    return item


def chunk_view(row, document, position):
    metadata = row["chunk_metadata"] or {}
    raw_text = row["content"] or row["text"] or ""
    lines = raw_text.splitlines()
    content_lines = list(lines)
    heading_path = metadata.get("heading_path")
    if heading_path is None and content_lines and content_lines[0].startswith("标题路径："):
        heading_path = [part.strip() for part in content_lines.pop(0)[5:].split("/") if part.strip()]
    heading_path = heading_path or []
    content = row["content"] or "\n".join(content_lines).strip()
    doc_metadata = document["document_metadata"] or {}
    section_title = metadata.get("section_title") or (heading_path[-1] if heading_path else None)
    return {
        "chunk_id": row["id"], "document_id": document["id"], "position": position,
        "document_title": document["title"], "title": section_title or document["title"],
        "section_title": section_title, "author": metadata.get("author"),
        "author_source": metadata.get("author_source"), "heading_path": heading_path,
        "content": content, "context": metadata.get("context"),
        "vector_source": metadata.get("vector_source"), "reused_from": metadata.get("reused_from"),
        "context_source": metadata.get("context_source"), "source": document["filename"],
        "char_count": metadata.get("char_count", len(content)), "token_count": metadata.get("token_count"),
        "truncated": metadata.get("truncated"), "page_start": metadata.get("page_start"),
        "page_end": metadata.get("page_end"), "element_types": metadata.get("element_types", []),
        "element_indexes": metadata.get("element_indexes", []),
        "chunking_strategy": metadata.get("chunking_strategy", doc_metadata.get("chunking_strategy")),
        "chunk_size": metadata.get("chunk_size", doc_metadata.get("chunk_size")),
        "overlap": metadata.get("overlap", doc_metadata.get("overlap")),
        "effective_chunk_size": metadata.get("effective_chunk_size"),
        "effective_overlap": metadata.get("effective_overlap"), "parser": doc_metadata.get("parser"),
        "parser_version": doc_metadata.get("parser_version"), "parse_strategy": doc_metadata.get("parse_strategy"),
    }



# ---- 通过运行中的 API 录下新页面（专项、复测集、知识巡检、运行概览、文档审核、提示词、安全样本、会话 / 长期记忆、RAG / 系统配置、证据分片）用到的只读接口响应 ----
# 这些页面的数据由多个服务函数拼出来，直接请求本容器里的 API 最省事，也保证和页面看到的完全一致。
# 只发 GET 和两个只读的 POST（证据查询 /eval/evidence、误拦检查 /security/false-positives），不改任何数据。
API_URL = os.getenv("DEMO_API_URL", "http://127.0.0.1:8000")


def api_get(token, path):
    request = urllib.request.Request(f"{API_URL}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def api_post(token, path, payload):
    request = urllib.request.Request(f"{API_URL}{path}", data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def collect_evidence(value, found):
    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "evidence" and isinstance(nested, list):
                found.extend(text.strip() for text in nested if isinstance(text, str) and text.strip())
            else:
                collect_evidence(nested, found)
    elif isinstance(value, list):
        for nested in value:
            collect_evidence(nested, found)


def capture_live(engine, dataset):
    token = create_access_token(SNAPSHOT_USER, os.environ["JWT_SECRET"])
    get = lambda path: api_get(token, path)
    live = {"ui": get("/settings/ui"), "runtime": get("/settings/runtime")}

    # 专项评测集：列表、每个评测集的题目和运行记录、每次运行的结果。
    live["suites"] = get("/eval/suites")
    live["suite_details"] = {}
    live["special_runs"] = {}
    for brief in live["suites"]["items"]:
        detail = get(f"/eval/suites/{urllib.parse.quote(brief['id'])}")
        live["suite_details"][brief["id"]] = detail
        for run in detail.get("runs", []):
            if run["id"] not in live["special_runs"] and run.get("status") != "running":
                live["special_runs"][run["id"]] = get(f"/eval/runs/{urllib.parse.quote(run['id'])}")

    # 复测集：列表、详情、每次运行的逐题结果，以及新增题目时可选的文档。
    live["sets"] = get("/eval/sets")
    live["set_details"] = {}
    live["set_runs"] = {}
    for brief in live["sets"]["items"]:
        set_id = urllib.parse.quote(brief["id"])
        detail = get(f"/eval/sets/{set_id}")
        live["set_details"][brief["id"]] = detail
        for run in detail.get("runs", []):
            live["set_runs"][f"{brief['id']}/{run['id']}"] = get(f"/eval/sets/{set_id}/runs/{urllib.parse.quote(run['id'])}")
    live["eval_documents"] = get("/eval/documents")

    # 知识巡检：不筛选和按每个状态筛选各录一份全量列表（计数会跟着状态变），其余筛选在页面里本地做。
    first = get("/inspection/issues?page=1&page_size=100")
    live["inspection_lists"] = {}
    for status in [None, *first["statuses"].keys()]:
        query = f"&status={status}" if status else ""
        page, items, base = 1, [], None
        while True:
            result = get(f"/inspection/issues?page={page}&page_size=100{query}")
            base = base or result
            items.extend(result["items"])
            if len(items) >= result["total"] or not result["items"]:
                break
            page += 1
        base["items"] = items
        live["inspection_lists"][status or "all"] = base
    with engine.connect() as connection:
        live["inspection_diagnosis"] = {row["id"]: row["diagnosis_category"] for row in connection.execute(
            select(inspection_issues.c.id, inspection_issues.c.diagnosis_category)).mappings()}
    live["inspection_issues"] = {}
    live["inspection_candidates"] = {}
    for issue in live["inspection_lists"]["all"]["items"]:
        issue_id = urllib.parse.quote(issue["id"])
        live["inspection_issues"][issue["id"]] = get(f"/inspection/issues/{issue_id}")
        live["inspection_candidates"][issue["id"]] = get(f"/inspection/issues/{issue_id}/eval-candidates")
    live["inspection_schedule"] = get("/inspection/schedule")
    live["inspection_runs"] = get("/inspection/runs")

    # 运行概览：近 7、30、90 天各录一份（按导出时的日期算）。
    live["overview"] = {str(days): get(f"/overview?days={days}") for days in (7, 30, 90)}

    # 知识库：文档列表用 API 的结果（带审核、上架状态），以及每份文档的安全扫描问题。
    live["documents"] = get("/documents")
    live["document_problems"] = {}
    for document in live["documents"]["documents"]:
        document_id = urllib.parse.quote(document["document_id"])
        try:
            live["document_problems"][document["document_id"]] = get(f"/documents/{document_id}/problems")
        except urllib.error.HTTPError:
            pass

    # 系统管理 → 文档审核：待审核和已处理两个列表，每条审核的详情（分片最多录前 5 页）。
    live["document_reviews"] = {status: get(f"/admin/document-reviews?status={status}") for status in ("pending", "done")}
    live["document_review_details"] = {}
    for status in ("pending", "done"):
        for review in live["document_reviews"][status]["items"]:
            review_id = urllib.parse.quote(review["id"])
            pages = {}
            page, total_pages = 1, 1
            while page <= min(total_pages, 5):
                detail = get(f"/admin/document-reviews/{review_id}?page={page}")
                pages[str(page)] = detail
                total_pages = (detail.get("chunks") or {}).get("total_pages") or 1
                page += 1
            live["document_review_details"][review["id"]] = pages

    # 系统管理 → 提示词：列表和每段提示词的详情（含历史版本）。
    live["prompts"] = get("/prompts")
    live["prompt_details"] = {item["id"]: get(f"/prompts/{urllib.parse.quote(item['id'])}") for item in live["prompts"]["items"]}

    # 系统管理 → 安全样本：样本库，以及误拦检查（只读：拿内置正常问题和最近的提问比对样本库）。
    live["security_samples"] = get("/security/samples")
    try:
        live["security_false_positives"] = api_post(token, "/security/false-positives", {})
    except urllib.error.HTTPError:
        live["security_false_positives"] = None

    # 会话记忆和长期记忆：快照用户（admin）自己的。
    live["memory_sessions"] = get("/memory/sessions")
    live["memory_session_details"] = {}
    for item in live["memory_sessions"]["items"]:
        session_id = item.get("session_id") or item.get("id")
        live["memory_session_details"][session_id] = get(f"/memory/sessions/{urllib.parse.quote(session_id)}")
    live["memory_long"] = get("/memory/long")

    # 评测题目里「看证据所在的分片」：把调参评测集和专项评测集里出现过的证据都查一遍。
    texts = []
    collect_evidence(dataset, texts)
    collect_evidence(live["suite_details"], texts)
    texts = list(dict.fromkeys(texts))
    live["evidence"] = {"imported": True, "cuts_available": False, "items": {}}
    for start in range(0, len(texts), 20):
        result = api_post(token, "/eval/evidence", {"texts": [text[:1000] for text in texts[start:start + 20]]})
        live["evidence"]["imported"] = result["imported"]
        live["evidence"]["cuts_available"] = result["cuts_available"]
        for original, item in zip(texts[start:start + 20], result["items"]):
            live["evidence"]["items"][original] = item["chunks"]
    return live


def main():
    engine = create_engine(database_url(), pool_pre_ping=True)
    # 评测题目和评测结果都存在数据库里，list_runs、load_run 等读的是绑定的这个库。
    bind(engine)
    with engine.connect() as connection:
        user = plain(connection.execute(select(
            users.c.username, users.c.is_admin, users.c.disabled, users.c.created
        ).where(users.c.username == SNAPSHOT_USER)).mappings().one())
        group_rows = connection.execute(select(user_groups).order_by(user_groups.c.id)).mappings().all()
        all_memberships = [plain(row) for row in connection.execute(select(user_group_members)).mappings()]
        memberships = [row for row in all_memberships if row["username"] == SNAPSHOT_USER]
        group_ids = [row["group_id"] for row in memberships]
        user["groups"] = group_ids
        groups = [plain(row) for row in group_rows]

        heads = connection.execute(select(document_heads).order_by(document_heads.c.updated.desc())).mappings().all()
        document_items = []
        chunk_pages = {}
        for head in heads:
            row = connection.execute(select(documents).where(
                documents.c.id == head["current_document_id"]
            )).mappings().one()
            visibility = connection.execute(select(document_permissions.c.visibility).where(
                document_permissions.c.doc_key == head["doc_key"]
            )).scalar_one_or_none() or "private"
            shared_groups = set(connection.execute(select(document_shares.c.group_id).where(
                document_shares.c.doc_key == head["doc_key"]
            )).scalars())
            readable = row["owner"] == SNAPSHOT_USER or visibility == "public" or bool(shared_groups.intersection(group_ids))
            if not readable:
                continue
            item = document_view(connection, row, head["current_document_id"], group_ids)
            siblings = connection.execute(select(documents).where(
                documents.c.doc_key == head["doc_key"]
            ).order_by(documents.c.version.desc())).mappings().all()
            item["version_count"] = len(siblings)
            item["pending"] = None
            item["versions"] = [{
                "document_id": sibling["id"], "version": sibling["version"] or 1,
                "status": sibling["status"], "error": sibling["error"], "filename": sibling["filename"],
                "created": sibling["created"], "version_note": sibling["version_note"],
                "is_current": sibling["id"] == head["current_document_id"],
            } for sibling in siblings]
            document_items.append(item)

            joined = document_chunks.join(chunks, document_chunks.c.chunk_id == chunks.c.id)
            total = connection.execute(select(func.count()).select_from(joined).where(
                document_chunks.c.document_id == row["id"]
            )).scalar_one()
            selected = connection.execute(select(
                document_chunks.c.position, document_chunks.c.chunk_metadata,
                chunks.c.id, chunks.c.title, chunks.c.text, chunks.c.content,
            ).select_from(joined).where(document_chunks.c.document_id == row["id"]).order_by(
                document_chunks.c.position, chunks.c.id
            ).limit(10)).mappings().all()
            views = [chunk_view(chunk, row, index + 1) for index, chunk in enumerate(selected)]
            sample_total = len(views)
            average_length = connection.execute(select(func.avg(func.length(
                func.coalesce(chunks.c.content, chunks.c.text)
            ))).select_from(joined).where(document_chunks.c.document_id == row["id"])).scalar_one()
            source_counts = {}
            for source in ("reused", "computed"):
                source_counts[source] = connection.execute(select(func.count()).select_from(joined).where(
                    document_chunks.c.document_id == row["id"],
                    document_chunks.c.chunk_metadata["vector_source"].as_string() == source,
                )).scalar_one()
            chunk_pages[row["id"]] = {
                "document_id": row["id"],
                "document": {"document_id": row["id"], "title": row["title"], "filename": row["filename"],
                    "uploaded_at": row["created"], "updated_at": row["updated"],
                    "metadata": row["document_metadata"] or {}},
                "page": 1, "page_size": 10, "total": sample_total,
                "total_pages": 1, "average_length": round(float(average_length or 0)),
                "snapshot_sample": True, "source_total": total,
                "source": None, "source_counts": source_counts, "chunks": views,
            }

        table_map = {
            "products": products, "customers": customers, "orders": orders, "inventory": inventory,
            "shipments": shipments, "after_sales": after_sales, "promotions": promotions, "reviews": reviews,
        }
        records = {}
        labels = {"products": {}, "customers": {}, "orders": {}}
        for key, table in table_map.items():
            rows = connection.execute(select(table).where(table.c.deleted_at.is_(None)).order_by(table.c.id)).mappings().all()
            values = []
            for row in rows:
                value = plain(row)
                value.pop("deleted_at", None)
                if key == "customers":
                    value["phone"] = mask_phone(value.get("phone"))
                values.append(value)
                if key in labels:
                    display = DATA_TYPES[key]["display"]
                    labels[key][value["id"]] = value.get(display) or value["id"]
            records[key] = values[:3]
        for key, values in records.items():
            for value in values:
                for field in DATA_TYPES[key]["fields"]:
                    if field.get("type") == "ref" and value.get(field["name"]):
                        value[field["name"] + "_label"] = labels.get(field["ref"], {}).get(value[field["name"]], value[field["name"]])

        selected_runs = connection.execute(select(runs).where(runs.c.id.in_(RUN_IDS))).mappings().all()
        selected_by_id = {row["id"]: plain(row) for row in selected_runs}
        history = []
        responses = {}
        for run_id in RUN_IDS:
            row = selected_by_id.get(run_id)
            if not row:
                continue
            response = compact_response(row["response"] or {})
            feedback_row = connection.execute(select(feedback).where(feedback.c.run_id == run_id)).mappings().first()
            feedback_value = plain(feedback_row) if feedback_row else None
            responses[row["question"]] = response
            history.append({"id": row["id"], "session_id": row["session_id"], "question": row["question"],
                "response": response, "created": row["created"], "feedback": feedback_value})

        schemas = []
        for key in DATA_TYPES:
            schema = public_schema(key)
            schema["permissions"] = ["read", "create", "update", "delete"]
            schemas.append(schema)

        permission_rows = [plain(row) for row in connection.execute(select(data_permissions)).mappings()]
        saved = connection.execute(select(settings).where(settings.c.key == "llm")).mappings().first()
        saved_value = (saved["value"] or {}) if saved else {}
        llm_settings = {
            "model_mode": os.getenv("MODEL_MODE", "demo"),
            "provider": saved_value.get("provider", "openai"),
            "base_url": saved_value.get("base_url", os.getenv("LLM_BASE_URL", "")),
            "model": saved_value.get("model", os.getenv("LLM_MODEL", "")),
            "api_key_masked": "已配置（快照未包含密钥）" if saved_value.get("api_key") or os.getenv("LLM_API_KEY") else "",
            "has_api_key": bool(saved_value.get("api_key") or os.getenv("LLM_API_KEY")),
            "source": "settings" if saved else "env",
            "updated": saved["updated"] if saved else None,
        }

        counts = {}
        for key, table in {**table_map, "documents": documents, "chunks": chunks, "runs": runs}.items():
            counts[key] = connection.execute(select(func.count()).select_from(table)).scalar_one()

    # 调参评测集和专项评测集的题目存在数据库里，用上面同一个连接读取。
    dataset = load_dataset(engine)
    eval_runs = [run for run in list_runs() if run["id"] == FULL_EVAL_RUN_ID]
    eval_run_details = {}
    for index, brief in enumerate(eval_runs):
        detail = compact_eval_run(
            load_run(brief["id"]) or brief,
            include_diagnostics=brief["id"] == FULL_EVAL_RUN_ID,
        )
        detail["previous_id"] = eval_runs[index + 1]["id"] if index + 1 < len(eval_runs) else None
        eval_run_details[brief["id"]] = detail
    suites = []
    for key, label in SUITES.items():
        suites.append({"key": key, "label": label, "variants": [
            variant["label"] for variant in VARIANTS.values() if variant["suite"] == key
        ]})

    snapshot = {
        "metadata": {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "source": "production-rag local MySQL and versioned eval files",
            "counts": counts,
            "privacy": "passwords, tokens, API keys, upload paths and full phone numbers excluded",
        },
        "user": user, "groups": groups, "memberships": all_memberships,
        "users": [plain(row) for row in engine.connect().execute(select(
            users.c.username, users.c.is_admin, users.c.disabled, users.c.created
        ).order_by(users.c.username)).mappings()],
        "documents": document_items, "chunk_pages": chunk_pages,
        "data_types": schemas, "records": records, "responses": responses, "history": history,
        "data_permissions": permission_rows,
        "eval_dataset": {"items": dataset, "types": QUESTION_TYPES,
            "corpus": [path.stem for path in corpus_files()],
            "reviewed_count": len(select_split(dataset, "all")),
            "pending_count": len(dataset) - len(select_split(dataset, "all"))},
        "eval_runs": {"runs": eval_runs, "running": None, "suites": suites},
        "eval_suites": list_suites(engine),
        "eval_run_details": eval_run_details,
        "llm_settings": llm_settings,
        # 新页面（专项、复测集、知识巡检、RAG / 系统配置、证据分片）的只读接口响应。
        "live": capture_live(engine, dataset),
    }
    print(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), default=str))


if __name__ == "__main__":
    main()
