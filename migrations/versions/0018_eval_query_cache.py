"""评测查询改写缓存

Revision ID: 0018
Revises: 0017
"""
from alembic import op
import sqlalchemy as sa


revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None


# 升级：新建 eval_query_cache。评测固定流程用大模型改写检索词，结果按题目、提示词版本和模型缓存，两次评测可比。
def upgrade():
    op.create_table('eval_query_cache',
        sa.Column('cache_key', sa.String(length=64), nullable=False),
        sa.Column('question', sa.Text(), nullable=False),
        sa.Column('prompt_tag', sa.String(length=64), nullable=False),
        sa.Column('model', sa.String(length=128), nullable=False),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('duration_ms', sa.Integer(), nullable=False),
        sa.Column('created', sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint('cache_key'))


# 回退：删除缓存表。下次评测重新改写。
def downgrade():
    op.drop_table('eval_query_cache')
