"""显式覆盖 Agent 区分题的四道汇总题；旧数据在同一事务中备份到 settings。"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from uuid import uuid4


SUITE_NAME = "Agent 区分题"
OLD_REGRET_QUESTION = "段永平在投资上犯过哪些错、错过了什么？"
REGRET_QUESTION = "书里提到段永平在投资判断、买卖决策和学习上，有过哪些失误或遗憾？"


def plan_overwrite(seed_items, rows):
    plans = []
    for item in seed_items:
        if item.get("type") != "汇总":
            continue
        names = {item["question"]}
        if item["question"] == REGRET_QUESTION:
            names.add(OLD_REGRET_QUESTION)
        matches = [row for row in rows if (row.get("data") or {}).get("question") in names]
        if len(matches) != 1:
            raise ValueError(f"题目「{item['question']}」匹配到 {len(matches)} 条，未执行覆盖")
        if matches[0]["data"] != item:
            plans.append((matches[0], item))
    return plans


def overwrite(engine, seed, dry_run=False):
    from sqlalchemy import select
    from app.mysql.tables import eval_suite_items, eval_suites, settings

    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as connection:
        suite_id = connection.execute(select(eval_suites.c.id).where(
            eval_suites.c.name == SUITE_NAME)).scalar_one_or_none()
        if suite_id is None:
            raise ValueError(f"专项「{SUITE_NAME}」不存在，未执行覆盖")
        rows = connection.execute(select(eval_suite_items).where(
            eval_suite_items.c.suite_id == suite_id).with_for_update()).mappings().all()
        plans = plan_overwrite(seed["items"], rows)
        report = {"suite": SUITE_NAME, "updated": len(plans), "dry_run": dry_run,
            "questions": [{"question": data["question"], "scoring_items": len(data["evidence_groups"])}
                for _, data in plans]}
        if dry_run or not plans:
            return report
        backup_key = f"eval_summary_backup_{uuid4().hex}"
        connection.execute(settings.insert().values(key=backup_key, updated=now, value={
            "suite_id": suite_id, "at": now, "seed_revision": seed.get("revision"),
            "items": [dict(row) for row, _ in plans]}))
        for row, data in plans:
            connection.execute(eval_suite_items.update().where(eval_suite_items.c.id == row["id"],
                eval_suite_items.c.suite_id == suite_id).values(data=data, updated=now))
        report["backup_key"] = backup_key
        return report


def main():
    from sqlalchemy import create_engine
    from app.mysql.store import database_url

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只显示将覆盖的题目")
    args = parser.parse_args()
    path = Path(os.getenv("EVAL_DIR", "eval")) / "seed" / "suites.json"
    seed = next(suite for suite in json.loads(path.read_text())["suites"] if suite["name"] == SUITE_NAME)
    engine = create_engine(database_url(), pool_pre_ping=True)
    try:
        print(json.dumps(overwrite(engine, seed, args.dry_run), ensure_ascii=False, indent=2))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
