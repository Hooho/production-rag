import argparse
import sys

from app.inspection.schedule import load_schedule
from app.inspection.service import KINDS, InspectionBusy, list_issues, run_inspection
from app.models import Models
from app.storage import Storage


# 知识巡检：从问答日志收集拒答、资料不足、差评和处理失败，合并成待处理问题，结果在「知识巡检」页查看。
# 不调用大模型，只用 Embedding 给答不上来的问题聚类，可以放进定时任务每天跑。
# 文件名不用 inspect.py：会和标准库 inspect 模块重名。
# 用法：docker compose exec api python -m scripts.inspection [--days 30]
# 本次有新增或重新打开的问题时退出码为 1，方便定时任务判断是否需要通知。
def main():
    parser = argparse.ArgumentParser(description="知识巡检")
    parser.add_argument("--days", type=int, default=None, help="扫描最近多少天的问答，默认用页面上定时巡检设置的扫描范围")
    args = parser.parse_args()
    models = Models()
    store = Storage(models)
    try:
        try:
            days = args.days or load_schedule(store)["days"]
            result = run_inspection(store, models, trigger="cli", days=days)
        except InspectionBusy as error:
            print(error)
            sys.exit(2)
        summary = result["summary"]
        print(f"巡检完成 {result['id']}，扫描 {result['since'][:10]} 之后的问答 {summary.get('scanned_runs', 0)} 条、"
              f"处理失败 {summary.get('scanned_errors', 0)} 条")
        created = 0
        for kind, label in KINDS.items():
            count = summary.get("created_" + kind, 0)
            created += count
            print(f"新增{label}：{count}")
        print(f"重新打开：{summary.get('reopened', 0)}，自动解决：{summary.get('auto_resolved', 0)}")
        print(f"拒答分类：重跑了 {summary.get('diagnosed', 0)} 个知识缺口，验证通过 {summary.get('verified', 0)} 个，"
              f"验证未通过重新打开 {summary.get('verification_failed', 0)} 个")
        print(f"权限保密复查：权限已放开自动解决 {summary.get('recheck_resolved', 0)} 个，"
              f"资料已不在重新打开 {summary.get('recheck_reopened', 0)} 个")
        print(f"当前待处理：{summary.get('total_open', 0)}")
        for issue in list_issues(store, status="open", page_size=10)["items"]:
            print(f"  [{issue['kind_label']}] {issue['title']}（{issue['occurrences']} 次，{issue['users']} 人）")
        if created or summary.get("reopened"):
            sys.exit(1)
    finally:
        store.close()


if __name__ == "__main__":
    main()
