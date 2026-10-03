from datetime import date, datetime, timezone
import re
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from ..mysql.store import data_audit, data_permissions
from ..runtime_config import value as runtime_value
from .schema import ACTIONS, DATA_TYPES, SYSTEM_FIELDS, find_field


# "今天""这周"要按业务所在时区换算。服务器（容器）通常是 UTC，直接用 date.today()
# 在北京时间早上 8 点前会把"今天"算成前一天，所以单独配置业务时区。
# 时区在设置页修改（见 app/runtime_config.py），每次计算"今天"时读取。
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PAGE_SIZE_LIMIT = 100


class DataError(Exception):
    """数据校验或权限错误；errors 按字段给出原因，前端可以标在对应输入框上。"""

    def __init__(self, message, errors=None, status=422):
        super().__init__(message)
        self.message = message
        self.errors = errors or {}
        self.status = status


def now_text():
    return datetime.now(timezone.utc).isoformat()


# 业务时区的今天。
def today():
    return datetime.now(ZoneInfo(runtime_value("business_tz"))).date()


# 返回用户对每种数据的权限：{数据类型: {"read", "create", ...}}。
# 管理员拥有全部权限；普通用户是所在各部门权限的并集。每次都查数据库，改了权限立即生效。
def user_permissions(engine, user):
    result = {}
    for data_type in DATA_TYPES:
        result[data_type] = set()
    if user["is_admin"]:
        for data_type in DATA_TYPES:
            result[data_type] = set(ACTIONS)
        return result
    if not user["groups"]:
        return result
    with engine.connect() as connection:
        rows = connection.execute(select(data_permissions).where(
            data_permissions.c.group_id.in_(user["groups"]))).mappings().all()
    for row in rows:
        if row["data_type"] not in result:
            continue
        for action in ACTIONS:
            if row[f"can_{action}"]:
                result[row["data_type"]].add(action)
    return result


# 没有权限时抛出 403。页面上隐藏按钮只是体验，真正的限制在这里。
def require(permissions, data_type, action):
    if data_type not in DATA_TYPES:
        raise DataError("数据类型不存在", status=404)
    if action not in permissions[data_type]:
        labels = {"read": "查看", "create": "新增", "update": "修改", "delete": "删除"}
        raise DataError(f"没有{labels[action]}{DATA_TYPES[data_type]['label']}的权限", status=403)


# 手机号只保留前 3 位和后 4 位。
def mask(value):
    if not value:
        return value
    text = str(value)
    if len(text) <= 7:
        return "*" * len(text)
    return text[:3] + "*" * (len(text) - 7) + text[-4:]


# 未删除的行。
def active(table):
    return table.c.deleted_at.is_(None)


# 读取一条未删除的记录，不存在返回 None。
def fetch(connection, data_type, record_id):
    table = DATA_TYPES[data_type]["table"]
    return connection.execute(select(table).where(table.c.id == record_id, active(table))).mappings().first()


