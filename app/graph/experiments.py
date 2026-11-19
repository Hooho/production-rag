"""Persisted dry runs; only the experiments table is ever written."""

import copy
import json
import time
import uuid

from sqlalchemy import select

from .. import prompts
from ..mysql.tables import (
    graph_experiments as table,
    graph_versions,
    graph_mentions,
    graph_entities,
    graph_aliases,
    documents,
)
from . import build, resolve
from .extract import PROMPT_ID, extract_chunk
from .schemas import now, ONLINE_SPACE


def view(row):
    return {**dict(row), "data": copy.deepcopy(row["data"])}


def get(engine, experiment_id):
    with engine.connect() as connection:
        row = (
            connection.execute(select(table).where(table.c.id == experiment_id))
            .mappings()
            .first()
        )
    if row is None:
        raise ValueError("实验记录不存在")
    return view(row)


def listing(engine):
    with engine.connect() as connection:
        rows = (
            connection.execute(
                select(table.c.id, table.c.status, table.c.created, table.c.updated)
                .order_by(table.c.created.desc())
                .limit(100)
            )
            .mappings()
            .all()
        )
    return [dict(row) for row in rows]


def references(engine):
    with engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                select(graph_versions.c.id, documents.c.title, graph_versions.c.number)
                .join(documents, documents.c.id == graph_versions.c.document_id)
                .order_by(graph_versions.c.created.desc())
                .limit(500)
            ).mappings()
        ]


def snapshot_reference(engine, version_id):
    if not version_id:
        return {"entities": {}, "aliases": {}}
    with engine.connect() as connection:
        version = (
            connection.execute(
                select(graph_versions).where(graph_versions.c.id == version_id)
            )
            .mappings()
            .first()
        )
        if version is None:
            raise ValueError("参照图谱不存在")
        ids = select(graph_mentions.c.entity_id).where(
            graph_mentions.c.build_id == version_id
        )
        entities = {
            row["merge_key"]: {"id": row["id"], "name": row["name"]}
            for row in connection.execute(
                select(graph_entities).where(graph_entities.c.id.in_(ids))
            ).mappings()
        }
        aliases = dict(
            connection.execute(
                select(graph_aliases.c.alias_key, graph_aliases.c.entity_id).where(
                    graph_aliases.c.entity_id.in_(ids)
                )
            ).all()
        )
    return {"entities": entities, "aliases": aliases, "version": dict(version)}


def create(store, models, payload, owner):
    text = payload["text"].strip()
    if not text:
        raise ValueError("请输入分片文字")
    schema = build.schema_for(store.engine, payload.get("schema_id"))
    llm, _ = build.resolve_llm(store, models, payload.get("llm"))
    version = payload.get("prompt_version")
    if version is None:
        version, instructions = prompts.current(PROMPT_ID)
    else:
        detail = prompts.detail(store.engine, PROMPT_ID)
        chosen = next(
            (item for item in detail["versions"] if item["version"] == version), None
        )
        if chosen is None:
            raise ValueError("提示词版本不存在")
        instructions = chosen["text"]
    data = {
        "text": text,
        "schema": schema,
        "llm": llm,
        "prompt_version": version,
        "system_prompt": instructions + "\n" + prompts.BY_ID[PROMPT_ID]["locked"],
        "reference": snapshot_reference(store.engine, payload.get("reference_id")),
        "steps": [],
    }
    experiment_id = str(uuid.uuid4())
    with store.engine.begin() as connection:
        connection.execute(
            table.insert().values(
                id=experiment_id,
                owner=owner,
                status="queued",
                created=now(),
                updated=now(),
                data=data,
            )
        )
    enqueue(store, experiment_id)
    return get(store.engine, experiment_id)


def enqueue(store, experiment_id):
    try:
        store.cache.rpush(
            build.QUEUE,
            json.dumps(
                {"type": "graph", "stage": "experiment", "experiment_id": experiment_id}
            ),
        )
    except Exception:
        with store.engine.begin() as connection:
            connection.execute(
                table.update()
                .where(table.c.id == experiment_id)
                .values(status="failed", updated=now())
            )
        raise


