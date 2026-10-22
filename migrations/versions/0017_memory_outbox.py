"""会话记忆外箱

Revision ID: 0017
Revises: 0016
"""
from alembic import op
import sqlalchemy as sa


revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None


# 升级：新建 memory_outbox。写 runs 时同一个事务里插入一条待写入会话记忆的任务，保证 runs 和会话记忆一致。
def upgrade():
    op.create_table('memory_outbox',
        sa.Column('request_id', sa.String(length=36), nullable=False),
        sa.Column('owner', sa.String(length=32), nullable=False),
        sa.Column('session_id', sa.String(length=36), nullable=False),
        sa.Column('question', sa.Text(), nullable=False),
        sa.Column('answer', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('applied', sa.String(length=32), nullable=True),
        sa.PrimaryKeyConstraint('request_id'))
    op.create_index('ix_memory_outbox_session_status', 'memory_outbox', ['owner', 'session_id', 'status'])


# 回退：删除外箱。已经写进会话记忆的内容不受影响，没写完的任务丢弃。
def downgrade():
    op.drop_index('ix_memory_outbox_session_status', table_name='memory_outbox')
    op.drop_table('memory_outbox')
