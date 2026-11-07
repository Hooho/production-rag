from app.evaluation.dataset import normalize
from app.ingestion.chunking import chunk_document_records, normalize_text
from app.textnorm import fold_radicals, fold_sections


# PDF 里的部首字换回汉字：康熙部首区（⾃⼰）和部首补充区（⻛ ⻓）都换；中文全角标点不动。
def test_fold_radicals():
    assert fold_radicals("⾃⼰的投资⻛格，⻓期持有。") == "自己的投资风格，长期持有。"
    assert fold_radicals("ＡＢＣ，１２３") == "ＡＢＣ，１２３"
    assert fold_radicals("") == "" and fold_radicals(None) is None


def test_parsed_sections_and_text_are_folded():
    sections = fold_sections(
        [
            {
                "heading_path": ["⼀、⻛险"],
                "text": "⼈⼤",
                "parts": [{"text": "⼈⼤", "page_number": 1}],
            }
        ]
    )
    assert sections[0]["heading_path"] == ["一、风险"]
    assert sections[0]["text"] == "人大"
    assert sections[0]["parts"][0] == {"text": "人大", "page_number": 1}
    assert normalize_text("⾃⼰\r\n⻛险") == "自己\n风险"
    records = chunk_document_records("⾃⼰的⻛险", chunk_size=800, chunk_overlap=0)
    assert "自己的风险" in records[0]["content"]


# 评测证据：旧题里复制的原文带部首字，导入后的新分片是正常汉字，比对时也要对得上。
def test_evaluation_evidence_matches_after_folding():
    assert normalize("⻓期⻛险") == normalize("长期风险")
