"""文档上架状态

Revision ID: 0015
Revises: 0014
"""
from alembic import op
import sqlalchemy as sa


revision = '0015'
down_revision = '0014'
branch_labels = None
depends_on = None


# 升级：document_heads 加上架状态，已有文档都算已上架（检索结果不变）；审核记录加上传者的提交说明。
# 已经有这一列就跳过（直接按模型建表的库里已经有了），迁移可以重复执行。
def upgrade():
    inspector = sa.inspect(op.get_bind())
    if 'listed' not in {column['name'] for column in inspector.get_columns('document_heads')}:
        op.add_column('document_heads', sa.Column('listed', sa.Boolean(), nullable=False, server_default=sa.text('1')))
    if 'request_note' not in {column['name'] for column in inspector.get_columns('document_reviews')}:
        op.add_column('document_reviews', sa.Column('request_note', sa.String(length=500), nullable=True))


# 回退：去掉这两列。待上架、有问题的版本不会自动生效，需要重新上传。
def downgrade():
    with op.batch_alter_table('document_reviews') as batch:
        batch.drop_column('request_note')
    with op.batch_alter_table('document_heads') as batch:
        batch.drop_column('listed')
