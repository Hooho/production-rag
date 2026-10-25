"""评测语料库

Revision ID: 0019
Revises: 0018
"""
from alembic import op
import sqlalchemy as sa


revision = '0019'
down_revision = '0018'
branch_labels = None
depends_on = None


# 升级：新建 eval_corpus。评测语料从"仓库 eval/corpus 目录"改成评测页上传维护，评测开跑时可以勾选用哪几份。
def upgrade():
    op.create_table('eval_corpus',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('filename', sa.String(length=255), nullable=False),
        sa.Column('path', sa.String(length=500), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('char_count', sa.Integer(), nullable=False),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=40), nullable=False),
        sa.Column('updated', sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('title'))


# 回退：删除语料库表（上传目录里的文件不删）。
def downgrade():
    op.drop_table('eval_corpus')
