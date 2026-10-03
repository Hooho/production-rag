"""知识巡检：问题标记"无需处理"时记录原因

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


# 升级：问题表新增 close_reason 列。之前已经忽略的问题原因为空，页面显示"未注明"。
def upgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.add_column(sa.Column('close_reason', sa.String(length=32), nullable=True))
        batch.create_index(batch.f('ix_inspection_issues_close_reason'), ['close_reason'], unique=False)


# 回退：删除 close_reason 列。
def downgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.drop_index(batch.f('ix_inspection_issues_close_reason'))
        batch.drop_column('close_reason')
