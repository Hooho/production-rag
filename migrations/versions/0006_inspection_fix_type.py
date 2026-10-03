"""知识巡检：问题标记"已处理"时记录修复方式

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa


revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


# 升级：问题表新增 fix_type 列。之前已经标记已处理的问题为空，页面显示"未注明"。
def upgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.add_column(sa.Column('fix_type', sa.String(length=32), nullable=True))


# 回退：删除 fix_type 列。
def downgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.drop_column('fix_type')
