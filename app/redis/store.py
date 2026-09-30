import os

from redis import Redis


class RedisStore:
    """提供短期记忆、限流计数和会话锁。"""

    def __init__(self):
        self.client = Redis(host=os.getenv("REDIS_HOST", "localhost"),
            password=os.environ["REDIS_PASSWORD"], decode_responses=True,
            socket_timeout=3, socket_connect_timeout=3)

    # 关闭 Redis 连接池。
    def close(self):
        self.client.close()
