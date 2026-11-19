"""Run without model-service dependencies: python3 tests/test_agent_source_budget.py."""

import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


def check():
    tree = ast.parse(Path("app/agentic/tools.py").read_text())
    node = next(
        n
        for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "search_knowledge"
    )
    settings = dict(
        agent_source_selection_mode="tokens",
        agent_source_token_budget=8000,
        agent_return_limit=1,
        agent_rerank_min_score=0.5,
        agent_parent_context=True,
        agent_excellent_score=1,
    )
    namespace = dict(
        TOP_K_DEFAULT=1,
        SEARCH_MODES={"hybrid": ("dense",)},
        runtime_snapshot=lambda: settings,
        invalid=lambda text: text,
        result=lambda content, **kwargs: dict(content=content, **kwargs),
        format_source=lambda *args: "source",
        truncation_note=lambda *args: "",
    )
    exec(compile(ast.Module(body=[node], type_ignores=[]), "<tool>", "exec"), namespace)
    truncation = next(
        n
        for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "truncation_note"
    )
    exec(
        compile(ast.Module(body=[truncation], type_ignores=[]), "<tool>", "exec"),
        namespace,
    )
    assert namespace["truncation_note"](1, 1, 1, 0, 2, None) == ""
    ctx = MagicMock()
    ctx.evidence.add.return_value = ("S1", True)
    ctx.search_tool.execute.return_value = dict(
        sources=[dict(id="S1", chunk_id="a"), dict(id="S2", chunk_id="b")], stats={}
    )
    result = namespace["search_knowledge"](ctx, "question")
    assert result["given"] == 2
    assert ctx.search_tool.execute.call_args.kwargs["source_selection_mode"] == "tokens"
    settings["agent_source_selection_mode"] = "count"
    assert namespace["search_knowledge"](ctx, "question")["given"] == 1
    ctx.search_tool.execute.return_value = dict(
        sources=[],
        relations=[dict(id="G1", relation_id="r", text="relation")],
        stats={},
    )
    result = namespace["search_knowledge"](ctx, "question")
    assert result["relation_ids"] and not result["no_new"]
    print("Agent source budget checks passed")


if __name__ == "__main__":
    check()
