from ..mysql.store import after_sales, customers, inventory, orders, products, promotions, reviews, shipments


# 数据管理页里每种业务数据的配置。前端表格和表单、后端校验、AI 生成的提示词、
# 聊天里 DataQueryTool 给大模型的"有哪些数据、哪些字段"说明，全部从这一份配置生成。
# 新增一种数据只需要在 store.py 建表、在这里加配置，不用每种数据各写一套接口和工具。
#
# 字段类型：string 短文本、text 长文本、int 整数、float 小数、enum 枚举、date 日期（YYYY-MM-DD）、ref 引用另一种数据的 id。
# 字段属性：
#   required    必填
#   options     枚举的可选值；让模型把"寄出了吗"映射到"已发货"时比自由文本准确得多
#   ref         引用的数据类型；表单用下拉选择，不能手填，AI 生成时由代码从已有数据里挑，不让模型编 id
#   derived     由代码计算，不能手填（例如订单金额 = 单价 × 数量，模型和人算都可能出错）
#   sensitive   敏感字段；没有该数据修改权限的人看到的是脱敏值，聊天回答里始终脱敏
#   aliases     同义词，意图识别和生成查询条件时用来把口语对应到字段
#   searchable  列表页的关键字搜索会匹配这个字段
#   default     录入时没有填写的默认值
#   tones       状态类枚举每个值的标签颜色（green/blue/orange/red/purple/gray/gold/silver/slate）；
#               以前状态在表格里只是纯文字，和普通字段看不出区别；配置在这里，新增枚举值只改配置不改前端。
#               分类类枚举（类目、仓库、快递公司、类型）没有好坏之分，不配置颜色，仍显示文字。
DATA_TYPES = {
    "products": {
        "label": "商品", "table": products, "id_prefix": "P", "display": "name",
        "description": "在售商品的名称、类目、价格和上下架状态",
        "keywords": ["商品", "产品", "价格", "上架", "下架", "类目"],
        "examples": ["价格低于 100 的商品有哪些", "数码类商品有几个", "哪些商品已下架"],
        "fields": [
            {"name": "name", "label": "商品名称", "type": "string", "required": True, "max_length": 100, "searchable": True},
            {"name": "category", "label": "类目", "type": "enum", "required": True,
                "options": ["数码", "家电", "服装", "食品", "美妆", "家居"]},
            {"name": "price", "label": "价格", "type": "float", "required": True, "min": 0, "aliases": ["单价", "售价", "多少钱"]},
            {"name": "status", "label": "状态", "type": "enum", "required": True, "options": ["上架", "下架"], "default": "上架",
                "tones": {"上架": "green", "下架": "gray"}},
            {"name": "description", "label": "商品描述", "type": "text", "max_length": 2000, "searchable": True},
        ],
    },
    "customers": {
        "label": "客户", "table": customers, "id_prefix": "C", "display": "name",
        "description": "客户的姓名、手机号、会员等级、城市和注册日期",
        "keywords": ["客户", "会员", "顾客", "用户等级"],
        "examples": ["VIP 客户有多少个", "上海的客户有哪些", "最近注册的客户"],
        "fields": [
            {"name": "name", "label": "姓名", "type": "string", "required": True, "max_length": 50, "searchable": True},
            {"name": "phone", "label": "手机号", "type": "string", "required": True, "max_length": 20,
                "pattern": r"^1\d{10}$", "sensitive": True, "searchable": True},
            {"name": "level", "label": "会员等级", "type": "enum", "required": True,
                "options": ["普通", "银卡", "金卡", "VIP"], "default": "普通", "aliases": ["等级", "会员"],
                "tones": {"普通": "gray", "银卡": "silver", "金卡": "gold", "VIP": "purple"}},
            {"name": "city", "label": "城市", "type": "string", "max_length": 50, "searchable": True},
            {"name": "registered_at", "label": "注册日期", "type": "date", "required": True, "aliases": ["注册时间"]},
        ],
    },
    "orders": {
        "label": "订单", "table": orders, "id_prefix": "A", "display": "id",
        "description": "订单的客户、商品、数量、金额、状态和下单日期",
        "keywords": ["订单"],
        "examples": ["这周有几单待发货", "已签收的订单有哪些", "本月订单总金额是多少"],
        "fields": [
            {"name": "customer_id", "label": "客户", "type": "ref", "ref": "customers", "required": True},
            {"name": "product_id", "label": "商品", "type": "ref", "ref": "products", "required": True},
            {"name": "quantity", "label": "数量", "type": "int", "required": True, "min": 1, "max": 999},
            {"name": "amount", "label": "金额", "type": "float", "derived": True, "aliases": ["总额", "总金额", "销售额"]},
            {"name": "status", "label": "状态", "type": "enum", "required": True,
                "options": ["待付款", "待发货", "已发货", "已签收", "已取消"], "default": "待付款",
                "aliases": ["发货", "签收"],
                "tones": {"待付款": "orange", "待发货": "blue", "已发货": "purple", "已签收": "green", "已取消": "gray"}},
            {"name": "ordered_at", "label": "下单日期", "type": "date", "required": True, "aliases": ["下单时间"]},
            {"name": "arrival", "label": "预计到货", "type": "string", "max_length": 100, "default": "待定"},
            # owner 是原来订单查询工具用的"订单归属用户"，保留下来：普通用户在聊天里仍能查自己的订单。
            {"name": "owner", "label": "归属用户", "type": "string", "max_length": 32, "searchable": True},
        ],
    },
    "inventory": {
        "label": "库存", "table": inventory, "id_prefix": "I", "display": "id",
        "description": "各仓库里每个商品的当前库存和安全库存，库存低于安全库存表示快缺货",
        "keywords": ["库存", "缺货", "仓库", "安全库存", "补货"],
        "examples": ["哪些商品快缺货了", "上海仓的库存", "库存最少的商品"],
        # 同一商品在同一仓库只能有一条库存记录。
        "unique": ["product_id", "warehouse"],
        "fields": [
            {"name": "product_id", "label": "商品", "type": "ref", "ref": "products", "required": True},
            {"name": "warehouse", "label": "仓库", "type": "enum", "required": True, "options": ["上海仓", "北京仓", "广州仓"]},
            {"name": "quantity", "label": "当前库存", "type": "int", "required": True, "min": 0, "max": 1000000},
            {"name": "safety_stock", "label": "安全库存", "type": "int", "required": True, "min": 0, "max": 1000000},
        ],
    },
    "shipments": {
        "label": "物流单", "table": shipments, "id_prefix": "S", "display": "tracking_no",
        "description": "订单的快递公司、运单号、物流状态、发货和签收日期",
        "keywords": ["物流", "快递", "运单", "派送", "揽收"],
        "examples": ["运输中的物流单有几个", "顺丰的快递有哪些", "A1001 的快递到哪了"],
        "unique": ["tracking_no"],
        "fields": [
            {"name": "order_id", "label": "订单", "type": "ref", "ref": "orders", "required": True},
            {"name": "carrier", "label": "快递公司", "type": "enum", "required": True, "options": ["顺丰", "中通", "圆通", "京东物流"]},
            {"name": "tracking_no", "label": "运单号", "type": "string", "required": True, "max_length": 40, "searchable": True},
            {"name": "status", "label": "物流状态", "type": "enum", "required": True,
                "options": ["已揽收", "运输中", "派送中", "已签收"], "default": "已揽收",
                "tones": {"已揽收": "slate", "运输中": "blue", "派送中": "purple", "已签收": "green"}},
            {"name": "shipped_at", "label": "发货日期", "type": "date", "required": True},
            {"name": "delivered_at", "label": "签收日期", "type": "date"},
        ],
    },
    "after_sales": {
        "label": "售后工单", "table": after_sales, "id_prefix": "R", "display": "id",
        "description": "订单的退货、换货、退款工单，包括原因、金额、处理状态和处理人",
        "keywords": ["售后", "工单", "退款单", "退货单", "换货单"],
        "examples": ["这周退款的有几单", "待处理的售后工单", "退款总金额是多少"],
        "fields": [
            {"name": "order_id", "label": "订单", "type": "ref", "ref": "orders", "required": True},
            {"name": "type", "label": "类型", "type": "enum", "required": True, "options": ["退货", "换货", "退款"]},
            {"name": "reason", "label": "原因", "type": "string", "required": True, "max_length": 200, "searchable": True},
            {"name": "amount", "label": "退款金额", "type": "float", "required": True, "min": 0},
            {"name": "status", "label": "处理状态", "type": "enum", "required": True,
                "options": ["待处理", "处理中", "已完成", "已拒绝"], "default": "待处理",
                "tones": {"待处理": "orange", "处理中": "blue", "已完成": "green", "已拒绝": "red"}},
            {"name": "handler", "label": "处理人", "type": "string", "max_length": 32, "searchable": True},
        ],
    },
    "promotions": {
        "label": "促销活动", "table": promotions, "id_prefix": "M", "display": "name",
        "description": "满减、折扣、优惠券活动，适用商品为空表示全场，开始到结束日期之间为进行中",
        "keywords": ["促销", "活动", "优惠", "满减", "折扣", "优惠券"],
        "examples": ["现在有什么活动", "这个商品有优惠吗", "下周开始的促销"],
        "fields": [
            {"name": "name", "label": "活动名称", "type": "string", "required": True, "max_length": 100, "searchable": True},
            {"name": "type", "label": "类型", "type": "enum", "required": True, "options": ["满减", "折扣", "优惠券"]},
            {"name": "product_id", "label": "适用商品", "type": "ref", "ref": "products"},
            {"name": "rule", "label": "优惠规则", "type": "string", "required": True, "max_length": 100, "searchable": True},
            {"name": "start_date", "label": "开始日期", "type": "date", "required": True},
            {"name": "end_date", "label": "结束日期", "type": "date", "required": True},
        ],
    },
    "reviews": {
        "label": "商品评价", "table": reviews, "id_prefix": "V", "display": "id",
        "description": "客户对商品的评分（1～5 分，1～2 分为差评，4～5 分为好评）和评价内容",
        "keywords": ["评价", "差评", "好评", "评分", "评论"],
        "examples": ["差评有哪些", "这个商品的平均评分", "最近的好评"],
        "fields": [
            {"name": "product_id", "label": "商品", "type": "ref", "ref": "products", "required": True},
            {"name": "customer_id", "label": "客户", "type": "ref", "ref": "customers", "required": True},
            {"name": "rating", "label": "评分", "type": "int", "required": True, "min": 1, "max": 5, "aliases": ["分数", "星级"]},
            {"name": "content", "label": "评价内容", "type": "text", "required": True, "max_length": 2000, "searchable": True},
            {"name": "reviewed_at", "label": "评价日期", "type": "date", "required": True},
        ],
    },
}

# 系统字段：由服务端填写，客户端和模型都不能指定。
SYSTEM_FIELDS = ["id", "created_by", "created", "updated", "deleted_at", "source", "batch_id"]
ACTIONS = ["read", "create", "update", "delete"]


# 按名称找到一种数据的某个字段配置，找不到返回 None。
def find_field(data_type, name):
    for field in DATA_TYPES[data_type]["fields"]:
        if field["name"] == name:
            return field
    return None


# 返回给前端和大模型的配置：去掉 SQLAlchemy 表对象，只保留可以序列化的内容。
def public_schema(data_type):
    config = DATA_TYPES[data_type]
    fields = []
    for field in config["fields"]:
        fields.append(dict(field))
    return {"key": data_type, "label": config["label"], "description": config["description"],
        "id_prefix": config["id_prefix"], "display": config["display"], "examples": config["examples"],
        "fields": fields}
