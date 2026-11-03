"""知识图谱（第 1 期）

Revision ID: 0020
Revises: 0019
"""

from alembic import op
import sqlalchemy as sa


revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


TABLES = [
    "graph_aliases",
    "graph_merges",
    "graph_relations",
    "graph_mentions",
    "graph_entities",
    "graph_chunk_extractions",
    "graph_builds",
    "graph_schemas",
]


# 升级：新建知识图谱的 8 张表，只新增、不改已有的表。内置的默认清单由代码第一次用到时写入（app/graph/schemas.py）。
def upgrade():
    op.create_table(
        "graph_schemas",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("entity_types", sa.JSON(), nullable=False),
        sa.Column("relation_categories", sa.JSON(), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=False),
        sa.Column("created_by", sa.String(length=32), nullable=False),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "graph_builds",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("space", sa.String(length=64), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("doc_key", sa.String(length=36), nullable=False),
        sa.Column("schema_id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("prompt_tag", sa.String(length=64), nullable=False),
        sa.Column("prompt_identity", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("trigger_kind", sa.String(length=16), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("extracted", sa.Integer(), nullable=False),
        sa.Column("reused", sa.Integer(), nullable=False),
        sa.Column("failed", sa.Integer(), nullable=False),
        sa.Column("entity_count", sa.Integer(), nullable=False),
        sa.Column("relation_count", sa.Integer(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=32), nullable=False),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.Column("updated", sa.String(length=40), nullable=False),
        sa.Column("finished", sa.String(length=40), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_graph_builds_doc_key", "graph_builds", ["space", "doc_key"])
    op.create_index("ix_graph_builds_document", "graph_builds", ["document_id"])
    op.create_table(
        "graph_chunk_extractions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("build_id", sa.String(length=36), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("chunk_id", sa.String(length=64), nullable=False),
        sa.Column("chunk_key", sa.String(length=64), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reused_from", sa.String(length=36), nullable=True),
        sa.Column("prompt", sa.JSON(), nullable=True),
        sa.Column("raw_output", sa.Text(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_graph_extractions_build",
        "graph_chunk_extractions",
        ["build_id", "position"],
    )
    op.create_index(
        "ix_graph_extractions_cache", "graph_chunk_extractions", ["cache_key"]
    )
    op.create_index(
        "ix_graph_extractions_chunk", "graph_chunk_extractions", ["chunk_id"]
    )
    op.create_table(
        "graph_entities",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("space", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("merge_key", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.Column("updated", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("space", "merge_key", name="uq_graph_entities_space_key"),
    )
    op.create_table(
        "graph_mentions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("build_id", sa.String(length=36), nullable=False),
        sa.Column("extraction_id", sa.String(length=36), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("chunk_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("canonical", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("resolve_method", sa.String(length=16), nullable=False),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_graph_mentions_build", "graph_mentions", ["build_id"])
    op.create_index("ix_graph_mentions_chunk", "graph_mentions", ["chunk_id"])
    op.create_index("ix_graph_mentions_entity", "graph_mentions", ["entity_id"])
    op.create_table(
        "graph_relations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("build_id", sa.String(length=36), nullable=False),
        sa.Column("extraction_id", sa.String(length=36), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("chunk_id", sa.String(length=64), nullable=False),
        sa.Column("source_mention_id", sa.String(length=36), nullable=False),
        sa.Column("target_mention_id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_graph_relations_build", "graph_relations", ["build_id"])
    op.create_index(
        "ix_graph_relations_source", "graph_relations", ["source_mention_id"]
    )
    op.create_index(
        "ix_graph_relations_target", "graph_relations", ["target_mention_id"]
    )
    op.create_table(
        "graph_merges",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("space", sa.String(length=64), nullable=False),
        sa.Column("build_id", sa.String(length=36), nullable=True),
        sa.Column("mention_id", sa.String(length=36), nullable=True),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.String(length=32), nullable=False),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_graph_merges_build", "graph_merges", ["build_id"])
    op.create_index("ix_graph_merges_entity", "graph_merges", ["entity_id"])
    op.create_table(
        "graph_aliases",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("space", sa.String(length=64), nullable=False),
        sa.Column("alias", sa.String(length=200), nullable=False),
        sa.Column("alias_key", sa.String(length=255), nullable=False),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.String(length=32), nullable=False),
        sa.Column("created", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("space", "alias_key", name="uq_graph_aliases_space_key"),
    )


# 回退：删除知识图谱的全部表，文档、分片和检索不受影响。
def downgrade():
    for name in TABLES:
        op.drop_table(name)
