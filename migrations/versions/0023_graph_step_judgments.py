"""图谱检查的 AI 判断逐项存表，不再整份塞在 document_steps.result 里

Revision ID: 0023
Revises: 0022
"""

from alembic import op
import sqlalchemy as sa


revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


# 只建表，不搬旧数据：旧报告里的 judgments 读的时候照常返回，下一次保存报告时自动拆到新表。
def upgrade():
    op.create_table(
        "graph_step_judgments",
        sa.Column("document_id", sa.String(36), primary_key=True),
        sa.Column("step_id", sa.String(32), primary_key=True),
        sa.Column("item_id", sa.String(128), primary_key=True),
        sa.Column("build_id", sa.String(36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("trace", sa.JSON()),
        sa.Column("updated", sa.String(40), nullable=False),
    )


def downgrade():
    op.drop_table("graph_step_judgments")
