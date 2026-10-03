"""知识巡检：问题按拒答分类结论筛选

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


# 升级：新增 diagnosis_category 列，并从已有问题的 detail.diagnosis.category 回填。
def upgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.add_column(sa.Column('diagnosis_category', sa.String(length=16), nullable=True))
        batch.create_index(batch.f('ix_inspection_issues_diagnosis_category'), ['diagnosis_category'], unique=False)
    issues = sa.table('inspection_issues', sa.column('id', sa.String), sa.column('detail', sa.JSON),
        sa.column('diagnosis_category', sa.String))
    connection = op.get_bind()
    for issue_id, detail in connection.execute(sa.select(issues.c.id, issues.c.detail)).all():
        category = ((detail or {}).get('diagnosis') or {}).get('category')
        if category:
            connection.execute(issues.update().where(issues.c.id == issue_id).values(diagnosis_category=category[:16]))


# 回退：删除 diagnosis_category 列。
def downgrade():
    with op.batch_alter_table('inspection_issues') as batch:
        batch.drop_index(batch.f('ix_inspection_issues_diagnosis_category'))
        batch.drop_column('diagnosis_category')
