"""线上回归集：评测集、题目和运行记录

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


# 升级：新建回归集的三张表，不改动已有的表。
def upgrade():
    op.create_table('eval_sets',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('description', sa.String(length=500), nullable=True),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'))
    op.create_table('eval_set_items',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('set_id', sa.String(length=36), nullable=False),
        sa.Column('question', sa.Text(), nullable=False),
        sa.Column('asker', sa.String(length=32), nullable=False),
        sa.Column('expect', sa.String(length=16), nullable=False),
        sa.Column('documents', sa.JSON(), nullable=True),
        sa.Column('reference_answer', sa.Text(), nullable=True),
        sa.Column('note', sa.String(length=500), nullable=True),
        sa.Column('issue_id', sa.String(length=36), nullable=True),
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_eval_set_items_set_id'), 'eval_set_items', ['set_id'], unique=False)
    op.create_index(op.f('ix_eval_set_items_issue_id'), 'eval_set_items', ['issue_id'], unique=False)
    op.create_table('eval_set_runs',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('set_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('triggered_by', sa.String(length=32), nullable=True),
        sa.Column('summary', sa.JSON(), nullable=True),
        sa.Column('results', sa.JSON(), nullable=True),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('started', sa.String(length=32), nullable=False),
        sa.Column('finished', sa.String(length=32), nullable=True),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_eval_set_runs_set_id'), 'eval_set_runs', ['set_id'], unique=False)


# 回退：删除这三张表。
def downgrade():
    op.drop_index(op.f('ix_eval_set_runs_set_id'), table_name='eval_set_runs')
    op.drop_table('eval_set_runs')
    op.drop_index(op.f('ix_eval_set_items_issue_id'), table_name='eval_set_items')
    op.drop_index(op.f('ix_eval_set_items_set_id'), table_name='eval_set_items')
    op.drop_table('eval_set_items')
    op.drop_table('eval_sets')
