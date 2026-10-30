# 一次评测跑多组配置（批次）：每组照自己保存的表单内容跑，按顺序跑完，放进同一份批次报告。
import time

from app.evaluation import batch as eval_batch
from app.evaluation.results import save_run, start_run
from app.evaluation.retrieval import import_corpus
from app.models import Models
from test_app import setup  # noqa: F401  pytest 夹具
from test_evaluation import eval_dir, fake_rerank, headers  # noqa: F401  pytest 夹具


def wait_batch(client, batch_id):
    for _ in range(200):
        report = client.get(f"/eval/batches/{batch_id}", headers=headers()).json()
        if all(arm["status"] not in ("running", "queued") for arm in report["arms"]):
            return report
        time.sleep(0.05)
    raise AssertionError("批次没有跑完")


def test_batch_runs_each_config_and_reports(setup, eval_dir, monkeypatch, runtime):
    client, store = setup
    monkeypatch.setattr(Models, "rerank", fake_rerank)
    runtime(rerank_min_score=0.3, contextual_retrieval=False)
    import_corpus(store, client.app.state.models)
    # 有一组不合法时整批不跑，报错写明是哪一组。
    bad = client.post(
        "/eval/batches",
        headers=headers(),
        json={
            "configs": [
                {"split": "all"},
                {
                    "split": "all",
                    "label": "宽松",
                    "params": {"settings": {"chunk_size": 300}},
                },
            ]
        },
    )
    assert bad.status_code == 422 and bad.json()["detail"].startswith("宽松：")
    assert client.get("/eval/runs", headers=headers()).json()["runs"] == []
    too_many = client.post(
        "/eval/batches", headers=headers(), json={"configs": [{"split": "all"}] * 5}
    )
    assert too_many.status_code == 422

    started = client.post(
        "/eval/batches",
        headers=headers(),
        json={
            "name": "返回条数对比",
            "configs": [
                {"split": "all"},
                {
                    "split": "dev",
                    "label": "只返回 1 段",
                    "params": {"settings": {"return_limit": 1}},
                },
            ],
        },
    )
    assert started.status_code == 202
    body = started.json()
    assert len(body["runs"]) == 2
    report = wait_batch(client, body["id"])
    assert report["name"] == "返回条数对比"
    assert [arm["label"] for arm in report["arms"]] == ["配置 A", "只返回 1 段"]
    assert [arm["status"] for arm in report["arms"]] == ["completed", "completed"]
    assert report["arms"][1]["params"] == {"settings": {"return_limit": 1}}
    # 每组的完整结果原样带上，前端用单次评测同一套报告组件一列一列并排。
    assert len(report["runs"][0]["questions"]) == 4
    assert len(report["runs"][1]["questions"]) == 3
    assert report["runs"][1]["config"]["return_limit"] == 1
    diff = {row["key"]: row["values"] for row in report["config_diff"]}
    assert (
        diff["setting:return_limit"] == [6, 1]
        and "题目" in diff
        and "运行模式" not in diff
    )
    # 每组也是一条普通评测记录，带着批次信息。
    runs = client.get("/eval/runs", headers=headers()).json()["runs"]
    assert {run["batch"]["id"] for run in runs} == {body["id"]}
    assert sorted(run["batch"]["index"] for run in runs) == [0, 1]
    assert client.get("/eval/batches/nope", headers=headers()).status_code == 404
    assert (
        client.get(f"/eval/batches/{body['id']}", headers=headers("alice")).status_code
        == 403
    )


# 进程中途退出过：排队中的记录不属于正在跑的批次，显示成已中断，也可以删除。
def test_queued_run_of_dead_batch_is_interrupted(setup, eval_dir):
    client, _ = setup
    run = start_run("retrieval", "all", [])
    run["batch"] = {
        "id": eval_batch.new_batch_id(),
        "index": 1,
        "size": 2,
        "label": "配置 B",
        "name": "",
    }
    run["status"] = "queued"
    save_run(run)
    listed = client.get("/eval/runs", headers=headers()).json()["runs"][0]
    assert listed["status"] == "interrupted"
    assert (
        client.delete(f"/eval/runs/{run['id']}", headers=headers()).status_code == 200
    )
