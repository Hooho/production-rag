"""固定建图输入配置快照。"""

from alembic import op
import sqlalchemy as sa

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "graph_build_inputs",
        sa.Column("build_id", sa.String(36), primary_key=True),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("schema_snapshot", sa.JSON(), nullable=False),
    )


def downgrade():
    op.drop_table("graph_build_inputs")
