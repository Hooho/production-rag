import pytest

from app import runtime_config


# 上传目录（文档、评测语料库的文件）放到每个测试自己的临时目录，不写进仓库的 ./uploads。
@pytest.fixture(autouse=True)
def upload_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    return tmp_path / "uploads"


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
