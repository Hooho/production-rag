"""评测记录存数据库

Revision ID: 0011
Revises: 0010
"""
from alembic import op
import sqlalchemy as sa


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


# 升级：新建评测记录表。eval/results 下的旧结果文件在 API 首次启动时导入。
def upgrade():
    op.create_table('eval_runs',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('created', sa.String(length=40), nullable=False),
        sa.Column('brief', sa.JSON(), nullable=False),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('updated', sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint('id'))


# 回退：删除评测记录表（回退前记录会丢失）。
def downgrade():
    op.drop_table('eval_runs')