# 把一个输入值转换成字段类型并校验，返回 (值, 错误信息)。空值统一转成 None。
def convert(connection, field, value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    kind = field["type"]
    if kind in {"string", "text", "enum", "ref", "date"}:
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            return None, "格式不正确"
        value = str(value).strip()
        if len(value) > field.get("max_length", 200):
            return None, f"不能超过 {field.get('max_length', 200)} 个字符"
    if kind == "enum" and value not in field["options"]:
        return None, "只能是：" + "、".join(field["options"])
    if kind == "date":
        if not DATE_PATTERN.match(value):
            return None, "日期格式应为 YYYY-MM-DD"
        try:
            date.fromisoformat(value)
        except ValueError:
            return None, "日期不存在"
    if kind == "string" and field.get("pattern") and not re.match(field["pattern"], value):
        return None, "格式不正确"
    if kind == "ref":
        target = fetch(connection, field["ref"], value)
        if target is None:
            return None, f"{DATA_TYPES[field['ref']]['label']} {value} 不存在"
    if kind in {"int", "float"}:
        # bool 是 int 的子类，True 会被当成 1，这里单独排除。
        if isinstance(value, bool):
            return None, "应为数字"
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None, "应为数字"
        if kind == "int":
            if number != int(number):
                return None, "应为整数"
            number = int(number)
        else:
            number = round(number, 2)
        if "min" in field and number < field["min"]:
            return None, f"不能小于 {field['min']}"
        if "max" in field and number > field["max"]:
            return None, f"不能大于 {field['max']}"
        value = number
    return value, None


# 校验一条记录并返回可以写入数据库的值。
# values 只能包含配置里的非派生字段：系统字段、派生字段和未知字段一律拒绝，客户端不能伪造创建人或金额。
# existing 是修改前的记录（新增时为 None），修改时只校验传入的字段，但跨字段规则按合并后的完整记录检查。
def validate(connection, data_type, values, existing=None, username=None):
    config = DATA_TYPES[data_type]
    errors = {}
    clean = {}
    if not isinstance(values, dict):
        raise DataError("数据格式不正确")
    for name, value in values.items():
        field = find_field(data_type, name)
        if field is None or field.get("derived") or name in SYSTEM_FIELDS:
            errors[name] = "该字段不能填写"
            continue
        converted, error = convert(connection, field, value)
        if error:
            errors[name] = error
        else:
            clean[name] = converted
    merged = dict(existing or {})
    merged.update(clean)
    for field in config["fields"]:
        name = field["name"]
        if merged.get(name) is None and "default" in field and existing is None:
            clean[name] = field["default"]
            merged[name] = field["default"]
        if field.get("required") and merged.get(name) is None and name not in errors:
            errors[name] = "必填"
    # 订单归属用户默认是录入人：原来的订单工具按它判断"自己的订单"。
    if data_type == "orders" and not merged.get("owner") and existing is None:
        clean["owner"] = username
        merged["owner"] = username
    if not errors:
        check_rules(connection, data_type, merged, errors)
    if not errors:
        check_unique(connection, data_type, merged, existing, errors)
    if errors:
        raise DataError("数据校验未通过", errors)
    add_derived(connection, data_type, merged, clean)
    return clean


# 跨字段的业务规则。这些规则人工录入和 AI 生成都可能违反，统一在服务端检查。
def check_rules(connection, data_type, record, errors):
    if data_type == "shipments" and record.get("delivered_at") and record["delivered_at"] < record["shipped_at"]:
        errors["delivered_at"] = "签收日期不能早于发货日期"
    if data_type == "promotions" and record["end_date"] < record["start_date"]:
        errors["end_date"] = "结束日期不能早于开始日期"
    if data_type == "after_sales":
        order = fetch(connection, "orders", record["order_id"])
        if order is not None and order["amount"] is not None and record["amount"] > order["amount"]:
            errors["amount"] = f"退款金额不能超过订单金额 {order['amount']}"


# 按配置的 unique 字段组合检查重复，只和未删除的其他记录比较。
def check_unique(connection, data_type, record, existing, errors):
    config = DATA_TYPES[data_type]
    names = config.get("unique")
    if not names:
        return
    table = config["table"]
    conditions = [active(table)]
    for name in names:
        conditions.append(table.c[name] == record.get(name))
    if existing is not None:
        conditions.append(table.c.id != existing["id"])
    found = connection.execute(select(table.c.id).where(*conditions)).first()
    if found is not None:
        labels = []
        for name in names:
            labels.append(find_field(data_type, name)["label"])
        errors[names[-1]] = "、".join(labels) + f"与 {found[0]} 重复"


# 计算派生字段：订单金额 = 商品单价 × 数量，不接受客户端或模型给出的金额。
def add_derived(connection, data_type, record, clean):
    if data_type != "orders":
        return
    if "product_id" not in clean and "quantity" not in clean:
        return
    product = fetch(connection, "products", record["product_id"])
    if product is not None and record.get("quantity") is not None:
        clean["amount"] = round(product["price"] * record["quantity"], 2)


# 生成下一个编号：前缀 + 至少 4 位序号，例如 P0001；订单沿用演示数据的 A1001 格式。
# 并发写入时两个请求可能算出同一个编号，主键冲突会让后提交的一方失败，由调用方重试。
def next_id(connection, data_type):
    config = DATA_TYPES[data_type]
    table = config["table"]
    prefix = config["id_prefix"]
    largest = 0
    ids = connection.execute(select(table.c.id).where(table.c.id.like(prefix + "%"))).scalars().all()
    for record_id in ids:
        digits = record_id[len(prefix):]
        if digits.isdigit():
            largest = max(largest, int(digits))
    return f"{prefix}{largest + 1:04d}"


def audit(connection, data_type, record_id, action, username, changes=None):
    connection.execute(data_audit.insert().values(id=str(uuid4()), data_type=data_type, record_id=record_id,
        action=action, username=username, changes=changes, created=now_text()))


# 新增一条记录，返回新记录的 id。source 为 manual 或 ai。
def create_record(engine, data_type, values, username, source="manual", batch_id=None):
    table = DATA_TYPES[data_type]["table"]
    # 编号按"当前最大号 + 1"生成，两个请求同时新增会算出同一个编号，后提交的一方主键冲突；重新算编号再试，最多 3 次。
    for attempt in range(3):
        try:
            with engine.begin() as connection:
                clean = validate(connection, data_type, values, username=username)
                record_id = next_id(connection, data_type)
                now = now_text()
                connection.execute(table.insert().values(id=record_id, created_by=username, created=now,
                    updated=now, source=source, batch_id=batch_id, **clean))
                audit(connection, data_type, record_id, "create", username, clean)
            return record_id
        except IntegrityError:
            if attempt == 2:
                raise DataError("编号冲突，请重试", status=409)


# 批量写入 AI 生成并经用户确认的记录。每一行都重新校验（不信任前端传回的预览结果），
# 校验失败的行跳过并返回原因，其余照常写入。
def create_batch(engine, data_type, rows, username):
    batch_id = str(uuid4())
    created = []
    failed = []
    for index, row in enumerate(rows):
        try:
            created.append(create_record(engine, data_type, row, username, source="ai", batch_id=batch_id))
        except DataError as error:
            failed.append({"index": index, "message": error.message, "errors": error.errors})
    return {"batch_id": batch_id, "created": created, "failed": failed}


# 修改一条记录的部分字段。
def update_record(engine, data_type, record_id, values, username):
    table = DATA_TYPES[data_type]["table"]
    with engine.begin() as connection:
        existing = fetch(connection, data_type, record_id)
        if existing is None:
            raise DataError("记录不存在", status=404)
        clean = validate(connection, data_type, values, existing=dict(existing), username=username)
        if clean:
            connection.execute(table.update().where(table.c.id == record_id).values(updated=now_text(), **clean))
            audit(connection, data_type, record_id, "update", username, clean)


# 软删除一条记录。
def delete_record(engine, data_type, record_id, username):
    table = DATA_TYPES[data_type]["table"]
    with engine.begin() as connection:
        if fetch(connection, data_type, record_id) is None:
            raise DataError("记录不存在", status=404)
        connection.execute(table.update().where(table.c.id == record_id).values(deleted_at=now_text()))
        audit(connection, data_type, record_id, "delete", username)


# 软删除一批 AI 生成的记录，返回删除条数。
def delete_batch(engine, data_type, batch_id, username):
    table = DATA_TYPES[data_type]["table"]
    with engine.begin() as connection:
        ids = connection.execute(select(table.c.id).where(table.c.batch_id == batch_id, active(table))).scalars().all()
        if ids:
            connection.execute(table.update().where(table.c.id.in_(ids)).values(deleted_at=now_text()))
        for record_id in ids:
            audit(connection, data_type, record_id, "delete", username, {"batch_id": batch_id})
    return len(ids)


# 查出一组引用 id 对应的显示名称，例如客户 C0001 → 张三，列表里显示名称而不是一串编号。
def ref_labels(connection, data_type, ids):
    config = DATA_TYPES[data_type]
    table = config["table"]
    result = {}
    if not ids:
        return result
    rows = connection.execute(select(table.c.id, table.c[config["display"]]).where(table.c.id.in_(ids))).all()
    for row in rows:
        result[row[0]] = str(row[1])
    return result


# 把数据库行转换成接口返回的结构。没有修改权限的人看到的敏感字段是脱敏值。
def row_views(connection, data_type, rows, permissions):
    config = DATA_TYPES[data_type]
    reveal = "update" in permissions[data_type]
    labels = {}
    for field in config["fields"]:
        if field["type"] != "ref":
            continue
        ids = set()
        for row in rows:
            if row[field["name"]]:
                ids.add(row[field["name"]])
        labels[field["name"]] = ref_labels(connection, field["ref"], list(ids))
    result = []
    for row in rows:
        item = {"id": row["id"], "created_by": row["created_by"], "created": row["created"],
            "updated": row["updated"], "source": row["source"], "batch_id": row["batch_id"]}
        for field in config["fields"]:
            value = row[field["name"]]
            if field.get("sensitive") and not reveal:
                value = mask(value)
            item[field["name"]] = value
            if field["type"] == "ref" and value:
                item[field["name"] + "_label"] = labels[field["name"]].get(value, value)
        result.append(item)
    return result


# 列表查询：关键字搜索、来源和批次筛选、排序、分页。
def list_records(engine, data_type, permissions, q="", source=None, batch_id=None, sort=None, direction="desc",
                 page=1, page_size=20):
    config = DATA_TYPES[data_type]
    table = config["table"]
    conditions = [active(table)]
    keyword = (q or "").strip()
    if keyword:
        matches = [table.c.id.like(f"%{keyword}%")]
        for field in config["fields"]:
            # 敏感字段只允许有修改权限的人搜索，否则可以用"138"一类的片段反复试出完整手机号。
            if field.get("sensitive") and "update" not in permissions[data_type]:
                continue
            if field.get("searchable"):
                matches.append(table.c[field["name"]].like(f"%{keyword}%"))
        conditions.append(or_(*matches))
    if source in {"manual", "ai"}:
        conditions.append(table.c.source == source)
    if batch_id:
        conditions.append(table.c.batch_id == batch_id)
    sort_column = table.c.created
    if sort == "id" or (sort and find_field(data_type, sort)):
        sort_column = table.c[sort]
    order = sort_column.asc() if direction == "asc" else sort_column.desc()
    page_size = max(1, min(page_size, PAGE_SIZE_LIMIT))
    page = max(1, page)
    with engine.connect() as connection:
        total = connection.execute(select(func.count()).select_from(table).where(*conditions)).scalar()
        rows = connection.execute(select(table).where(*conditions).order_by(order, table.c.id.desc())
            .limit(page_size).offset((page - 1) * page_size)).mappings().all()
        items = row_views(connection, data_type, rows, permissions)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# 引用字段的下拉选项：按编号或显示名称搜索，最多返回 20 条。
def ref_options(engine, data_type, q="", limit=20):
    config = DATA_TYPES[data_type]
    table = config["table"]
    display = table.c[config["display"]]
    conditions = [active(table)]
    keyword = (q or "").strip()
    if keyword:
        conditions.append(or_(table.c.id.like(f"%{keyword}%"), display.like(f"%{keyword}%")))
    with engine.connect() as connection:
        rows = connection.execute(select(table.c.id, display).where(*conditions)
            .order_by(table.c.id.desc()).limit(limit)).all()
    options = []
    for row in rows:
        options.append({"id": row[0], "label": str(row[1])})
    return options


# 能否读取某种数据的下拉选项：能查看它，或者能新增/修改引用它的数据。
# 例如客服能新增订单，就要能在下拉框里选客户和商品，即使他没有商品管理的其他权限。
def can_pick(permissions, data_type):
    if "read" in permissions[data_type]:
        return True
    for owner_type, config in DATA_TYPES.items():
        writable = permissions[owner_type] & {"create", "update"}
        if not writable:
            continue
        for field in config["fields"]:
            if field.get("ref") == data_type:
                return True
    return False


# 管理员查看的权限矩阵：[{group_id, data_type, can_read, ...}]。
def permission_matrix(engine):
    with engine.connect() as connection:
        rows = connection.execute(select(data_permissions)).mappings().all()
    result = []
    for row in rows:
        result.append(dict(row))
    return result


# 覆盖保存一个部门对一种数据的权限；四项都为否时删除这一行。
def save_permission(engine, group_id, data_type, flags):
    if data_type not in DATA_TYPES:
        raise DataError("数据类型不存在", status=404)
    values = {}
    for action in ACTIONS:
        values[f"can_{action}"] = bool(flags.get(action))
    # 能增删改却不能查看的组合没有意义，页面上也无法操作，统一视为同时拥有查看权限。
    if values["can_create"] or values["can_update"] or values["can_delete"]:
        values["can_read"] = True
    with engine.begin() as connection:
        connection.execute(data_permissions.delete().where(data_permissions.c.group_id == group_id,
            data_permissions.c.data_type == data_type))
        if any(values.values()):
            connection.execute(data_permissions.insert().values(group_id=group_id, data_type=data_type, **values))
    return values
