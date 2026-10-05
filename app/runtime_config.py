# 运行时参数：设置页里可以修改的参数，分两个页签：「RAG 配置」（检索、回答流程、对话记忆、知识巡检、
# 模型服务）和「系统配置」（通用）。
# 当前值 = 设置页保存的值，没改过就用代码默认值。设置页的值存在 settings 表（key = runtime），只存改过的项。
# 这些参数不再从 .env 读：以前是「设置页 > .env > 默认值」三层，同一个参数两处都能改，页面上还要标来源，
# 容易搞不清实际生效的是哪个。.env 只留部署相关的配置（地址、密钥、模型名、数据库连接等）。
#
# 原来这些值是模块常量或进程启动时读一次的环境变量，改了要重启；评测模块还在导入时把常量复制了一份，
# 改了 search.py 里的值评测那边也不变。现在所有用到的地方都在运行时调用 value() / snapshot()。
# api 和 worker 是两个进程，各自缓存数据库里的值 CACHE_SECONDS 秒，过期后重新读，所以保存后几秒内都会生效。
from datetime import datetime, timezone
import logging
import threading
import time
from zoneinfo import ZoneInfo, available_timezones

from sqlalchemy import select


logger = logging.getLogger("production-rag-config")

SETTING_KEY = "runtime"
HISTORY_KEY = "runtime_history"
HISTORY_LIMIT = 50
CACHE_SECONDS = 5
TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Singapore", "Europe/London",
    "Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"]
GROUPS = {"retrieval": "检索", "chunking": "分片", "answer": "回答流程", "memory": "对话记忆", "inspection": "知识巡检", "general": "通用",
    "service": "模型服务"}
# 每组放在设置页的哪个页签：rag 是检索、回答和模型调用相关的参数，system 是和 RAG 无关的系统设置。
PAGES = {"retrieval": "rag", "chunking": "rag", "answer": "rag", "memory": "rag", "inspection": "rag", "service": "rag", "general": "system"}


# 默认值的来由（页面上的说明在 frontend/src/SystemSettings.tsx）：
#   rerank_min_score 0.85：开发集阈值扫描，0.85 时可回答题召回仍为 1.0，无法回答题漏放率从 0.625 降到 0.25；
#   rerank_candidates 12：12 与 20 的召回都是 1.0，12 平均耗时约 9.2 秒（20 约 13.6 秒），漏放率从 0.625 降到 0.5；
#   return_limit 6：常见取值，离线评测里 1–12 召回都是 1.0，主要控制输入长度；
#   parent_max_chars 2400 / parent_radius 3：父块约三个 800 字分片；
#   rrf_k 60：论文和 Milvus、Elasticsearch 的默认值；
#   embedding_timeout 120：CPU 上一批 64 段长文本可能超过原来的 20 秒；rerank_timeout 60：重排服务冷启动要加载模型；
#   chunk_context_max_tokens 1024：给推理模型的思考过程留额度；
#   chunk_size 800 / chunk_overlap 120：项目初始化时定的经验值，还没有评测依据。
#   intent_local 开：intent 服务和 api 一起部署（compose.yaml）；服务没起来时调用失败会直接交给大模型。
# 每一项：key、所属分组、类型（float / int / bool / choice）、代码默认值、允许范围。
SPECS = [
    {"key": "rerank_min_score", "group": "retrieval", "type": "float", "default": 0.85,
        "min": 0.0, "max": 1.0},
    {"key": "rerank_candidates", "group": "retrieval", "type": "int", "default": 12, "min": 5, "max": 50},
    {"key": "return_limit", "group": "retrieval", "type": "int", "default": 6, "min": 1, "max": 50},
    {"key": "parent_context", "group": "retrieval", "type": "bool", "default": True},
    {"key": "parent_max_chars", "group": "retrieval", "type": "int", "default": 2400, "min": 800, "max": 6000},
    {"key": "parent_radius", "group": "retrieval", "type": "int", "default": 3, "min": 1, "max": 10},
    {"key": "rerank_enabled", "group": "retrieval", "type": "bool", "default": True},
    {"key": "rrf_k", "group": "retrieval", "type": "int", "default": 60, "min": 1, "max": 200, "advanced": True},
    # 分片大小和重叠只在切分文档时用，改了只影响之后导入的文档；已导入的分片不变。
    {"key": "chunk_size", "group": "chunking", "type": "int", "default": 800, "min": 200,
        "max": 2000},
    {"key": "chunk_overlap", "group": "chunking", "type": "int", "default": 120, "min": 0,
        "max": 600},
    {"key": "sufficiency_check", "group": "answer", "type": "bool", "default": True},
    {"key": "intent_local", "group": "answer", "type": "bool", "default": True},
    {"key": "contextual_retrieval", "group": "answer", "type": "bool", "default": True},
    {"key": "memory_trigger_tokens", "group": "memory", "type": "int", "default": 6000,
        "min": 800, "max": 16000},
    {"key": "memory_keep_tokens", "group": "memory", "type": "int", "default": 3000,
        "min": 200, "max": 8000},
    {"key": "gap_similarity", "group": "inspection", "type": "float", "default": 0.75,
        "min": 0.5, "max": 0.95},
    {"key": "content_min_negative", "group": "inspection", "type": "int",
        "default": 2, "min": 1, "max": 20},
    {"key": "content_min_rate", "group": "inspection", "type": "float",
        "default": 0.3, "min": 0.1, "max": 1.0},
    {"key": "near_miss_ratio", "group": "inspection", "type": "float",
        "default": 0.5, "min": 0.1, "max": 0.9},
    {"key": "out_of_scope_score", "group": "inspection", "type": "float",
        "default": 0.05, "min": 0.0, "max": 0.3},
    {"key": "system_recheck_limit", "group": "inspection", "type": "int",
        "default": 5, "min": 0, "max": 20},
    {"key": "business_tz", "group": "general", "type": "choice", "default": "Asia/Shanghai",
        "choices": TIMEZONES},
    # 界面配色：blue 蓝调（默认），green 绿调（青绿）。只影响页面显示，所有用户一起切换。
    {"key": "ui_theme", "group": "general", "type": "choice", "default": "blue",
        "choices": ["blue", "green"]},
    {"key": "embedding_timeout", "group": "service", "type": "int", "default": 120,
        "min": 10, "max": 600},
    {"key": "rerank_timeout", "group": "service", "type": "int", "default": 60,
        "min": 5, "max": 300},
    {"key": "chunk_context_max_tokens", "group": "retrieval", "type": "int",
        "default": 1024, "min": 256, "max": 4096, "advanced": True},
]
BY_KEY = {spec["key"]: spec for spec in SPECS}

