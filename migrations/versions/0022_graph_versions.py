"""图谱版本：每次写入图谱存成一个版本，手动选择生效的版本

Revision ID: 0022
Revises: 0021
"""

from alembic import op
import sqlalchemy as sa


revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


# 升级：新建 graph_versions。已有的建图各自记为第一个版本（版本 id 就是建图 id，名字和关系不用改），
# 生效与否沿用建图记录的 active。
def upgrade():
    op.create_table(
        "graph_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("build_id", sa.String(36), nullable=False),
        sa.Column("space", sa.String(64), nullable=False),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("doc_key", sa.String(36), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("summary", sa.JSON()),
        sa.Column("note", sa.String(500)),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created", sa.String(40), nullable=False),
    )
    op.create_index("ix_graph_versions_document", "graph_versions", ["document_id"])
    op.create_index("ix_graph_versions_doc_key", "graph_versions", ["space", "doc_key"])
    op.create_index("ix_graph_versions_build", "graph_versions", ["build_id"])

    connection = op.get_bind()
    builds = (
        connection.execute(
            sa.text(
                "SELECT id, space, document_id, doc_key, active, entity_count, relation_count, "
                "created_by, created, finished FROM graph_builds "
                "WHERE id IN (SELECT DISTINCT build_id FROM graph_mentions) ORDER BY created"
            )
        )
        .mappings()
        .all()
    )
    versions = sa.table(
        "graph_versions",
        sa.column("id", sa.String),
        sa.column("build_id", sa.String),
        sa.column("space", sa.String),
        sa.column("document_id", sa.String),
        sa.column("doc_key", sa.String),
        sa.column("number", sa.Integer),
        sa.column("active", sa.Boolean),
        sa.column("origin", sa.String),
        sa.column("summary", sa.JSON),
        sa.column("created_by", sa.String),
        sa.column("created", sa.String),
    )
    numbers = {}
    rows = []
    for build in builds:
        numbers[build["document_id"]] = numbers.get(build["document_id"], 0) + 1
        rows.append(
            {
                "id": build["id"],
                "build_id": build["id"],
                "space": build["space"],
                "document_id": build["document_id"],
                "doc_key": build["doc_key"],
                "number": numbers[build["document_id"]],
                "active": bool(build["active"]),
                "origin": "build",
                "summary": {
                    "entity_count": build["entity_count"],
                    "relation_count": build["relation_count"],
                },
                "created_by": build["created_by"],
                "created": build["finished"] or build["created"],
            }
        )
    if rows:
        op.bulk_insert(versions, rows)


def downgrade():
    op.drop_index("ix_graph_versions_build", table_name="graph_versions")
    op.drop_index("ix_graph_versions_doc_key", table_name="graph_versions")
    op.drop_index("ix_graph_versions_document", table_name="graph_versions")
    op.drop_table("graph_versions")
