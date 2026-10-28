import copy
import unittest

from app.evaluation.presentation import normalize_report


class EvaluationPresentationTest(unittest.TestCase):
    def test_legacy_report_uses_only_saved_evidence_and_preserves_scores(self):
        question = {
            "question": "旧题",
            "given_recall": 0.5,
            "score": 45,
            "evidence": [{"text": "旧原文", "chunk_id": "old:3", "given": False}],
            "sources": [{"chunk_id": "old:3", "position": 3, "title": "旧书"}],
            "agent": {
                "recall": 1,
                "evidence": [
                    {
                        "text": "旧原文",
                        "chunk_ids": ["old:3", "old:8"],
                        "positions": [3, 8],
                        "found": True,
                    }
                ],
            },
        }
        run = {"questions": [question], "summary": {"score": 45}}
        before = copy.deepcopy(run)
        result = normalize_report(run)
        fixed = result["questions"][0]["evidence"][0]
        agent = result["questions"][0]["agent"]["evidence"][0]
        self.assertEqual(fixed["label"], "要点 1")
        self.assertEqual(
            [target["chunk_id"] for target in fixed["targets"]], ["old:3", "old:8"]
        )
        self.assertEqual([target["position"] for target in fixed["targets"]], [3, 8])
        self.assertEqual(agent["targets"], fixed["targets"])
        self.assertFalse(fixed["given"])
        self.assertTrue(agent["found"])
        self.assertEqual(result["questions"][0]["score"], 45)
        self.assertEqual(result["summary"], before["summary"])
        self.assertEqual(run, before)

    def test_new_metadata_is_preserved_and_normalization_is_idempotent(self):
        target = {"chunk_id": "id", "position": 2, "title": "书", "quote": "原文"}
        run = {
            "sections": [
                {
                    "questions": [
                        {
                            "fixed_evidence": [
                                {"label": "公司甲", "text": "原文", "targets": [target]}
                            ],
                            "agent": {
                                "evidence": [
                                    {"text": "原文", "chunk_ids": ["id"], "found": True}
                                ]
                            },
                        }
                    ]
                }
            ]
        }
        result = normalize_report(run)
        question = result["sections"][0]["questions"][0]
        self.assertEqual(question["fixed_evidence"][0]["targets"], [target])
        self.assertEqual(question["agent"]["evidence"][0]["label"], "公司甲")
        self.assertEqual(normalize_report(result), result)

    def test_missing_chunk_identity_or_position_is_not_invented(self):
        run = {
            "questions": [
                {
                    "evidence": [
                        {"text": "找不到来源"},
                        {"text": "只有编号", "chunk_id": "opaque-id"},
                    ]
                }
            ]
        }
        evidence = normalize_report(run)["questions"][0]["evidence"]
        self.assertEqual(evidence[0]["targets"], [])
        self.assertIsNone(evidence[1]["targets"][0]["position"])
        self.assertEqual(evidence[1]["targets"][0]["chunk_id"], "opaque-id")


if __name__ == "__main__":
    unittest.main()
