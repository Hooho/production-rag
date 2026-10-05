"""提示词版本

Revision ID: 0012
Revises: 0011
"""
from alembic import op
import sqlalchemy as sa


revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


# 升级：新建提示词版本表。没有保存过任何版本时，所有提示词都用代码里的内置版本。
def upgrade():
    op.create_table('prompt_versions',
        sa.Column('prompt_id', sa.String(length=32), nullable=False),
        sa.Column('version', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('note', sa.String(length=200), nullable=False),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint('prompt_id', 'version'))


# 回退：删除提示词版本表，所有提示词回到内置版本（settings 表里的 prompts 记录留着也不影响）。
def downgrade():
    op.drop_table('prompt_versions')
