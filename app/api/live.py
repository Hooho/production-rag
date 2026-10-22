"""正在回答的问题的进度记录（Redis）。

流式问答的阶段、文字片段、Agent 轮次原来只通过这一次 HTTP 连接推给浏览器。切到别的页面、刷新页面、网络断开后，
后端还在继续回答，浏览器却再也拿不到进度，再提问还会因为会话锁返回“该会话正在回答”。

现在每个事件同时记进 Redis：
- chat:live:{owner}:{session_id}：这个会话正在回答（或刚回答完）的问题：request_id、问题、模式、状态；
- chat:events:{request_id}：按顺序记下的全部事件（step / token / round / complete / error）。
前端打开问答页时先查这个会话有没有正在回答的问题，有就从头重放事件、再接着收新的，和没离开过一样。
只在拿到会话锁之后才开始记录：被拒绝的请求（会话正在回答）不会覆盖正在进行的那一个。
"""
import json
import time
from datetime import datetime, timezone

TTL = 900          # 进度记录保留 15 分钟，足够覆盖最长的一次回答
DONE_TTL = 120     # 回答完以后再留 2 分钟：页面刚好在完成前读了历史、完成后才查进度，也能把结果补上


def pointer_key(owner, session_id):
    return f"chat:live:{owner}:{session_id}"


def events_key(request_id):
    return f"chat:events:{request_id}"


def meta_key(request_id):
    return f"chat:meta:{request_id}"


class LiveLog:
    def __init__(self, cache, owner, session_id, request_id, question, mode):
        self.cache, self.owner, self.session_id = cache, owner, session_id
        self.request_id, self.question, self.mode = request_id, question, mode
        self.started = False

    def start(self):
        self.started = True
        self.cache.delete(events_key(self.request_id))
        self.cache.set(meta_key(self.request_id), json.dumps({"owner": self.owner, "session_id": self.session_id}), ex=TTL)
        self.write_pointer("running", TTL)
        # 先放一个 started 事件，事件列表从一开始就存在（重放时据此区分“还没有事件”和“记录已过期”）。
        self.push("started", {"request_id": self.request_id})

    def write_pointer(self, status, ttl):
        self.cache.set(pointer_key(self.owner, self.session_id), json.dumps({"request_id": self.request_id,
            "question": self.question, "mode": self.mode, "status": status,
            "started": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False), ex=ttl)

    def push(self, event, payload):
        if not self.started:
            return
        key = events_key(self.request_id)
        self.cache.rpush(key, json.dumps([event, payload], ensure_ascii=False))
        self.cache.expire(key, TTL)

    def finish(self):
        if not self.started:
            return
        self.write_pointer("done", DONE_TTL)
        self.cache.expire(events_key(self.request_id), DONE_TTL)
        self.cache.expire(meta_key(self.request_id), DONE_TTL)


def current(cache, owner, session_id):
    value = cache.get(pointer_key(owner, session_id))
    return json.loads(value) if value else None


def owner_of(cache, request_id):
    value = cache.get(meta_key(request_id))
    return json.loads(value)["owner"] if value else None


# 从第 after 个事件开始重放，再每 0.5 秒取一次新事件，直到 complete / error。每 15 秒发一行注释保持连接。
def replay(cache, request_id, after=0, wait=0.5, idle_limit=TTL):
    index = after
    last_sent = time.monotonic()
    idle_since = time.monotonic()
    while True:
        items = cache.lrange(events_key(request_id), index, -1)
        for item in items:
            event, payload = json.loads(item)
            index += 1
            yield f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            last_sent = idle_since = time.monotonic()
            if event in {"complete", "error"}:
                return
        if not cache.exists(events_key(request_id)) or time.monotonic() - idle_since > idle_limit:
            detail = json.dumps({"detail": "这次回答的进度记录已过期，请刷新页面查看结果", "status_code": 410}, ensure_ascii=False)
            yield f"event: error\ndata: {detail}\n\n"
            return
        if time.monotonic() - last_sent > 15:
            yield ": ping\n\n"
            last_sent = time.monotonic()
        time.sleep(wait)
