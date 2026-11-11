import math

import pytest

from app.models import Models, RerankError


@pytest.mark.parametrize("count", [33, 50, 100])
def test_rerank_batches_respect_service_limit_and_preserve_order(monkeypatch, count):
    monkeypatch.setenv("MODEL_MODE", "demo")
    monkeypatch.setenv("EMBEDDING_MODE", "local")
    monkeypatch.setattr(
        "app.models.runtime_value",
        lambda key: {"rerank_enabled": True, "rerank_timeout": 60}[key],
    )
    model = Models()
    calls = []

    def request(url, path, payload, timeout):
        batch = payload["documents"]
        assert 1 <= len(batch) <= 32
        assert payload["query"] == "段永平投资哪些公司"
        calls.append(batch)
        # 服务可能按分数排序返回；必须根据批内 index 还原到原始顺序。
        return {
            "data": [
                {"index": i, "score": float(batch[i]) / 10}
                for i in reversed(range(len(batch)))
            ]
        }

    monkeypatch.setattr(model, "call_url", request)
    scores = model.rerank("段永平投资哪些公司", [str(i) for i in range(count)])
    assert len(calls) == math.ceil(count / 32)
    assert len(scores) == count
    assert scores == sorted(scores)
    for i, score in enumerate(scores):
        assert score == pytest.approx(1 / (1 + math.exp(-i / 10)))


def test_rerank_missing_batch_score_is_not_silently_zero(monkeypatch):
    monkeypatch.setenv("MODEL_MODE", "demo")
    monkeypatch.setenv("EMBEDDING_MODE", "local")
    monkeypatch.setattr(
        "app.models.runtime_value",
        lambda key: {"rerank_enabled": True, "rerank_timeout": 60}[key],
    )
    model = Models()
    monkeypatch.setattr(
        model, "call_url", lambda *args, **kwargs: {"data": [{"index": 0, "score": 1}]}
    )
    with pytest.raises(RerankError, match="缺少候选分数"):
        model.rerank("问题", ["a", "b"])
