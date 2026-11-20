from datetime import datetime, timezone

from sqlalchemy import select

from ..mysql.tables import graph_schemas


# 线上的图谱空间：所有线上文档的实体在这里跨文档合并。评测以后各用各的空间。
ONLINE_SPACE = "online"
DEFAULT_SCHEMA_ID = "default-v1"
# 抽取结果里的类型不在清单里时归到「其他」，不丢掉这个名字。
OTHER_TYPE = "其他"

# 内置的默认清单：大多数资料都会出现的几类实体。关系不规定类型，用一句话描述，另外标一个粗分类方便筛选。
DEFAULT_SCHEMA = {
    "id": DEFAULT_SCHEMA_ID,
    "name": "默认清单",
    "source": "default",
    "version": 1,
    "entity_types": [
        {
            "name": "人物",
            "description": "有名字的人，包括网名、昵称",
            "examples": [],
        },
        {
            "name": "组织",
            "description": "公司、机构、部门、基金等",
            "examples": [],
        },
        {
            "name": "产品",
            "description": "具体的产品、品牌、服务",
            "examples": [],
        },
        {
            "name": "作品",
            "description": "书、文章、演讲、电影等",
            "examples": [],
        },
        {
            "name": "地点",
            "description": "国家、城市、地区、具体场所",
            "examples": [],
        },
        {
            "name": "事件",
            "description": "有名字或有明确时间的事件",
            "examples": [],
        },
        {
            "name": "概念",
            "description": "反复出现的观点、方法、术语",
            "examples": [],
        },
    ],
    "relation_categories": [
        {"name": "创办", "description": "创立、创建、发起"},
        {"name": "投资", "description": "买入、卖出、持有、投资"},
        {"name": "任职", "description": "担任职务、在某处工作"},
        {"name": "隶属", "description": "属于、子公司、旗下、组成部分"},
        {"name": "评价", "description": "评价、看法、推荐、批评"},
        {"name": "参与", "description": "参加、经历、发生在"},
        {"name": "其他", "description": "以上都不是"},
    ],
    "note": "系统内置，适用于大多数资料；关系用一句话描述，粗分类只用于筛选。",
}

# 页面上「如何匹配」的说明：和 resolve.py 的规则保持一致。
MATCHING_RULES = {
    "normalize": [
        "全角转半角、去掉空格、英文统一小写（NFKC 规范化）",
        "组织类实体去掉常见后缀：股份有限公司、有限责任公司、有限公司、集团公司、集团、公司、Inc.、Ltd. 等",
        "去掉两边的书名号、引号",
    ],
    "merge": [
        "抽取时保留原名，并在资料明确支持时给出标准名",
        "先查已确认的别名表；未命中时，按「类型 + 规范化后的标准名」匹配已有实体，未匹配则新建",
        "模型给出的标准名仅用于本次归属判断，不自动写入别名表",
        "类型不同的实体不自动合并",
    ],
}


def now():
    return datetime.now(timezone.utc).isoformat()


def row_view(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "source": row["source"],
        "version": row["version"],
        "entity_types": row["entity_types"],
        "relation_categories": row["relation_categories"],
        "note": row["note"],
        "created_by": row["created_by"],
        "created": row["created"],
    }


# 默认清单 V1 原地修正：读取时同步内置内容，保留 id、版本和创建信息。
def ensure_default(engine):
    with engine.begin() as connection:
        exists = (
            connection.execute(
                select(graph_schemas).where(graph_schemas.c.id == DEFAULT_SCHEMA_ID)
            )
            .mappings()
            .first()
        )
        if exists is None:
            connection.execute(
                graph_schemas.insert().values(
                    **DEFAULT_SCHEMA, created_by="system", created=now()
                )
            )
        elif any(exists[key] != value for key, value in DEFAULT_SCHEMA.items()):
            connection.execute(
                graph_schemas.update()
                .where(graph_schemas.c.id == DEFAULT_SCHEMA_ID)
                .values(**DEFAULT_SCHEMA)
            )


def list_schemas(engine):
    ensure_default(engine)
    with engine.connect() as connection:
        rows = (
            connection.execute(select(graph_schemas).order_by(graph_schemas.c.created))
            .mappings()
            .all()
        )
    return [row_view(row) for row in rows]


def get_schema(engine, schema_id):
    ensure_default(engine)
    with engine.connect() as connection:
        row = (
            connection.execute(
                select(graph_schemas).where(graph_schemas.c.id == schema_id)
            )
            .mappings()
            .first()
        )
    return row_view(row) if row else None


# 清单填进提示词的样子：实体类型（说明、例子）和关系分类。改清单不用改提示词。
def render(schema):
    lines = ["实体类型（type 只能用下面这些名字，都不合适时用「其他」）："]
    for item in schema["entity_types"]:
        examples = "、".join(item.get("examples") or [])
        lines.append(
            f"- {item['name']}：{item['description']}"
            + (f"，例如 {examples}" if examples else "")
        )
    lines.append("关系分类（category 只能用下面这些名字）：")
    for item in schema["relation_categories"]:
        lines.append(f"- {item['name']}：{item['description']}")
    return "\n".join(lines)


def type_names(schema):
    return [item["name"] for item in schema["entity_types"]]


def category_names(schema):
    return [item["name"] for item in schema["relation_categories"]]
