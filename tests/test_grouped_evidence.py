import copy
import json
import unittest
from pathlib import Path

from app.evaluation.grouped_evidence import bind_groups, fingerprint, match_evidence


class GroupedEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.catalog = [
            {"title": "书", "position": 0, "content": "公司甲经营失败", "chunk_id": "new:0"},
            {"title": "书", "position": 1, "content": "公司甲的另一处案例", "chunk_id": "new:1"},
        ]
        self.groups = [{"label": "公司甲", "targets": [
            {"title": row["title"], "position": row["position"], "fingerprint": fingerprint(row["content"]),
                "quote": row["content"]} for row in self.catalog]}]

    def test_targets_score_without_reading_excerpt(self):
        groups = copy.deepcopy(self.groups)
        groups[0]["targets"][0]["quote"] = "修改展示摘录不改变命中"
        evidence = bind_groups(["修改旧展示文字"], groups, self.catalog)
        candidates = [{"chunk_id": key} for key in ("new:0", "new:1", "other")]
        hits = match_evidence(candidates, evidence, {"other": "修改旧展示文字"}, lambda s: [s])
        self.assertEqual(hits, {"new:0": [0], "new:1": [0]})
        self.assertEqual({index for values in hits.values() for index in values}, {0})
        self.assertEqual(evidence[0]["targets"][0]["quote"], "修改展示摘录不改变命中")

    def test_changed_or_missing_chunk_requires_reannotation(self):
        changed = copy.deepcopy(self.catalog)
        changed[0]["content"] = "不同的分片"
        for catalog in (changed, self.catalog[1:]):
            with self.subTest(catalog=catalog), self.assertRaisesRegex(ValueError, "重新标注"):
                bind_groups(["摘录"], self.groups, catalog)

    def test_legacy_matching_and_current_chunk_ids(self):
        self.assertEqual(bind_groups(["旧证据"], None, []), ["旧证据"])
        hits = match_evidence([{"chunk_id": "a"}], ["原文||替代"], {"a": "包含替代"}, lambda s: s.split("||"))
        self.assertEqual(hits, {"a": [0]})
        rebound = [{**row, "chunk_id": f"next:{row['position']}"} for row in self.catalog]
        self.assertEqual(bind_groups(["摘录"], self.groups, rebound)[0]["targets"][0]["chunk_id"], "next:0")

    def test_seed_question_names_and_item_counts(self):
        data = json.loads((Path(__file__).parents[1] / "eval/seed/suites.json").read_text())
        suite = next(s for s in data["suites"] if s["name"] == "Agent 区分题")
        items = [item for item in suite["items"] if item.get("type") == "汇总"]
        self.assertEqual([len(item["evidence_groups"]) for item in items], [8, 5, 3, 3])
        for item in items:
            self.assertEqual(len(item["evidence"]), len(item["evidence_groups"]))
            for group in item["evidence_groups"]:
                self.assertTrue(group["label"])
                self.assertTrue(group["targets"])


if __name__ == "__main__":
    unittest.main()
