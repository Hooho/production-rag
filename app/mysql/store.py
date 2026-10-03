import os
from datetime import datetime, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.engine import URL

from .tables import *  # noqa: F403


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
