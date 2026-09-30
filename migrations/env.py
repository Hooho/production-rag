from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.mysql.store import database_url, metadata


config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

# 连接数据库并执行迁移。测试可以通过 sqlalchemy.url 指定别的库（如 SQLite），平时连 MYSQL_* 指定的库。
# autogenerate 会用 metadata（store.py 里的表定义）和数据库实际结构比较，生成迁移草稿。
def run_migrations():
    url = config.get_main_option("sqlalchemy.url") or database_url()
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


run_migrations()
