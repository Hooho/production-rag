# 评测参数覆盖层：runtime_config / prompts 的覆盖只在当前线程生效；Agent 检索用自己的相关度阈值。
import json
import threading

import pytest

from app import prompts, runtime_config
from app.agentic.tools import AgentContext, execute_tool, tool_definitions
from test_agentic_tools import KnowledgeStore
from test_app import setup  # noqa: F401  pytest 夹具
from test_evaluation import headers


def in_thread(function):
    box = {}
    thread = threading.Thread(target=lambda: box.update(value=function()))
    thread.start()
    thread.join()
    return box["value"]


# 覆盖只在 with 块、只在当前线程里生效；别的线程（线上请求）读到的还是设置页的值。
def test_override_only_in_current_thread(runtime):
    runtime(agent_rerank_min_score=0.85)
    with runtime_config.override({"agent_rerank_min_score": 0.2, "return_limit": 4}):
        assert runtime_config.value("agent_rerank_min_score") == 0.2
        assert runtime_config.snapshot()["return_limit"] == 4
        assert (
            in_thread(lambda: runtime_config.snapshot()["agent_rerank_min_score"])
            == 0.85
        )
    assert runtime_config.value("agent_rerank_min_score") == 0.85


# 只能覆盖带 eval 标记的参数；范围和参数之间的约束和设置页一样。
def test_override_validation():
    assert runtime_config.check_overrides({"agent_tool_budget": 8}) == {
        "agent_tool_budget": 8
    }
    with pytest.raises(ValueError, match="不能在评测里修改"):
        runtime_config.check_overrides({"chunk_size": 400})
    with pytest.raises(ValueError, match="之间"):
        runtime_config.check_overrides({"agent_rerank_min_score": 1.5})
    with pytest.raises(ValueError, match="候选池"):
        runtime_config.check_overrides({"return_limit": 20, "rerank_candidates": 10})


class ScoredRerank:
    def rerank(self, query, documents):
        return [0.5 if "第2段" in text else 0.3 for text in documents]


# Agent 检索的相关度阈值用 agent_rerank_min_score，和固定流程的 rerank_min_score 分开。
def test_agent_search_uses_agent_threshold(runtime):
    runtime(
        parent_context=False,
        rerank_min_score=0.9,
        agent_rerank_min_score=0.4,
        rerank_fallback_min_score=0.2,
    )
    ctx = AgentContext(store=KnowledgeStore(), models=ScoredRerank(), owner="alice")
    first = execute_tool(
        ctx,
        "search_knowledge",
        json.dumps({"query": "退货需要什么条件？", "mode": "vector"}),
    )
    assert first["trace"]["evidence_ids"] == ["S1"] and "第2段" in first["content"]
    runtime(agent_rerank_min_score=0.25)
    ctx = AgentContext(store=KnowledgeStore(), models=ScoredRerank(), owner="alice")
    second = execute_tool(
        ctx,
        "search_knowledge",
        json.dumps({"query": "退货需要什么条件？", "mode": "vector"}),
    )
    assert second["trace"]["evidence_ids"] == ["S1", "S2"]


# 评测指定的提示词版本只在 with 块、当前线程里生效；不存在的版本直接报错。
def test_prompt_version_override(setup):
    client, store = setup
    client.post(
        "/prompts/agent/versions", headers=headers(), json={"text": "第一版 Agent 指令"}
    )
    client.post(
        "/prompts/agent/versions", headers=headers(), json={"text": "第二版 Agent 指令"}
    )
    assert prompts.instructions("agent") == "第二版 Agent 指令"
    picked = prompts.resolve_versions(store.engine, {"agent": 1})
    with prompts.override(picked):
        assert (
            prompts.instructions("agent") == "第一版 Agent 指令"
            and prompts.tag("agent") == "agent@v1"
        )
        assert in_thread(lambda: prompts.instructions("agent")) == "第二版 Agent 指令"
    assert prompts.instructions("agent") == "第二版 Agent 指令"
    with prompts.override(prompts.resolve_versions(store.engine, {"agent": 0})):
        assert prompts.current("agent")[0] == 0
    with pytest.raises(ValueError, match="没有 v9"):
        prompts.resolve_versions(store.engine, {"agent": 9})
    with pytest.raises(ValueError, match="不能在评测里换版本"):
        prompts.resolve_versions(store.engine, {"chunk_context": 0})


def search(**arguments):
    ctx = AgentContext(store=KnowledgeStore(), models=ScoredRerank(), owner="alice")
    return execute_tool(
        ctx,
        "search_knowledge",
        json.dumps({"query": "退货需要什么条件？", "mode": "vector", **arguments}),
    )


