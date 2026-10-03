"""评测题目存数据库：调参评测集和专项评测集

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa


revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


# 升级：新建调参题、专项、专项题三张表。题目在 API 首次启动时从 eval/seed 导入，迁移只建表。
def upgrade():
    op.create_table('eval_items',
        sa.Column('id', sa.String(length=16), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_table('eval_suites',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('description', sa.String(length=500), nullable=True),
        sa.Column('method', sa.String(length=16), nullable=False),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'))
    op.create_table('eval_suite_items',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('suite_id', sa.String(length=36), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_eval_suite_items_suite_id'), 'eval_suite_items', ['suite_id'], unique=False)


# 回退：删除这三张表（题目会丢失，回退前先在页面上导出）。
def downgrade():
    op.drop_index(op.f('ix_eval_suite_items_suite_id'), table_name='eval_suite_items')
    op.drop_table('eval_suite_items')
    op.drop_table('eval_suites')
    op.drop_table('eval_items')
