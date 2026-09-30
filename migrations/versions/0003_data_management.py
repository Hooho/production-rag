"""数据管理：业务数据表、部门数据权限和操作记录

Revision ID: 0003
Revises: 0002
"""
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa


revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None

# orders 表补充的列。旧库里 orders 已经存在，只加缺少的列。
ORDER_COLUMNS = [
    ("customer_id", sa.String(length=16)),
    ("product_id", sa.String(length=16)),
    ("quantity", sa.Integer()),
    ("amount", sa.Float()),
    ("ordered_at", sa.String(length=10)),
    ("created_by", sa.String(length=32)),
    ("created", sa.String(length=32)),
    ("updated", sa.String(length=32)),
    ("deleted_at", sa.String(length=32)),
    ("source", sa.String(length=10)),
    ("batch_id", sa.String(length=36)),
]
ORDER_INDEXES = ["customer_id", "product_id", "batch_id"]
NEW_TABLES = ["products", "customers", "inventory", "shipments", "after_sales", "promotions", "reviews"]

# 默认部门和权限矩阵，管理员可以在设置页修改。部门已存在（管理员自己建过同名部门）时不覆盖名称。
DEFAULT_GROUPS = [("service", "客服部"), ("operations", "运营部"), ("warehouse", "仓储部"), ("finance", "财务部")]
# 每项为 (部门, 数据类型, 权限)，权限字母：r 查看、c 新增、u 修改、d 删除。
DEFAULT_PERMISSIONS = [
    ("service", "customers", "rcu"), ("service", "products", "r"), ("service", "orders", "rcu"),
    ("service", "shipments", "r"), ("service", "after_sales", "rcu"), ("service", "promotions", "r"),
    ("service", "reviews", "r"),
    ("operations", "customers", "rcud"), ("operations", "products", "rcud"), ("operations", "inventory", "r"),
    ("operations", "promotions", "rcud"), ("operations", "reviews", "rd"),
    ("warehouse", "products", "r"), ("warehouse", "orders", "ru"), ("warehouse", "inventory", "rcud"),
    ("warehouse", "shipments", "rcud"),
    ("finance", "orders", "r"), ("finance", "after_sales", "ru"),
]


# 每张业务表共用的系统列，和 app/mysql/store.py 的 record_columns 保持一致。
def record_columns():
    return [
        sa.Column('created_by', sa.String(length=32), nullable=False),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.Column('updated', sa.String(length=32), nullable=False),
        sa.Column('deleted_at', sa.String(length=32), nullable=True),
        sa.Column('source', sa.String(length=10), nullable=False),
        sa.Column('batch_id', sa.String(length=36), nullable=True),
    ]


# 建一张业务表并给 batch_id 和引用字段建索引。
def create_record_table(name, columns, indexes):
    op.create_table(name, sa.Column('id', sa.String(length=16), nullable=False), *columns, *record_columns(),
        sa.PrimaryKeyConstraint('id'))
    for column in indexes + ["batch_id"]:
        op.create_index(op.f(f'ix_{name}_{column}'), name, [column], unique=False)


