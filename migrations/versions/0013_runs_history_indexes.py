"""问答记录的排序索引

Revision ID: 0013
Revises: 0012
"""
from alembic import op
import sqlalchemy as sa


revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


# 升级：给 runs 加 (owner, created) 和 (session_id, owner, created) 两个索引。
# 读取历史时按 created 排序，没有索引时 MySQL 要把整行（含很大的 response JSON）放进排序缓冲区，
# 记录多了会报 1038 Out of sort memory，历史记录和问答都会失败。
# 已经存在的索引跳过（直接按模型建表的库里已经有了），迁移可以重复执行。
INDEXES = {'ix_runs_owner_created': ['owner', 'created'],
    'ix_runs_session_owner_created': ['session_id', 'owner', 'created']}


def upgrade():
    existing = {index['name'] for index in sa.inspect(op.get_bind()).get_indexes('runs')}
    for name, columns in INDEXES.items():
        if name not in existing:
            op.create_index(name, 'runs', columns)


def downgrade():
    op.drop_index('ix_runs_session_owner_created', table_name='runs')
    op.drop_index('ix_runs_owner_created', table_name='runs')
