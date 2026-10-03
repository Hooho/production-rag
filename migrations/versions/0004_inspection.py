"""知识巡检：巡检记录、合并后的问题及其关联问答

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa


revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


# 升级：新建巡检的三张表，不改动已有的表。
def upgrade():
    op.create_table('inspection_runs',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('trigger', sa.String(length=16), nullable=False),
        sa.Column('triggered_by', sa.String(length=32), nullable=True),
        sa.Column('since', sa.String(length=32), nullable=False),
        sa.Column('summary', sa.JSON(), nullable=True),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('started', sa.String(length=32), nullable=False),
        sa.Column('finished', sa.String(length=32), nullable=True),
        sa.PrimaryKeyConstraint('id'))
    op.create_table('inspection_issues',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('fingerprint', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('occurrences', sa.Integer(), nullable=False),
        sa.Column('users', sa.Integer(), nullable=False),
        sa.Column('detail', sa.JSON(), nullable=True),
        sa.Column('vector', sa.JSON(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('status_by', sa.String(length=32), nullable=True),
        sa.Column('status_updated', sa.String(length=32), nullable=True),
        sa.Column('first_seen', sa.String(length=32), nullable=False),
        sa.Column('last_seen', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('fingerprint'))
    op.create_index(op.f('ix_inspection_issues_kind'), 'inspection_issues', ['kind'], unique=False)
    op.create_index(op.f('ix_inspection_issues_status'), 'inspection_issues', ['status'], unique=False)
    op.create_table('inspection_issue_events',
        sa.Column('issue_id', sa.String(length=36), nullable=False),
        sa.Column('source', sa.String(length=16), nullable=False),
        sa.Column('source_id', sa.String(length=36), nullable=False),
        sa.Column('owner', sa.String(length=32), nullable=False),
        sa.Column('signals', sa.JSON(), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('issue_id', 'source', 'source_id'))
    op.create_index(op.f('ix_inspection_issue_events_source_id'), 'inspection_issue_events', ['source_id'],
        unique=False)


# 回退：删除巡检的三张表。
def downgrade():
    op.drop_index(op.f('ix_inspection_issue_events_source_id'), table_name='inspection_issue_events')
    op.drop_table('inspection_issue_events')
    op.drop_index(op.f('ix_inspection_issues_status'), table_name='inspection_issues')
    op.drop_index(op.f('ix_inspection_issues_kind'), table_name='inspection_issues')
    op.drop_table('inspection_issues')
    op.drop_table('inspection_runs')