# Agent 每次最多返回几条用 agent_return_limit，和固定流程的 return_limit 分开；没给全时在返回里说清楚。
def test_agent_return_limit_and_truncation_note(runtime):
    runtime(
        parent_context=False,
        agent_parent_context=False,
        agent_rerank_min_score=0.25,
        return_limit=6,
        agent_return_limit=1,
    )
    first = search(top_k=5)
    assert first["trace"]["evidence_ids"] == ["S1"] and first["trace"]["hidden"] == 1
    assert first["content"].startswith(
        "没有给全：你要了 5 条，按设置每次最多返回 1 条，另有 1 条过了相关度线没有返回。"
    )
    assert first["trace"]["retrieval"]["diagnostics"]["config"]["return_limit"] == 1
    # 上限够，模型自己要得少：提示可以调大 top_k。
    runtime(agent_return_limit=6)
    fewer = search(top_k=1)
    assert fewer["content"].startswith(
        "没有给全：按你要的 1 条返回，另有 1 条过了相关度线没有返回；需要时可以调大 top_k（最多 6）再查。"
    )
    # 全部给了就不提示。
    full = search(top_k=6)
    assert (
        full["trace"]["evidence_ids"] == ["S1", "S2"] and full["trace"]["hidden"] == 0
    )
    assert not full["content"].startswith("没有给全")


# Agent 要不要做父块扩展用 agent_parent_context，和固定流程的 parent_context 分开。
def test_agent_parent_context_setting(runtime):
    runtime(
        parent_context=True, agent_parent_context=False, agent_rerank_min_score=0.25
    )
    off = search(top_k=1)
    source = off["trace"]["retrieval"]["sources"][0]
    assert source["parent_chunk_ids"] == ["c2"] and source["text"] == "第2段"
    assert off["trace"]["retrieval"]["diagnostics"]["config"]["parent_context"] is False
    runtime(agent_parent_context=True)
    on = search(top_k=1)
    assert len(on["trace"]["retrieval"]["sources"][0]["parent_chunk_ids"]) > 1


# 工具说明里 top_k 的最大值跟着 agent_return_limit；它不能超过候选池大小。
def test_agent_top_k_limit_follows_setting(setup, runtime):
    client, store = setup
    runtime(agent_return_limit=9)
    tools = tool_definitions(AgentContext(store=store, models=None, owner="admin"))
    top_k = tools[0]["function"]["parameters"]["properties"]["top_k"]
    assert top_k["maximum"] == 9 and "最多 9" in top_k["description"]
    with pytest.raises(ValueError, match="Agent 每次返回的条数不能超过候选池大小"):
        runtime_config.check_overrides(
            {"agent_return_limit": 20, "rerank_candidates": 12}
        )


# 优秀阈值：不低于它的资料全部返回，不受返回段数限制；1 表示不启用。固定流程和 Agent 分开设。
def test_fixed_excellent_score_bypasses_return_limit(runtime):
    from app.tools.search import DocumentSearchTool

    def run():
        return DocumentSearchTool().execute(
            KnowledgeStore(),
            ScoredRerank(),
            "alice",
            ["退货需要什么条件？"],
            "退货需要什么条件？",
            methods=("dense",),
        )

    runtime(
        parent_context=False,
        rerank_min_score=0.25,
        return_limit=1,
        rerank_excellent_score=1.0,
    )
    off = run()
    assert len(off["sources"]) == 1 and off["stats"]["beyond_limit"] == 1
    assert off["stats"]["excellent_score"] is None
    runtime(rerank_excellent_score=0.3)
    both = run()
    assert len(both["sources"]) == 2 and both["stats"]["beyond_limit"] == 0
    assert both["stats"]["excellent"] == 2 and both["stats"]["return_limit"] == 1
    assert both["diagnostics"]["config"]["excellent_score"] == 0.3
    # 只有一条不低于优秀阈值：它照常返回，中间那档仍按段数截断。
    runtime(rerank_excellent_score=0.45)
    one = run()
    assert len(one["sources"]) == 1 and one["stats"]["beyond_limit"] == 1
    with pytest.raises(ValueError, match="优秀阈值不能低于"):
        runtime_config.check_overrides(
            {"rerank_excellent_score": 0.5, "rerank_min_score": 0.8}
        )


def test_agent_excellent_score_bypasses_top_k_and_limit(runtime):
    runtime(
        parent_context=False,
        agent_parent_context=False,
        agent_rerank_min_score=0.25,
        agent_return_limit=1,
        agent_excellent_score=0.3,
        rerank_excellent_score=1.0,
    )
    found = search(top_k=1)
    assert found["trace"]["evidence_ids"] == ["S1", "S2"]
    assert found["trace"]["given"] == 2 and found["trace"]["hidden"] == 0
    assert found["content"].startswith(
        "你要了 1 条，相关性 0.30 以上的资料有 2 条，都给你了。"
    )
    # 只有一条不低于优秀阈值、模型要 1 条：和以前一样，提示没给全。
    runtime(agent_return_limit=6, agent_excellent_score=0.45)
    fewer = search(top_k=1)
    assert fewer["trace"]["evidence_ids"] == ["S1"] and fewer["trace"]["hidden"] == 1
    assert fewer["content"].startswith("没有给全：按你要的 1 条返回")