_engine = None
_cache = {"at": 0.0, "saved": None}
_lock = threading.Lock()


# api、worker 启动时把数据库连接交给这里；没绑定（脚本、部分测试）时只用默认值。
def bind(engine):
    global _engine
    _engine = engine
    clear_cache()


# 当前绑定的数据库连接；评测题目等也存在同一个库里，没传连接的调用用它。
def bound_engine():
    return _engine


def clear_cache():
    with _lock:
        _cache.update(at=0.0, saved=None)


# 读数据库里保存的值，缓存 CACHE_SECONDS 秒。读失败（库连不上、表还没建）时当作没有保存过，不影响问答。
def saved_values():
    now = time.monotonic()
    with _lock:
        if _cache["saved"] is not None and now - _cache["at"] < CACHE_SECONDS:
            return _cache["saved"]
    values = {}
    if _engine is not None:
        from .mysql.tables import settings
        try:
            with _engine.connect() as connection:
                row = connection.execute(select(settings.c.value).where(settings.c.key == SETTING_KEY)).first()
            values = dict(row[0]) if row and isinstance(row[0], dict) else {}
        except Exception:
            logger.warning("runtime_settings_read_failed", exc_info=True)
            values = {}
    with _lock:
        _cache.update(at=now, saved=values)
    return values


# 一项的当前值和来源：settings（设置页改过）、default（代码默认值）。
def resolve(spec, saved=None):
    saved = saved_values() if saved is None else saved
    if spec["key"] in saved:
        try:
            return check(spec, saved[spec["key"]], strict=False), "settings"
        except ValueError:
            logger.warning("runtime_setting_invalid key=%s", spec["key"])
    return spec["default"], "default"


def value(key):
    return resolve(BY_KEY[key])[0]


# 一次读出全部参数。一次问答开始时取一份，整条流程都用它，不会前半段用旧值、后半段用新值。
def snapshot():
    saved = saved_values()
    return {spec["key"]: resolve(spec, saved)[0] for spec in SPECS}


