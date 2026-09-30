import os
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, Float, JSON, Integer, MetaData, String, Table, Text, UniqueConstraint, create_engine, select
from sqlalchemy.engine import URL


metadata = MetaData()
sessions = Table("sessions", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False),
)
runs = Table("runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", String(36), nullable=False, index=True),
    Column("owner", String(32), nullable=False),
    Column("question", Text, nullable=False),
    Column("response", JSON, nullable=False),
    Column("created", String(32), nullable=False),
    # 追踪摘要（见 app/observability.py）：response 里的完整 JSON 只适合逐条查看，
    # 这几列单独存放，才能按路由、是否拒答、耗时、检索最高分筛选和统计。
    Column("route", String(20)),
    Column("refused", Boolean),
    Column("duration_ms", Integer),
    Column("top_score", Float),
    Column("trace", JSON),
)
# 处理失败的问答。runs 只保存成功结果（同一 request_id 重放会直接返回它），
# 失败以前只写日志，统计不出错误率，也看不到失败在哪个阶段；这里单独记录。
run_errors = Table("run_errors", metadata,
    Column("id", String(36), primary_key=True),
    Column("request_id", String(36), nullable=False, index=True),
    Column("session_id", String(36), nullable=False),
    Column("owner", String(32), nullable=False, index=True),
    Column("question", Text, nullable=False),
    Column("status_code", Integer, nullable=False),
    Column("error", String(500), nullable=False),
    # 最后一个已完成的阶段，失败发生在它之后。
    Column("last_step", String(32)),
    Column("steps", JSON),
    Column("duration_ms", Integer),
    Column("created", String(32), nullable=False),
)
# 用户对一次回答的反馈，每次回答（runs.id）最多一条，重复提交覆盖。
feedback = Table("feedback", metadata,
    Column("run_id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("session_id", String(36), nullable=False),
    # 1 表示有帮助，-1 表示没帮助。
    Column("rating", Integer, nullable=False),
    Column("reason", String(20)),
    # 用户补充的说明或正确答案。
    Column("comment", Text),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)


# 数据管理页里每种业务数据共用的系统列：谁创建、何时创建和修改、是否已删除、来自手动录入还是 AI 生成。
# 每张表都要一组新的 Column 对象（同一个 Column 不能挂在两张表上），所以用函数生成。
# required=False 只给 orders 用：orders 表早于数据管理存在，旧数据和演示数据没有这些值。
def record_columns(required=True):
    return [
        Column("created_by", String(32), nullable=not required),
        Column("created", String(32), nullable=not required),
        Column("updated", String(32), nullable=not required),
        # 软删除：误删可以恢复，审计时也还能看到被删的数据；所有查询都要带上 deleted_at 为空的条件。
        Column("deleted_at", String(32)),
        # manual 或 ai。AI 生成的测试数据按 batch_id 可以整批找出、整批删除，不会和手动录入的数据混在一起。
        Column("source", String(10), nullable=not required),
        Column("batch_id", String(36), index=True),
    ]


# 订单。原来只有 id、owner、status、arrival 四列，只够演示"查自己的订单"；
# 接入数据管理后补上客户、商品、数量、金额、下单日期，新增列都允许为空，旧订单不用补数据。
# 金额用 Float 是为了和 SQLite 测试库兼容，真实财务系统应改用 Numeric 避免浮点误差。
orders = Table("orders", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner", String(32), nullable=False),
    Column("status", String(100), nullable=False),
    Column("arrival", String(100), nullable=False),
    Column("customer_id", String(16), index=True),
    Column("product_id", String(16), index=True),
    Column("quantity", Integer),
    Column("amount", Float),
    Column("ordered_at", String(10)),
    *record_columns(required=False),
)
# 下面是数据管理页的其余业务表，字段含义、校验规则和中文名在 app/data/schema.py 里配置。
# 日期统一存 YYYY-MM-DD 字符串，和项目里其他时间列的做法一致，按字符串比较即可排序和筛选。
products = Table("products", metadata,
    Column("id", String(16), primary_key=True),
    Column("name", String(100), nullable=False),
    Column("category", String(50), nullable=False),
    Column("price", Float, nullable=False),
    Column("status", String(10), nullable=False),
    Column("description", Text),
    *record_columns(),
)
customers = Table("customers", metadata,
    Column("id", String(16), primary_key=True),
    Column("name", String(50), nullable=False),
    Column("phone", String(20), nullable=False),
    Column("level", String(10), nullable=False),
    Column("city", String(50)),
    Column("registered_at", String(10), nullable=False),
    *record_columns(),
)
# 同一商品在同一仓库只能有一条库存。因为是软删除，唯一性由代码检查（只看未删除的行），不用数据库唯一约束。
inventory = Table("inventory", metadata,
    Column("id", String(16), primary_key=True),
    Column("product_id", String(16), nullable=False, index=True),
    Column("warehouse", String(20), nullable=False),
    Column("quantity", Integer, nullable=False),
    Column("safety_stock", Integer, nullable=False),
    *record_columns(),
)
shipments = Table("shipments", metadata,
    Column("id", String(16), primary_key=True),
    Column("order_id", String(32), nullable=False, index=True),
    Column("carrier", String(20), nullable=False),
    Column("tracking_no", String(40), nullable=False),
    Column("status", String(10), nullable=False),
    Column("shipped_at", String(10), nullable=False),
    Column("delivered_at", String(10)),
    *record_columns(),
)
after_sales = Table("after_sales", metadata,
    Column("id", String(16), primary_key=True),
    Column("order_id", String(32), nullable=False, index=True),
    Column("type", String(10), nullable=False),
    Column("reason", String(200), nullable=False),
    Column("amount", Float, nullable=False),
    Column("status", String(10), nullable=False),
    Column("handler", String(32)),
    *record_columns(),
)
# product_id 为空表示全场活动。
promotions = Table("promotions", metadata,
    Column("id", String(16), primary_key=True),
    Column("name", String(100), nullable=False),
    Column("type", String(10), nullable=False),
    Column("product_id", String(16), index=True),
    Column("rule", String(100), nullable=False),
    Column("start_date", String(10), nullable=False),
    Column("end_date", String(10), nullable=False),
    *record_columns(),
)
reviews = Table("reviews", metadata,
    Column("id", String(16), primary_key=True),
    Column("product_id", String(16), nullable=False, index=True),
    Column("customer_id", String(16), nullable=False, index=True),
    Column("rating", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("reviewed_at", String(10), nullable=False),
    *record_columns(),
)
# 部门对每种数据的操作权限。用户的权限是他所在各部门权限的并集，管理员拥有全部权限。
# 权限每次请求都从这里读取，不写进 JWT：写进令牌的话，改了权限要等令牌过期才生效。
data_permissions = Table("data_permissions", metadata,
    Column("group_id", String(32), primary_key=True),
    Column("data_type", String(32), primary_key=True),
    Column("can_read", Boolean, nullable=False, default=False),
    Column("can_create", Boolean, nullable=False, default=False),
    Column("can_update", Boolean, nullable=False, default=False),
    Column("can_delete", Boolean, nullable=False, default=False),
)
# 数据管理的操作记录：谁在什么时候对哪条数据做了什么，changes 保存新增或修改的字段值。
data_audit = Table("data_audit", metadata,
    Column("id", String(36), primary_key=True),
    Column("data_type", String(32), nullable=False, index=True),
    Column("record_id", String(32), nullable=False),
    Column("action", String(10), nullable=False),
    Column("username", String(32), nullable=False),
    Column("changes", JSON),
    Column("created", String(32), nullable=False),
)
documents = Table("documents", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("filename", String(255), nullable=False),
    Column("path", String(500), nullable=False),
    Column("status", String(32), nullable=False),
    Column("error", Text),
    Column("document_metadata", JSON),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
    # documents 的每一行是一个版本（一次上传）。以前每次上传彼此无关，修改后的文档再上传会和旧版本同时被检索；
    # 现在同一份逻辑文档的各个版本共用 doc_key，版本号由系统递增，唯一约束防止并发上传得到相同版本号。
    Column("doc_key", String(36), index=True),
    Column("version", Integer),
    Column("version_note", String(500)),
    # 单独保存原始内容的 sha256，用于上传去重；放在 JSON metadata 里无法建索引查询。
    Column("content_sha256", String(64), index=True),
    UniqueConstraint("doc_key", "version", name="uq_documents_doc_key_version"),
)
# 每份逻辑文档一行，只保存"当前版本"指针。检索只看这里指向的版本：
# 切换版本只改这一行，单行更新天然原子，不会出现两个当前版本或没有当前版本的中间状态。
# 只有版本处理成功后才写入这里，因此每一行都一定指向一个可用版本。
document_heads = Table("document_heads", metadata,
    Column("doc_key", String(36), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("current_document_id", String(36), nullable=False),
    Column("current_version", Integer, nullable=False),
    Column("updated", String(32), nullable=False),
)
chunks = Table("chunks", metadata,
    # 主键为"版本 id:序号"。以前用"用户+标题+全文+序号"的哈希，只要全文改一个字所有 ID 都变；
    # 现在每个版本的分片各占一行、互不覆盖，可以按版本整体删除。
    Column("id", String(64), primary_key=True),
    Column("owner", String(32), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("text", Text, nullable=False),
    Column("content", Text),
    # 稳定的内容标识 sha256(doc_key + 送去 embedding 的文字)：内容不变则跨版本不变，
    # 供评测标注、用户反馈长期对应同一段内容，以后做增量 embedding 也靠它找到可复用的向量。
    Column("chunk_key", String(64), index=True),
)
document_steps = Table("document_steps", metadata,
    Column("document_id", String(36), primary_key=True),
    Column("step_id", String(32), primary_key=True),
    Column("step_order", Integer, nullable=False),
    Column("stage", String(32), nullable=False),
    Column("title", String(100), nullable=False),
    Column("status", String(20), nullable=False),
    Column("detail", String(500), nullable=False),
    Column("result", JSON),
    Column("duration_ms", Integer),
    Column("updated", String(32), nullable=False),
)
document_chunks = Table("document_chunks", metadata,
    Column("document_id", String(36), primary_key=True),
    Column("chunk_id", String(64), primary_key=True),
    Column("position", Integer),
    Column("chunk_metadata", JSON),
)
# 系统设置（目前只有聊天大模型配置）。原来模型只能写在 .env 里、改完要重启容器；
# 存进 MySQL 后 API 保存即生效，worker 处理下一个文档时也能读到同一份配置。
# 为了学习项目简单起见，密钥以明文保存；接口只返回脱敏后的值。
settings = Table("settings", metadata,
    Column("key", String(64), primary_key=True),
    Column("value", JSON, nullable=False),
    Column("updated", String(32), nullable=False),
)

# 登录用户。原来身份来自 .env 里给每个用户配置的 API Key：密钥不会过期、泄露后只能改配置重启，
# 新增用户也要改配置。现在用户名密码登录后发放短期 JWT，用户存在数据库里，可以随时新增、停用。
# username 同时就是各业务表里的 owner，已有数据不用迁移。
users = Table("users", metadata,
    Column("username", String(32), primary_key=True),
    # scrypt 哈希，格式见 app/auth.py，不保存明文密码。
    Column("password_hash", String(255), nullable=False),
    Column("is_admin", Boolean, nullable=False, default=False),
    Column("disabled", Boolean, nullable=False, default=False),
    Column("created", String(32), nullable=False),
)
# 部门（用户组），文档可以共享给一个或多个部门。
user_groups = Table("user_groups", metadata,
    Column("id", String(32), primary_key=True),
    Column("name", String(100), nullable=False),
)
user_group_members = Table("user_group_members", metadata,
    Column("username", String(32), primary_key=True),
    Column("group_id", String(32), primary_key=True, index=True),
)
# 刷新令牌。访问令牌（JWT）只有 30 分钟有效期、服务端不保存；刷新令牌有效期长，
# 因此保存在服务端，才能在退出登录、改密码、停用用户时让它立即失效。只保存 sha256，数据库泄露也拿不到可用令牌。
refresh_tokens = Table("refresh_tokens", metadata,
    Column("token_hash", String(64), primary_key=True),
    Column("username", String(32), nullable=False, index=True),
    Column("expires", String(32), nullable=False),
    Column("revoked", Boolean, nullable=False, default=False),
    Column("created", String(32), nullable=False),
)
# 文档可见范围，按逻辑文档（doc_key）设置，所有版本共用。没有记录的文档按 private 处理，升级前的文档保持原来的"只有自己可见"。
# private：只有上传者；shared：上传者和 document_shares 中的部门成员；public：所有登录用户。
document_permissions = Table("document_permissions", metadata,
    Column("doc_key", String(36), primary_key=True),
    Column("visibility", String(16), nullable=False),
    Column("updated", String(32), nullable=False),
)
document_shares = Table("document_shares", metadata,
    Column("doc_key", String(36), primary_key=True),
    Column("group_id", String(32), primary_key=True, index=True),
)

# 数据库连接地址。API、Worker 和 Alembic 迁移都用它，保证连的是同一个库。
def database_url():
    return URL.create("mysql+pymysql", username=os.getenv("MYSQL_USER", "rag"),
        password=os.environ["MYSQL_PASSWORD"], host=os.getenv("MYSQL_HOST", "localhost"),
        database=os.getenv("MYSQL_DATABASE", "rag"))


class MySQLStore:
    """管理业务表、会话记录和问答运行记录。"""

    def __init__(self):
        self.engine = create_engine(database_url(), pool_pre_ping=True, pool_size=5, max_overflow=5,
            connect_args={"connect_timeout": 5, "read_timeout": 10, "write_timeout": 10})
        # 表结构改由 Alembic 迁移管理（migrations/，部署时由 compose 的 migrate 服务先执行 alembic upgrade head）。
        # 原来这里用 create_all 建表，再用 ensure_* 函数检查列、索引是否存在并手动补齐：
        # create_all 不会修改已有的表，每次改表都要多写一段"先检查再补"，每次启动都要执行，
        # 也记不下每个库改到了哪一步。这些补丁已原样移入第一个迁移 migrations/versions/0001_baseline.py。
        self.seed_demo_orders()

    # 只写入不存在的演示订单，真实系统应改为业务系统同步。
    def seed_demo_orders(self):
        with self.engine.begin() as connection:
            for order_id, owner in (("A1001", "alice"), ("B2001", "bob")):
                existing = connection.execute(select(orders).where(orders.c.id == order_id)).first()
                if not existing:
                    connection.execute(orders.insert().values(id=order_id, owner=owner,
                        status="已发货（演示数据）", arrival="发货后 3 个工作日内（演示数据）"))

    # 创建待解析的文档版本记录，状态由 Worker 更新；doc_key 和 version 由调用方分配。
    def create_document(self, document_id, owner, title, filename, path, document_metadata=None,
                        doc_key=None, version=1, version_note=None, content_sha256=None):
        now = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as connection:
            connection.execute(documents.insert().values(id=document_id, owner=owner,
                title=title, filename=filename, path=path, status="queued",
                error=None, document_metadata=document_metadata or {}, created=now, updated=now,
                doc_key=doc_key or document_id, version=version, version_note=version_note,
                content_sha256=content_sha256))
        self.update_document_step(document_id, "queued", 1, "queue", "接收上传文件", "completed",
            "文件已保存并进入解析队列", {"filename": filename, "title": title})

    # 合并更新已上传文档的解析器、分块和模型 provenance。
    def update_document_metadata(self, document_id, updates):
        with self.engine.begin() as connection:
            current = connection.execute(select(documents.c.document_metadata).where(
                documents.c.id == document_id)).scalar_one_or_none() or {}
            current.update(updates)
            connection.execute(documents.update().where(documents.c.id == document_id).values(
                document_metadata=current, updated=datetime.now(timezone.utc).isoformat()))

    # 写入文档流水线的一个阶段，重复更新同一阶段保持幂等。
    def update_document_step(self, document_id, step_id, step_order, stage, title, status, detail,
        result=None, duration_ms=None):
        now = datetime.now(timezone.utc).isoformat()
        values = {"document_id": document_id, "step_id": step_id, "step_order": step_order,
            "stage": stage, "title": title, "status": status, "detail": detail,
            "result": result, "duration_ms": duration_ms, "updated": now}
        with self.engine.begin() as connection:
            existing = connection.execute(select(document_steps.c.document_id).where(
                document_steps.c.document_id == document_id, document_steps.c.step_id == step_id)).first()
            if existing:
                connection.execute(document_steps.update().where(
                    document_steps.c.document_id == document_id,
                    document_steps.c.step_id == step_id).values(**values))
            else:
                connection.execute(document_steps.insert().values(**values))

    # 删除某个版本从指定顺序开始的处理步骤。
    # 重试会从解析重新开始，上一次尝试留下的"切分完成""生成向量失败"等步骤如果不清掉，
    # 页面上会同时出现正在解析和后面步骤已完成或失败，看不出当前真正的状态。
    def clear_document_steps(self, document_id, from_order):
        with self.engine.begin() as connection:
            connection.execute(document_steps.delete().where(
                document_steps.c.document_id == document_id, document_steps.c.step_order >= from_order))

    # 返回文档流水线阶段，按固定顺序供 API 和前端展示。
    def get_document_steps(self, document_id):
        with self.engine.connect() as connection:
            rows = connection.execute(select(document_steps).where(
                document_steps.c.document_id == document_id
            ).order_by(document_steps.c.step_order)).mappings().all()
        return [dict(row) for row in rows]

    # 更新文档解析状态和错误摘要。
    def update_document(self, document_id, status, error=None):
        now = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as connection:
            connection.execute(documents.update().where(documents.c.id == document_id).values(
                status=status, error=error, updated=now))

    # 关闭连接池。
    def close(self):
        self.engine.dispose()
