from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from app.mysql.store import metadata


ROOT = Path(__file__).resolve().parents[1]
# 0001 之后的迁移新建的表。
NEW_TABLES = {"users", "user_groups", "user_group_members", "refresh_tokens", "document_permissions", "document_shares",
    "products", "customers", "inventory", "shipments", "after_sales", "promotions", "reviews",
    "data_permissions", "data_audit", "inspection_runs", "inspection_issues", "inspection_issue_events",
    "eval_sets", "eval_set_items", "eval_set_runs", "eval_items", "eval_suites", "eval_suite_items", "eval_runs", "prompt_versions",
    "document_reviews"}


# 指向临时 SQLite 库的 Alembic 配置。
def alembic_config(url):
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    return config


# 返回迁移后的库与 store.py 表定义的差异，空列表表示一致。
def schema_diff(engine):
    with engine.connect() as connection:
        return compare_metadata(MigrationContext.configure(connection), metadata)


# 空库执行 upgrade head 后，结构必须和 store.py 完全一致。
# 如果以后改了 store.py 却忘了写迁移，这个测试会失败并列出差异。
def test_upgrade_empty_database_matches_models(tmp_path):
    url = f"sqlite:///{tmp_path / 'rag.db'}"
    config = alembic_config(url)
    command.upgrade(config, "head")
    engine = create_engine(url)
    assert schema_diff(engine) == []
    head = ScriptDirectory.from_config(config).get_current_head()
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar() == head
    engine.dispose()


# 接入 Alembic 前的旧库：缺列、缺索引、文档没有版本信息，upgrade 后应全部补齐，且重复执行不出错。
def test_upgrade_old_database_fills_missing_parts(tmp_path):
    url = f"sqlite:///{tmp_path / 'rag.db'}"
    engine = create_engine(url)
    # 只建接入 Alembic 之前就有的表；用户、权限等表由后面的迁移创建。
    old_tables = []
    for table in metadata.sorted_tables:
        if table.name not in NEW_TABLES:
            old_tables.append(table)
    metadata.create_all(engine, tables=old_tables)
    with engine.begin() as connection:
        # 模拟早期版本的 documents 表：还没有 doc_key、version 等列和相关索引。
        connection.execute(text("DROP TABLE documents"))
        connection.execute(text("CREATE TABLE documents (id VARCHAR(36) PRIMARY KEY, owner VARCHAR(32) NOT NULL, "
            "title VARCHAR(200) NOT NULL, filename VARCHAR(255) NOT NULL, path VARCHAR(500) NOT NULL, "
            "status VARCHAR(32) NOT NULL, error TEXT, document_metadata JSON, "
            "created VARCHAR(32) NOT NULL, updated VARCHAR(32) NOT NULL)"))
        connection.execute(text("INSERT INTO documents VALUES ('d1', 'alice', '手册', 'a.txt', '', 'ready:3', "
            "NULL, '{\"sha256\": \"abc\"}', '2026-01-01', '2026-01-01'), "
            "('d2', 'alice', '草稿', 'b.txt', '', 'failed', NULL, NULL, '2026-01-01', '2026-01-01')"))

    command.upgrade(alembic_config(url), "head")
    command.upgrade(alembic_config(url), "head")

    columns = set()
    for column in inspect(engine).get_columns("documents"):
        columns.add(column["name"])
    assert {"doc_key", "version", "content_sha256", "document_metadata"} <= columns
    index_names = set()
    for index in inspect(engine).get_indexes("documents"):
        index_names.add(index["name"])
    assert {"ix_documents_owner", "ix_documents_doc_key", "uq_documents_doc_key_version"} <= index_names
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT id, doc_key, version, content_sha256 FROM documents ORDER BY id")).all()
        heads = connection.execute(text("SELECT doc_key, current_document_id FROM document_heads")).all()
    # 每份旧文档成为自己的第 1 版，内容哈希从 document_metadata 里取出。
    assert [tuple(row) for row in rows] == [("d1", "d1", 1, "abc"), ("d2", "d2", 1, None)]
    # 只有处理成功的版本才能成为当前版本。
    assert [tuple(row) for row in heads] == [("d1", "d1")]
    engine.dispose()


# downgrade 回到空库，再 upgrade 能重新建出完整结构。
def test_downgrade_and_upgrade_again(tmp_path):
    url = f"sqlite:///{tmp_path / 'rag.db'}"
    config = alembic_config(url)
    command.upgrade(config, "head")
    command.downgrade(config, "base")
    engine = create_engine(url)
    assert inspect(engine).get_table_names() == ["alembic_version"]
    command.upgrade(config, "head")
    assert schema_diff(engine) == []
    engine.dispose()
