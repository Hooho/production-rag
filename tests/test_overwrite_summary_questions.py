import copy
import json
from pathlib import Path
import unittest

from scripts.overwrite_summary_questions import OLD_REGRET_QUESTION, REGRET_QUESTION, plan_overwrite


class OverwriteSummaryQuestionsTest(unittest.TestCase):
    def setUp(self):
        suites = json.loads((Path(__file__).parents[1] / "eval/seed/suites.json").read_text())["suites"]
        self.items = next(suite["items"] for suite in suites if suite["name"] == "Agent 区分题")
        self.rows = [{"id": str(index), "data": copy.deepcopy(item), "created_by": "system",
            "created": "old", "updated": "old"} for index, item in enumerate(self.items)]

    def test_overwrites_manual_edits_and_old_question_name_only_for_summaries(self):
        for row in self.rows:
            row["data"]["reference_answer"] = "手动编辑过的旧答案"
            row["updated"] = "new"
            if row["data"]["question"] == REGRET_QUESTION:
                row["data"]["question"] = OLD_REGRET_QUESTION
        self.rows.append({"id": "custom", "data": {"question": "用户新加的题"}})
        plans = plan_overwrite(self.items, self.rows)
        self.assertEqual(len(plans), 4)
        self.assertEqual([len(data["evidence_groups"]) for _, data in plans], [8, 7, 3, 6])
        self.assertNotIn("custom", [row["id"] for row, _ in plans])
        self.assertTrue(all(row["data"]["reference_answer"] == "手动编辑过的旧答案" for row, _ in plans))

    def test_current_data_does_not_need_overwrite(self):
        self.assertEqual(plan_overwrite(self.items, self.rows), [])

    def test_missing_or_duplicate_question_aborts(self):
        summary = next(row for row in self.rows if row["data"].get("type") == "汇总")
        for rows in ([row for row in self.rows if row is not summary], self.rows + [summary]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                plan_overwrite(self.items, rows)


if __name__ == "__main__":
    unittest.main()