def retry(store, experiment_id):
    with store.engine.begin() as connection:
        row = (
            connection.execute(
                select(table).where(table.c.id == experiment_id).with_for_update()
            )
            .mappings()
            .first()
        )
        if row is None or row["status"] != "failed":
            raise ValueError("只有失败的实验可以重试")
        connection.execute(
            table.update()
            .where(table.c.id == experiment_id)
            .values(status="queued", updated=now())
        )
    enqueue(store, experiment_id)
    return get(store.engine, experiment_id)


def save(store, experiment_id, data, status="running"):
    with store.engine.begin() as connection:
        connection.execute(
            table.update()
            .where(table.c.id == experiment_id)
            .values(data=data, status=status, updated=now())
        )


def run(store, models, experiment_id):
    with store.engine.begin() as connection:
        claimed = connection.execute(
            table.update()
            .where(table.c.id == experiment_id, table.c.status == "queued")
            .values(status="running", updated=now())
        ).rowcount
    if not claimed:
        return
    data = get(store.engine, experiment_id)["data"]
    steps = data["steps"]
    # Completed outputs are immutable checkpoints; retry replaces only the failed step.
    if steps and steps[-1]["status"] == "failed":
        steps.pop()
    names = ["模型抽取与解析校验", "实体合并", "关系整理"]
    try:
        for index in range(len(steps), len(names)):
            started = time.monotonic()
            step = {
                "name": names[index],
                "status": "running",
                "input": {},
                "output": None,
            }
            steps.append(step)
            save(store, experiment_id, data)
            if index == 0:
                selected_models = build.models_for(store, models, data["llm"])
                step["input"] = {
                    "text": data["text"],
                    "schema": data["schema"],
                    "system_prompt": data["system_prompt"],
                }
                result = extract_chunk(
                    selected_models,
                    data["schema"],
                    {"content": data["text"], "document_title": "提取实验"},
                    data["system_prompt"],
                )
                step["output"] = result
                if result["status"] == "failed":
                    raise ValueError(result["error"])
            elif index == 1:
                extracted = steps[0]["output"]["result"]
                step["input"] = {
                    "entities": extracted["entities"],
                    "reference": data["reference"],
                }
                extraction = {
                    "id": experiment_id,
                    "document_id": experiment_id,
                    "chunk_id": experiment_id,
                    "result": extracted,
                }
                with store.engine.connect() as connection:
                    plan = resolve.prepare_build(
                        connection,
                        ONLINE_SPACE,
                        experiment_id,
                        [extraction],
                        reference=data["reference"],
                    )
                entity_names = {row["id"]: row["name"] for row in plan["entities"]}
                entity_names.update(
                    {
                        row["id"]: row["name"]
                        for row in data["reference"]["entities"].values()
                    }
                )
                for mention in plan["mentions"]:
                    mention["resolved_name"] = entity_names.get(
                        mention["entity_id"], mention["canonical"]
                    )
                step["output"] = plan
            else:
                plan = steps[1]["output"]
                step["input"] = {"relations": steps[0]["output"]["result"]["relations"]}
                mentions = {row["id"]: row for row in plan["mentions"]}
                step["output"] = {
                    "entities": plan["mentions"],
                    "summary": plan["summary"],
                    "relations": [
                        {
                            **row,
                            "source": mentions[row["source_mention_id"]][
                                "resolved_name"
                            ],
                            "target": mentions[row["target_mention_id"]][
                                "resolved_name"
                            ],
                        }
                        for row in plan["relations"]
                    ],
                }
            step.update(
                status="completed",
                duration_ms=round((time.monotonic() - started) * 1000),
            )
            save(store, experiment_id, data)
        save(store, experiment_id, data, "completed")
    except Exception as error:
        steps[-1].update(status="failed", error=str(error)[:2000])
        save(store, experiment_id, data, "failed")


def recover(store):
    queued = {
        json.loads(raw).get("experiment_id")
        for raw in store.cache.lrange(build.QUEUE, 0, -1)
    }
    with store.engine.begin() as connection:
        rows = (
            connection.execute(
                select(table).where(table.c.status.in_(("queued", "running")))
            )
            .mappings()
            .all()
        )
        for row in rows:
            data = copy.deepcopy(row["data"])
            data["steps"] = [
                step for step in data["steps"] if step["status"] == "completed"
            ]
            connection.execute(
                table.update()
                .where(table.c.id == row["id"])
                .values(status="queued", data=data, updated=now())
            )
    for row in rows:
        if row["id"] not in queued:
            enqueue(store, row["id"])
    return len(rows)
