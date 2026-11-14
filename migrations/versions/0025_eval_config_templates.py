"""Persist reusable evaluation configurations."""

from alembic import op
import sqlalchemy as sa

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("eval_config_templates"):
        return
    op.create_table(
        "eval_config_templates",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created", sa.String(40), nullable=False),
        sa.Column("updated", sa.String(40), nullable=False),
    )


def downgrade():
    op.drop_table("eval_config_templates")
