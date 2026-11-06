"""图谱的合并键、别名键改成按字节比较（utf8mb4_bin）

Revision ID: 0024
Revises: 0023
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


# 合并键由程序规范化后算出，程序认为不同的两个键，MySQL 默认比较规则（utf8mb4_0900_ai_ci）可能认为相同，
# 例如「系统性⻛险」（部首字 ⻛）和「系统性风险」，写入时报唯一键重复、建图失败。改成按字节比较后两边一致。
# 只在 MySQL 上改；SQLite 没有这个排序规则，本来就按字节比较。
COLUMNS = (("graph_entities", "merge_key"), ("graph_aliases", "alias_key"))


def upgrade():
    if op.get_bind().dialect.name != "mysql":
        return
    for table, column in COLUMNS:
        op.alter_column(
            table,
            column,
            existing_type=sa.String(255),
            type_=mysql.VARCHAR(255, collation="utf8mb4_bin"),
            existing_nullable=False,
        )


def downgrade():
    if op.get_bind().dialect.name != "mysql":
        return
    for table, column in COLUMNS:
        op.alter_column(
            table,
            column,
            existing_type=mysql.VARCHAR(255, collation="utf8mb4_bin"),
            type_=sa.String(255),
            existing_nullable=False,
        )
