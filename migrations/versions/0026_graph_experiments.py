"""Independent graph extraction experiments."""

from alembic import op
from app.mysql.tables import graph_experiments

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade():
    graph_experiments.create(op.get_bind(), checkfirst=True)


def downgrade():
    graph_experiments.drop(op.get_bind())
