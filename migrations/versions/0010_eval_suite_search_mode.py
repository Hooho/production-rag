"""专项评测集：检索方式（混合 / 只用向量 / 只用关键词）

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa


revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


# 升级：新增 search_mode 列，已有专项为空，按混合检索处理。
def upgrade():
    with op.batch_alter_table('eval_suites') as batch:
        batch.add_column(sa.Column('search_mode', sa.String(length=16), nullable=True))


# 回退：删除 search_mode 列。
def downgrade():
    with op.batch_alter_table('eval_suites') as batch:
        batch.drop_column('search_mode')
