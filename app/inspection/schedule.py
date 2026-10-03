# 定时巡检：管理员在「知识巡检」页设置频率，worker 定期检查是否到点并执行。
# 设置存在 settings 表（key=inspection_schedule），API 和 worker 读同一份，改完不用重启。
from datetime import datetime, timedelta, timezone
import logging
import os
import re
from threading import Thread
import time
from zoneinfo import ZoneInfo

from sqlalchemy import select

from ..mysql.store import inspection_runs, settings
from .service import InspectionBusy, run_inspection, settings as inspection_settings


logger = logging.getLogger("production-rag-inspection")

SETTING_KEY = "inspection_schedule"
# 每天固定时间按业务时区计算，和数据管理用的是同一个时区配置。
BUSINESS_TZ = os.getenv("BUSINESS_TZ", "Asia/Shanghai")
MODES = {"daily", "interval"}
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# worker 多久检查一次是否到点；到点后最多晚这么久执行。
CHECK_SECONDS = 30


def default_schedule():
    return {"enabled": False, "mode": "daily", "time": "08:00", "interval_hours": 24,
        "days": inspection_settings()["days"]}


# 读取设置；没保存过时返回默认值（关闭）。updated 是最后保存时间，计算第一次执行时间要用。
def load_schedule(store):
    with store.engine.connect() as connection:
        row = connection.execute(select(settings.c.value, settings.c.updated).where(
            settings.c.key == SETTING_KEY)).first()
    schedule = default_schedule()
    updated = None
    if row is not None:
        schedule.update(row[0] or {})
        updated = row[1]
    schedule["updated"] = updated
    return schedule


# 校验并保存设置，返回保存后的值；不合法时抛 ValueError，由接口转成 422。
def save_schedule(store, value, username):
    schedule = default_schedule()
    schedule.update({key: value[key] for key in ("enabled", "mode", "time", "interval_hours", "days") if key in value})
    if schedule["mode"] not in MODES:
        raise ValueError("频率只能是每天固定时间或每隔几小时")
    if not TIME_PATTERN.match(str(schedule["time"])):
        raise ValueError("时间格式应为 HH:MM")
    if not 1 <= int(schedule["interval_hours"]) <= 168:
        raise ValueError("间隔应在 1～168 小时之间")
    if not 1 <= int(schedule["days"]) <= 365:
        raise ValueError("扫描范围应在 1～365 天之间")
    schedule["enabled"] = bool(schedule["enabled"])
    schedule["interval_hours"] = int(schedule["interval_hours"])
    schedule["days"] = int(schedule["days"])
    schedule["updated_by"] = username
    now = datetime.now(timezone.utc).isoformat()
    with store.engine.begin() as connection:
        changed = connection.execute(settings.update().where(settings.c.key == SETTING_KEY).values(
            value=schedule, updated=now)).rowcount
        if not changed:
            connection.execute(settings.insert().values(key=SETTING_KEY, value=schedule, updated=now))
    schedule["updated"] = now
    return schedule


def parse_time(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# 下一次执行时间（UTC）。从"上次定时巡检"和"最后保存设置"中较晚的那个时间算起：
# 刚打开或改了设置时不会立刻补跑一次，管理员手动点的"立即巡检"也不影响定时节奏。
#   每隔 N 小时：起点 + N 小时；
#   每天 HH:MM：起点之后第一个 HH:MM（按业务时区）。
def next_run(schedule, last_scheduled=None):
    if not schedule.get("enabled"):
        return None
    anchors = [time for time in (parse_time(last_scheduled), parse_time(schedule.get("updated"))) if time]
    anchor = max(anchors) if anchors else datetime.now(timezone.utc)
    if schedule.get("mode") == "interval":
        return anchor + timedelta(hours=int(schedule.get("interval_hours") or 24))
    zone = ZoneInfo(BUSINESS_TZ)
    hour, minute = (int(part) for part in str(schedule.get("time") or "08:00").split(":"))
    local = anchor.astimezone(zone)
    slot = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if slot <= local:
        slot = slot + timedelta(days=1)
    return slot.astimezone(timezone.utc)


def last_scheduled_run(store):
    with store.engine.connect() as connection:
        return connection.execute(select(inspection_runs.c.started).where(
            inspection_runs.c.trigger == "schedule").order_by(inspection_runs.c.started.desc()).limit(1)).scalar()


# 页面显示用：设置、下一次执行时间、上一次定时巡检时间和业务时区。
def schedule_view(store):
    schedule = load_schedule(store)
    last = last_scheduled_run(store)
    upcoming = next_run(schedule, last)
    return {"schedule": schedule, "next_run": upcoming.isoformat() if upcoming else None,
        "last_scheduled_run": last, "timezone": BUSINESS_TZ}


# worker 每轮调用：到点就在后台线程执行一次巡检，不阻塞文档导入队列。返回是否启动了巡检。
class ScheduleRunner:
    def __init__(self, store, models):
        self.store = store
        self.models = models
        self.thread = None
        self.checked_at = 0.0

    def tick(self, now=None, monotonic=None):
        current = monotonic if monotonic is not None else time.monotonic()
        if current - self.checked_at < CHECK_SECONDS and self.checked_at:
            return False
        self.checked_at = current
        if self.thread is not None and self.thread.is_alive():
            return False
        schedule = load_schedule(self.store)
        upcoming = next_run(schedule, last_scheduled_run(self.store))
        if upcoming is None or upcoming > (now or datetime.now(timezone.utc)):
            return False
        self.thread = Thread(target=self.run, args=(schedule["days"],), daemon=True)
        self.thread.start()
        return True

    def run(self, days):
        try:
            result = run_inspection(self.store, self.models, trigger="schedule", days=days)
            logger.info("scheduled_inspection_done run_id=%s summary=%s", result["id"], result["summary"])
        except InspectionBusy:
            # 管理员正好手动在跑：这次跳过，下一轮检查时还没有定时巡检记录，会再试。
            logger.info("scheduled_inspection_skipped reason=busy")
        except Exception:
            logger.exception("scheduled_inspection_failed")
