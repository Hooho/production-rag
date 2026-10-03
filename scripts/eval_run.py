import argparse

from app.evaluation.dataset import load_dataset
from app.evaluation.results import compare_runs, execute_run, list_runs, previous_run, start_run
from app.evaluation.retrieval import VARIANTS, refresh_rewrites
from app.agent.response import ResponseAgent
from app.models import Models
from app.storage import Storage


# 把指标格式化成便于在终端阅读的文本。
def format_value(value):
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


# 命令行运行评测，默认只跑检索评测（不调用大模型，快、不花钱，每次改动都可以跑）：
#   python -m scripts.eval_run                       基线检索评测（dev 题目）
#   python -m scripts.eval_run --suite ablation      加上消融实验：仅向量 / 仅 BM25 / 混合不重排
#   python -m scripts.eval_run --suite params        加上参数对比：候选池 12/30、多查询取最好名次
#   python -m scripts.eval_run --generation          同时做生成评测（需要 MODEL_MODE=openai，会产生少量费用）
#   python -m scripts.eval_run --split holdout       只在留出集上做最终验证
#   python -m scripts.eval_run --refresh-rewrites    重新用大模型生成并缓存查询改写
# 结果保存到 eval/results/日期时间_提交号.json，并自动与上一次同类评测对比。
def main():
    parser = argparse.ArgumentParser(description="production-rag 评测")
    parser.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    parser.add_argument("--suite", action="append", choices=sorted({variant["suite"] for variant in VARIANTS.values()}),
        default=[])
    parser.add_argument("--generation", action="store_true")
    parser.add_argument("--refresh-rewrites", action="store_true")
    args = parser.parse_args()
    models = Models()
    if args.generation and models.mode != "openai":
        raise SystemExit("生成评测需要真实大模型：请设置 MODEL_MODE=openai 和 LLM_API_KEY")
    items = load_dataset()
    if args.refresh_rewrites:
        refresh_rewrites(models, items)
        print("已更新 eval/rewrites.json")
    store = Storage(models)
    responder = None
    try:
        if args.generation:
            # 评测的对话线程不写入生产用的 PostgreSQL Checkpointer：每道题一个临时线程，
            # 写进去只会堆积无用数据，所以回答 Agent 改用进程内记忆，脚本结束即释放。
            responder = ResponseAgent(models, use_postgres=False)
        run = start_run("generation" if args.generation else "retrieval", args.split, args.suite)
        print(f"开始评测 {run['id']}")
        run = execute_run(store, models, items, run, generate=args.generation, responder=responder)
    finally:
        if responder is not None:
            responder.close()
        store.close()
    print(f"完成：eval/results/{run['id']}.json")
    base = previous_run(run, list_runs())
    if base is None:
        for key, value in run["summary"].items():
            print(f"{key}: {format_value(value)}")
        print("没有可对比的上一次评测")
        return
    comparison = compare_runs(base, run)
    marks = {"better": "变好", "worse": "变差", "same": "持平", "unknown": "—"}
    print(f"与上一次 {base['id']} 对比：")
    for row in comparison["metrics"]:
        print(f"{row['label']}: {format_value(row['base'])} → {format_value(row['target'])} {marks[row['change']]}")


if __name__ == "__main__":
    main()
