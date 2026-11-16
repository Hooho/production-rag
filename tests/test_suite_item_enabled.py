from unittest.mock import MagicMock

from unittest import TestCase

import ast
import copy
from pathlib import Path


def load_function(path, name, namespace):
    tree = ast.parse(Path(path).read_text())
    node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == name
    )
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), namespace)
    return namespace[name]


# Load the selection functions without requiring model-serving dependencies.
questions = load_function(
    "app/evaluation/configuration.py", "questions", {"copy": copy}
)
load_for_run = load_function(
    "app/evaluation/suites.py",
    "load_for_run",
    {
        "select": MagicMock(),
        "eval_suites": MagicMock(),
        "eval_suite_items": MagicMock(),
    },
)


def test_questions_skip_disabled_without_changing_input():
    suite = {
        "id": "s",
        "name": "题集",
        "items": [
            {"id": "a", "question": "旧题"},
            {"id": "b", "question": "禁用题", "enabled": False},
            {"id": "c", "question": "启用题", "enabled": True},
        ],
    }
    assert [item["id"] for item in questions([], "all", [suite])] == ["s:a", "s:c"]
    assert len(suite["items"]) == 3


def test_run_loader_filters_disabled_and_rejects_empty_suite():
    engine = MagicMock()
    connection = engine.connect.return_value.__enter__.return_value
    connection.execute.return_value.mappings.return_value.first.return_value = {
        "id": "s",
        "name": "题集",
        "description": "",
        "method": "retrieval",
        "search_mode": "hybrid",
    }
    rows = connection.execute.return_value.mappings.return_value
    rows.all.return_value = [
        {"id": "a", "data": {"question": "旧题"}},
        {"id": "b", "data": {"enabled": False}},
    ]
    assert [item["id"] for item in load_for_run(engine, ["s"])[0]["items"]] == ["a"]
    rows.all.return_value = [{"id": "b", "data": {"enabled": False}}]
    with TestCase().assertRaisesRegex(ValueError, "没有启用的题目"):
        load_for_run(engine, ["s"])


if __name__ == "__main__":
    test_questions_skip_disabled_without_changing_input()
    test_run_loader_filters_disabled_and_rejects_empty_suite()
    print("suite enabled checks passed")
