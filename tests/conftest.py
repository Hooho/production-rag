import pytest

from app import runtime_config


# 设置页参数在测试里的取值：以前用 monkeypatch.setenv 设 .env，现在这些参数只从设置页（数据库）读，
# 测试改成直接覆盖读到的「设置页的值」。runtime(rerank_min_score=0.3) 之后读到的就是 0.3。
@pytest.fixture
def runtime(monkeypatch):
    values = {}
    original = runtime_config.saved_values
    monkeypatch.setattr(runtime_config, "saved_values", lambda: {**original(), **values})

    def set_values(**changes):
        values.update(changes)
    return set_values
