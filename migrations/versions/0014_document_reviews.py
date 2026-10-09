"""公开文档审核

Revision ID: 0014
Revises: 0013
"""
from alembic import op
import sqlalchemy as sa


revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


# 升级：新建公开审核表。已经公开的文档保持不变，只有以后的申请公开和公开文档的新版本需要审核。
def upgrade():
    op.create_table('document_reviews',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('doc_key', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('document_id', sa.String(length=36), nullable=False),
        sa.Column('version', sa.Integer(), nullable=True),
        sa.Column('chunk_count', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('requested_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('reviewed_by', sa.String(length=32), nullable=True),
        sa.Column('reviewed', sa.String(length=32), nullable=True),
        sa.Column('note', sa.String(length=500), nullable=True),
        sa.PrimaryKeyConstraint('id'))
    op.create_index('ix_document_reviews_doc_key', 'document_reviews', ['doc_key'])
    op.create_index('ix_document_reviews_status', 'document_reviews', ['status'])


# 回退：删除审核表。等待审核的新版本（状态 review:N）不会自动生效，需要上传者重新上传。
def downgrade():
    op.drop_index('ix_document_reviews_status', table_name='document_reviews')
    op.drop_index('ix_document_reviews_doc_key', table_name='document_reviews')
    op.drop_table('document_reviews')
