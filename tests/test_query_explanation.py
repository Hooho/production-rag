import unittest

from app.agentic.query_explanation import query_explanation, retrieval_arguments


class QueryExplanationTest(unittest.TestCase):
    def test_recorded_reason_is_separate_from_execution(self):
        explanation = {"purpose": "核实乐视是否是书中的反面案例", "basis": ["hypothesis"],
            "references": [], "assumptions": ["书中可能提到乐视，尚未确认"]}
        arguments = {"query": "书中如何评价乐视？", "mode": "hybrid", "query_explanation": explanation}
        self.assertEqual(query_explanation(arguments), explanation)
        self.assertEqual(retrieval_arguments("search_knowledge", arguments), {"query": "书中如何评价乐视？", "mode": "hybrid"})
        changed = {**arguments, "query_explanation": {**explanation, "purpose": "另一种说明"}}
        self.assertEqual(retrieval_arguments("search_knowledge", arguments), retrieval_arguments("search_knowledge", changed))
        self.assertIn("query_explanation", arguments)
        self.assertIsNone(query_explanation({"query": "旧记录"}))

    def test_required_support_and_types(self):
        base = {"purpose": "查询原因", "basis": ["previous_results"], "references": [], "assumptions": []}
        with self.assertRaises(ValueError):
            query_explanation({"query_explanation": base})
        valid = {**base, "references": [{"source_id": "S1", "quote": "书中提到了这家公司"}]}
        self.assertEqual(query_explanation({"query_explanation": valid}), valid)
        for change in [{"basis": ["hypothesis"]}, {"purpose": " "}, {"references": ["S1"]}, {"basis": ["unknown"]}, {"assumptions": "猜测"}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                query_explanation({"query_explanation": {**valid, **change}})

    def test_context_read_keeps_functional_parameters(self):
        arguments = {"source_id": "S1", "direction": "after", "query_explanation": {"purpose": "读取后文"}}
        self.assertEqual(retrieval_arguments("read_context", arguments), {"source_id": "S1", "direction": "after"})
        self.assertEqual(retrieval_arguments("lookup_order", arguments), arguments)


if __name__ == "__main__":
    unittest.main()
