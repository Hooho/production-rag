"""Agent 模式执行记录

Revision ID: 0016
Revises: 0015
"""
from alembic import op
import sqlalchemy as sa


revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


# 升级：新建 Agent 模式的执行记录表。固定流程的 runs 表不变。
def upgrade():
    op.create_table('agent_runs',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('session_id', sa.String(length=36), nullable=False),
        sa.Column('owner', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('stop_reason', sa.String(length=16), nullable=True),
        sa.Column('rounds', sa.Integer(), nullable=False),
        sa.Column('tool_calls', sa.Integer(), nullable=False),
        sa.Column('tool_budget', sa.Integer(), nullable=False),
        sa.Column('citation_retried', sa.Boolean(), nullable=False),
        sa.Column('citation_passed', sa.Boolean(), nullable=True),
        sa.Column('prompt_tokens', sa.Integer(), nullable=False),
        sa.Column('completion_tokens', sa.Integer(), nullable=False),
        sa.Column('cached_tokens', sa.Integer(), nullable=False),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('model', sa.String(length=100), nullable=True),
        sa.Column('prompt_version', sa.String(length=40), nullable=True),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_index('ix_agent_runs_owner_created', 'agent_runs', ['owner', 'created'])
    op.create_table('agent_rounds',
        sa.Column('run_id', sa.String(length=36), nullable=False),
        sa.Column('round', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('record', sa.JSON(), nullable=False),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint('run_id', 'round'))


# 回退：删除两张表。Agent 模式的问答在 runs 里的记录（答案、步骤）保留，只是看不到每一轮的细节。
def downgrade():
    op.drop_table('agent_rounds')
    op.drop_index('ix_agent_runs_owner_created', table_name='agent_runs')
    op.drop_table('agent_runs')
