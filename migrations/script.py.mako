"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
"""
from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


# 升级：写这次要对表做的修改。
def upgrade():
    ${upgrades if upgrades else "pass"}


# 回退：撤销 upgrade 做的修改。
def downgrade():
    ${downgrades if downgrades else "pass"}
