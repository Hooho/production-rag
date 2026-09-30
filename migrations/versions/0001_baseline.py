"""基线：接入 Alembic 之前的全部表结构

Revision ID: 0001
Revises:
"""
from alembic import op
from sqlalchemy import Boolean, Column, Float, JSON, Integer, MetaData, String, Table, Text, UniqueConstraint, inspect, select


revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


# 接入 Alembic 时 app/mysql/store.py 中表结构的快照。
# 迁移里不能直接 import 应用的 metadata：以后 store.py 加了列，这个旧迁移建出的表也会跟着变，
# 后面负责加列的迁移再执行就会报"列已存在"。所以每个迁移只描述自己那一刻的结构。
metadata = MetaData()
sessions = Table("sessions", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False),
)
runs = Table("runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", String(36), nullable=False, index=True),
    Column("owner", String(32), nullable=False),
    Column("question", Text, nullable=False),
    Column("response", JSON, nullable=False),
    Column("created", String(32), nullable=False),
    Column("route", String(20)),
    Column("refused", Boolean),
    Column("duration_ms", Integer),
    Column("top_score", Float),
    Column("trace", JSON),
)
run_errors = Table("run_errors", metadata,
    Column("id", String(36), primary_key=True),
    Column("request_id", String(36), nullable=False, index=True),
    Column("session_id", String(36), nullable=False),
    Column("owner", String(32), nullable=False, index=True),
    Column("question", Text, nullable=False),
    Column("status_code", Integer, nullable=False),
    Column("error", String(500), nullable=False),
    Column("last_step", String(32)),
    Column("steps", JSON),
    Column("duration_ms", Integer),
    Column("created", String(32), nullable=False),
)
feedback = Table("feedback", metadata,
    Column("run_id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("session_id", String(36), nullable=False),
    Column("rating", Integer, nullable=False),
    Column("reason", String(20)),
    Column("comment", Text),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)
orders = Table("orders", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner", String(32), nullable=False),
    Column("status", String(100), nullable=False),
    Column("arrival", String(100), nullable=False),
)
documents = Table("documents", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("filename", String(255), nullable=False),
    Column("path", String(500), nullable=False),
    Column("status", String(32), nullable=False),
    Column("error", Text),
    Column("document_metadata", JSON),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
    Column("doc_key", String(36), index=True),
    Column("version", Integer),
    Column("version_note", String(500)),
    Column("content_sha256", String(64), index=True),
    UniqueConstraint("doc_key", "version", name="uq_documents_doc_key_version"),
)
document_heads = Table("document_heads", metadata,
    Column("doc_key", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("current_document_id", String(36), nullable=False),
    Column("current_version", Integer, nullable=False),
    Column("updated", String(32), nullable=False),
)
chunks = Table("chunks", metadata,
    Column("id", String(64), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("text", Text, nullable=False),
    Column("content", Text),
    Column("chunk_key", String(64), index=True),
)
document_steps = Table("document_steps", metadata,
    Column("document_id", String(36), primary_key=True),
    Column("step_id", String(32), primary_key=True),
    Column("step_order", Integer, nullable=False),
    Column("stage", String(32), nullable=False),
    Column("title", String(100), nullable=False),
    Column("status", String(20), nullable=False),
    Column("detail", String(500), nullable=False),
    Column("result", JSON),
    Column("duration_ms", Integer),
    Column("updated", String(32), nullable=False),
)
document_chunks = Table("document_chunks", metadata,
    Column("document_id", String(36), primary_key=True),
    Column("chunk_id", String(64), primary_key=True),
    Column("position", Integer),
    Column("chunk_metadata", JSON),
)
settings = Table("settings", metadata,
    Column("key", String(64), primary_key=True),
    Column("value", JSON, nullable=False),
    Column("updated", String(32), nullable=False),
)

# 接入 Alembic 之前，已有数据库靠启动时的 ensure_* 函数陆续补上的列。
# 旧库可能停在其中任何一步，这里逐个检查、缺哪个补哪个。
added_columns = (
    ("document_chunks", "position", "INTEGER"),
    ("documents", "document_metadata", "JSON"),
    ("chunks", "content", "TEXT"),
    ("document_chunks", "chunk_metadata", "JSON"),
    ("documents", "doc_key", "VARCHAR(36)"),
    ("documents", "version", "INTEGER"),
    ("documents", "version_note", "VARCHAR(500)"),
    ("documents", "content_sha256", "VARCHAR(64)"),
    ("chunks", "chunk_key", "VARCHAR(64)"),
    ("runs", "route", "VARCHAR(20)"),
    ("runs", "refused", "BOOLEAN"),
    ("runs", "duration_ms", "INTEGER"),
    ("runs", "top_score", "FLOAT"),
    ("runs", "trace", "JSON"),
)


# 新库：直接建出全部表。旧库（接入 Alembic 前由 create_all 建的库）：补齐缺少的列、索引和版本数据。
# 这样新旧两种库都只需执行 alembic upgrade head，不用人工判断该建表还是该 stamp。
def upgrade():
    bind = op.get_bind()
    # 只创建不存在的表，已有的表保持原样，由下面的步骤补齐。
    metadata.create_all(bind, checkfirst=True)

    for table_name, column_name, column_type in added_columns:
        columns = set()
        for column in inspect(bind).get_columns(table_name):
            columns.add(column["name"])
        if column_name not in columns:
            op.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")

    # 旧的 ensure_* 只补列、不补 index=True 声明的索引（如 documents.doc_key、chunks.chunk_key），
    # 旧库上这些查询一直在全表扫描。这里按快照把缺少的索引补上。
    for table in metadata.sorted_tables:
        index_names = set()
        for index in inspect(bind).get_indexes(table.name):
            index_names.add(index["name"])
        for index in table.indexes:
            if index.name not in index_names:
                index.create(bind)

    # 已有安装的 documents 表由 create_all 跳过，唯一约束需要单独补建。
    index_names = set()
    for index in inspect(bind).get_indexes("documents"):
        index_names.add(index["name"])
    for constraint in inspect(bind).get_unique_constraints("documents"):
        index_names.add(constraint["name"])
    if "uq_documents_doc_key_version" not in index_names:
        op.execute("CREATE UNIQUE INDEX uq_documents_doc_key_version ON documents (doc_key, version)")

    # 升级前的文档没有版本信息：每份各自成为一份逻辑文档的第 1 版，处理成功的写入 document_heads。
    documents = metadata.tables["documents"]
    document_heads = metadata.tables["document_heads"]
    rows = bind.execute(select(documents).where(documents.c.doc_key.is_(None))).mappings().all()
    for row in rows:
        document_metadata = row["document_metadata"] or {}
        bind.execute(documents.update().where(documents.c.id == row["id"]).values(
            doc_key=row["id"], version=1, content_sha256=document_metadata.get("sha256")))
        if not row["status"].startswith("ready"):
            continue
        bind.execute(document_heads.insert().values(doc_key=row["id"], owner=row["owner"],
            title=row["title"], current_document_id=row["id"], current_version=1,
            updated=row["updated"]))


# 回到接入 Alembic 之前的空库：删除全部表和数据，只用于开发环境重来。
def downgrade():
    metadata.drop_all(op.get_bind())