# 校验一个值的类型和范围。strict=False 用于读取数据库里的旧值：只检查类型，范围变了也不让问答出错。
def check(spec, raw, strict=True):
    kind = spec["type"]
    if kind == "bool":
        if not isinstance(raw, bool):
            raise ValueError(f"{spec['key']} 必须是开或关")
        return raw
    if kind == "choice":
        if not isinstance(raw, str) or (raw not in spec["choices"] and spec["key"] != "business_tz"):
            raise ValueError(f"{spec['key']} 不是可选的值")
        if spec["key"] == "business_tz" and raw not in available_timezones():
            raise ValueError(f"未知时区：{raw}")
        return raw
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{spec['key']} 必须是数字")
    number = int(raw) if kind == "int" else float(raw)
    if kind == "int" and number != raw:
        raise ValueError(f"{spec['key']} 必须是整数")
    if strict and not spec["min"] <= number <= spec["max"]:
        raise ValueError(f"{spec['key']} 要在 {spec['min']} 到 {spec['max']} 之间")
    return number


# 参数之间的约束：交给模型的段数不能超过候选池；压缩后保留的原文最多是压缩阈值的一半
# （否则压缩完仍然接近或超过阈值，下一轮又要压缩，等于每轮都多调一次大模型）；
# 分片重叠最多是分片大小的三分之一（切分时也按这个上限截断），否则相邻分片大半内容重复。
def check_relations(values):
    if values["chunk_overlap"] * 3 > values["chunk_size"]:
        raise ValueError("分片重叠不能超过分片大小的三分之一")
    if values["return_limit"] > values["rerank_candidates"]:
        raise ValueError("交给模型的段数不能超过候选池大小")
    if values["memory_keep_tokens"] * 2 > values["memory_trigger_tokens"]:
        raise ValueError("压缩后保留的原文最多是压缩阈值的一半")


# 设置页展示：每一项的当前值、是否改过和默认值。
def view(engine=None):
    saved = saved_values()
    items = []
    for spec in SPECS:
        current, source = resolve(spec, saved)
        item = {key: spec[key] for key in ("key", "group", "type", "default") if key in spec}
        item.update({"value": current, "source": source,
            "advanced": bool(spec.get("advanced"))})
        for key in ("min", "max", "choices"):
            if key in spec:
                item[key] = spec[key]
        items.append(item)
    history = []
    target = engine or _engine
    if target is not None:
        from .mysql.tables import settings
        with target.connect() as connection:
            row = connection.execute(select(settings.c.value).where(settings.c.key == HISTORY_KEY)).first()
        history = (row[0] or {}).get("items", []) if row else []
    return {"items": items, "groups": GROUPS, "pages": PAGES, "history": history[:10], "cache_seconds": CACHE_SECONDS}


# 保存设置页的修改。changes：{key: 新值}，值为 None 表示恢复默认（删除设置页的值，回到代码默认值）。
# 保存前把修改合进当前生效的值整体检查一遍约束；同时记一条修改历史（谁、什么时候、旧值、新值）。
def save(engine, changes, username):
    from .mysql.tables import settings
    unknown = [key for key in changes if key not in BY_KEY]
    if unknown:
        raise ValueError("未知参数：" + "、".join(unknown))
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as connection:
        row = connection.execute(select(settings.c.value).where(settings.c.key == SETTING_KEY)).first()
        stored = dict(row[0]) if row and isinstance(row[0], dict) else {}
        before = {spec["key"]: resolve(spec, stored)[0] for spec in SPECS}
        for key, raw in changes.items():
            if raw is None:
                stored.pop(key, None)
            else:
                stored[key] = check(BY_KEY[key], raw)
        after = {spec["key"]: resolve(spec, stored)[0] for spec in SPECS}
        check_relations(after)
        changed = [{"key": key, "before": before[key], "after": after[key]} for key in changes if before[key] != after[key]]
        if row is None:
            connection.execute(settings.insert().values(key=SETTING_KEY, value=stored, updated=now))
        else:
            connection.execute(settings.update().where(settings.c.key == SETTING_KEY).values(value=stored, updated=now))
        if changed:
            history_row = connection.execute(select(settings.c.value).where(settings.c.key == HISTORY_KEY)).first()
            items = list((history_row[0] or {}).get("items", [])) if history_row else []
            items.insert(0, {"at": now, "by": username, "changes": changed})
            value = {"items": items[:HISTORY_LIMIT]}
            if history_row is None:
                connection.execute(settings.insert().values(key=HISTORY_KEY, value=value, updated=now))
            else:
                connection.execute(settings.update().where(settings.c.key == HISTORY_KEY).values(value=value, updated=now))
    clear_cache()
    return changed