# 升级：写这次要对表做的修改。
def upgrade():
    bind = op.get_bind()
    existing = set()
    for column in sa.inspect(bind).get_columns("orders"):
        existing.add(column["name"])
    for name, column_type in ORDER_COLUMNS:
        if name not in existing:
            op.add_column("orders", sa.Column(name, column_type, nullable=True))
    index_names = set()
    for index in sa.inspect(bind).get_indexes("orders"):
        index_names.add(index["name"])
    for column in ORDER_INDEXES:
        if f"ix_orders_{column}" not in index_names:
            op.create_index(op.f(f"ix_orders_{column}"), "orders", [column], unique=False)
    # 已有订单视为手动录入，创建人记为订单归属用户，数据管理页才能正常显示和筛选。
    now = datetime.now(timezone.utc).isoformat()
    bind.execute(sa.text("UPDATE orders SET created_by = owner, created = :now, updated = :now, source = 'manual' "
        "WHERE created_by IS NULL"), {"now": now})

    create_record_table('products', [
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('category', sa.String(length=50), nullable=False),
        sa.Column('price', sa.Float(), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
    ], [])
    create_record_table('customers', [
        sa.Column('name', sa.String(length=50), nullable=False),
        sa.Column('phone', sa.String(length=20), nullable=False),
        sa.Column('level', sa.String(length=10), nullable=False),
        sa.Column('city', sa.String(length=50), nullable=True),
        sa.Column('registered_at', sa.String(length=10), nullable=False),
    ], [])
    create_record_table('inventory', [
        sa.Column('product_id', sa.String(length=16), nullable=False),
        sa.Column('warehouse', sa.String(length=20), nullable=False),
        sa.Column('quantity', sa.Integer(), nullable=False),
        sa.Column('safety_stock', sa.Integer(), nullable=False),
    ], ['product_id'])
    create_record_table('shipments', [
        sa.Column('order_id', sa.String(length=32), nullable=False),
        sa.Column('carrier', sa.String(length=20), nullable=False),
        sa.Column('tracking_no', sa.String(length=40), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('shipped_at', sa.String(length=10), nullable=False),
        sa.Column('delivered_at', sa.String(length=10), nullable=True),
    ], ['order_id'])
    create_record_table('after_sales', [
        sa.Column('order_id', sa.String(length=32), nullable=False),
        sa.Column('type', sa.String(length=10), nullable=False),
        sa.Column('reason', sa.String(length=200), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('handler', sa.String(length=32), nullable=True),
    ], ['order_id'])
    create_record_table('promotions', [
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('type', sa.String(length=10), nullable=False),
        sa.Column('product_id', sa.String(length=16), nullable=True),
        sa.Column('rule', sa.String(length=100), nullable=False),
        sa.Column('start_date', sa.String(length=10), nullable=False),
        sa.Column('end_date', sa.String(length=10), nullable=False),
    ], ['product_id'])
    create_record_table('reviews', [
        sa.Column('product_id', sa.String(length=16), nullable=False),
        sa.Column('customer_id', sa.String(length=16), nullable=False),
        sa.Column('rating', sa.Integer(), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('reviewed_at', sa.String(length=10), nullable=False),
    ], ['product_id', 'customer_id'])

    op.create_table('data_permissions',
        sa.Column('group_id', sa.String(length=32), nullable=False),
        sa.Column('data_type', sa.String(length=32), nullable=False),
        sa.Column('can_read', sa.Boolean(), nullable=False),
        sa.Column('can_create', sa.Boolean(), nullable=False),
        sa.Column('can_update', sa.Boolean(), nullable=False),
        sa.Column('can_delete', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('group_id', 'data_type'))
    op.create_table('data_audit',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('data_type', sa.String(length=32), nullable=False),
        sa.Column('record_id', sa.String(length=32), nullable=False),
        sa.Column('action', sa.String(length=10), nullable=False),
        sa.Column('username', sa.String(length=32), nullable=False),
        sa.Column('changes', sa.JSON(), nullable=True),
        sa.Column('created', sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_data_audit_data_type'), 'data_audit', ['data_type'], unique=False)

    for group_id, name in DEFAULT_GROUPS:
        found = bind.execute(sa.text("SELECT id FROM user_groups WHERE id = :id"), {"id": group_id}).first()
        if found is None:
            bind.execute(sa.text("INSERT INTO user_groups (id, name) VALUES (:id, :name)"), {"id": group_id, "name": name})
    for group_id, data_type, letters in DEFAULT_PERMISSIONS:
        bind.execute(sa.text("INSERT INTO data_permissions (group_id, data_type, can_read, can_create, can_update, "
            "can_delete) VALUES (:group_id, :data_type, :r, :c, :u, :d)"), {"group_id": group_id,
            "data_type": data_type, "r": "r" in letters, "c": "c" in letters, "u": "u" in letters, "d": "d" in letters})


# 回退：撤销 upgrade 做的修改。默认部门保留，部门里可能已经加了成员。
def downgrade():
    op.drop_index(op.f('ix_data_audit_data_type'), table_name='data_audit')
    op.drop_table('data_audit')
    op.drop_table('data_permissions')
    for name in reversed(NEW_TABLES):
        op.drop_table(name)
    # SQLite 不支持直接删列，batch 模式会重建表；MySQL 上等同于普通的 DROP COLUMN。
    with op.batch_alter_table("orders") as batch:
        for column in ORDER_INDEXES:
            batch.drop_index(f"ix_orders_{column}")
        for name, _ in reversed(ORDER_COLUMNS):
            batch.drop_column(name)
