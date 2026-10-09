from sqlalchemy import Boolean, Column, Float, Index, JSON, Integer, MetaData, String, Table, Text, UniqueConstraint, text


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
    # 历史记录按用户、会话取最近几条（ORDER BY created）。没有这两个索引时 MySQL 要把整行（含很大的 response JSON）
    # 放进排序缓冲区排序，记录一多就报 1038 Out of sort memory；有了索引直接按索引顺序读，不再排序。
    Index("ix_runs_owner_created", "owner", "created"),
    Index("ix_runs_session_owner_created", "session_id", "owner", "created"),
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
# 下面是业务数据页的其余业务表，字段含义、校验规则和中文名在 app/business/definitions.py 里配置。
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
    # 上架状态：false 是下架，当前版本保留但谁都检索不到。新版本上架时设为 true；升级前的文档都算已上架。
    Column("listed", Boolean, nullable=False, default=True, server_default=text("1")),
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
# 公开审核：普通用户把文档设为「所有人可见」，或给已公开的文档上传新版本，都要管理员审核通过后才生效。
# 公开文档会进入所有人的检索结果，里面藏的注入指令会影响所有人，所以不能由上传者自己决定。管理员上传的不需要审核。
# kind：publish 申请公开（通过后可见范围改成所有人，没通过之前保持原来的范围）；
#       version 公开文档的新版本（解析完先不切换，通过后才替换当前版本，没通过之前旧版本继续服务）。
# status：pending 待审核、approved 已通过、rejected 未通过、cancelled 已撤回（上传者改了可见范围）、
#         superseded 被同一文档更新的版本取代（只审最新的一版）。
document_reviews = Table("document_reviews", metadata,
    Column("id", String(36), primary_key=True),
    Column("doc_key", String(36), nullable=False, index=True),
    Column("kind", String(16), nullable=False),
    # 申请时对应的版本：version 审核的就是这一版；publish 审核的是通过时的当前版本，这里只记录申请时是哪一版。
    Column("document_id", String(36), nullable=False),
    Column("version", Integer),
    Column("chunk_count", Integer),
    Column("status", String(16), nullable=False, index=True),
    Column("requested_by", String(32), nullable=False),
    Column("created", String(32), nullable=False),
    Column("reviewed_by", String(32)),
    Column("reviewed", String(32)),
    Column("note", String(500)),
    # 上传者提交时写的说明（扫描有问题的版本，说明为什么没问题）。
    Column("request_note", String(500)),
)

# 知识巡检：定期从问答日志里收集问题（拒答、资料不足、差评、处理失败），合并成待处理清单，只有管理员可见。
# 每次巡检一行，记录时间窗口、执行状态和各类问题数量。
inspection_runs = Table("inspection_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("status", String(16), nullable=False),
    # cli 表示命令行（定时任务）发起，api 表示管理员在页面上发起。
    Column("trigger", String(16), nullable=False),
    Column("triggered_by", String(32)),
    # 本次扫描的问答起始时间，早于它的问答不再处理。
    Column("since", String(32), nullable=False),
    Column("summary", JSON),
    Column("error", String(500)),
    Column("started", String(32), nullable=False),
    Column("finished", String(32)),
)
# 合并后的问题。同一个问题由 fingerprint 识别：再次巡检时更新原记录、追加关联问答，不重复创建。
# kind：knowledge_gap 知识缺口（答不上来），suspect_content 可疑内容（被引用却常收到差评），system_error 系统问题。
# status：open 待处理；handled 管理员已处理、等待验证；resolved 已解决；ignored 已忽略。
# handled、resolved 之后又出现新的同类问答会自动重新打开；ignored 不会。
inspection_issues = Table("inspection_issues", metadata,
    Column("id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False, unique=True),
    Column("kind", String(32), nullable=False, index=True),
    Column("status", String(16), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    # 关联问答的条数和涉及的用户数，列表按它们排序：先处理最多人遇到的问题。
    Column("occurrences", Integer, nullable=False),
    Column("users", Integer, nullable=False),
    # 各类信号的计数和类型相关的展示信息（缺失内容、分片原文、错误信息等）。
    Column("detail", JSON),
    # 知识缺口的聚类中心，新问题与它比较相似度后决定归入哪个缺口；不返回给前端。
    Column("vector", JSON),
    Column("note", Text),
    # 标记"无需处理"（status=ignored）时选择的原因，见 app/inspection/service.py 的 CLOSE_REASONS；其他状态为空。
    Column("close_reason", String(32), index=True),
    # 标记"已处理"时选择的修复方式，见 FIX_TYPES；验证后自动变成已解决或重新打开时保留，手动改成其他状态时清空。
    Column("fix_type", String(32)),
    # 知识缺口最近一次拒答分类的结论（answerable、permission、routing、retrieval、content、out_of_scope、unknown），
    # 和 detail.diagnosis.category 相同，单独存一列是为了按类型筛选和计数。
    Column("diagnosis_category", String(16), index=True),
    Column("status_by", String(32)),
    Column("status_updated", String(32)),
    Column("first_seen", String(32), nullable=False),
    Column("last_seen", String(32), nullable=False),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)
# 问题与原始记录的关联：source 为 run（runs.id）或 error（run_errors.id）。
# 同一条问答只会挂到同一个问题一次，重复巡检不会重复计数。
inspection_issue_events = Table("inspection_issue_events", metadata,
    Column("issue_id", String(36), primary_key=True),
    Column("source", String(16), primary_key=True),
    Column("source_id", String(36), primary_key=True, index=True),
    Column("owner", String(32), nullable=False),
    # 这条问答命中的信号，如 refused、insufficient、negative_feedback。
    Column("signals", JSON, nullable=False),
    # 问答发生的时间，不是写入时间。
    Column("created", String(32), nullable=False),
)

# 巡检复测集：管理员自建、自定义名字的评测集，题目多数从知识巡检的问题加入。
# 和调参评测集、专项评测集不同：那两种跑在隔离的评测语料上；
# 巡检复测集的题目是真实用户的提问，按提问人的权限在线上知识库里跑，内容随知识库变化，所以存数据库、不进代码仓库。
eval_sets = Table("eval_sets", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(100), nullable=False, unique=True),
    Column("description", String(500)),
    Column("created_by", String(32), nullable=False),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)
# 巡检复测集的题目。expect：answer 应该回答，refuse 应该拒答。
# documents 是期望命中的文档 [{doc_key, title}]，用 doc_key 而不是分片：文档更新版本后分片会变，doc_key 不变。
# issue_id 记录题目来自哪个巡检问题，同一个问题在同一个评测集里只加一次。
eval_set_items = Table("eval_set_items", metadata,
    Column("id", String(36), primary_key=True),
    Column("set_id", String(36), nullable=False, index=True),
    Column("question", Text, nullable=False),
    Column("asker", String(32), nullable=False),
    Column("expect", String(16), nullable=False),
    Column("documents", JSON),
    Column("reference_answer", Text),
    Column("note", String(500)),
    Column("issue_id", String(36), index=True),
    Column("created_by", String(32), nullable=False),
    Column("created", String(32), nullable=False),
)
# 巡检复测集的每次运行。kind：retrieval 只检索，generation 完整问一遍再判断；results 是逐题结果。
eval_set_runs = Table("eval_set_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("set_id", String(36), nullable=False, index=True),
    Column("kind", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("triggered_by", String(32)),
    Column("summary", JSON),
    Column("results", JSON),
    Column("error", String(500)),
    Column("started", String(32), nullable=False),
    Column("finished", String(32)),
)

# 调参评测集：开发集 / 留出集的题目，在隔离的评测语料上衡量检索和回答质量，用来调参数。
# 以前放在 eval/dataset.jsonl 里随代码提交；现在存数据库，在页面上增删改、审核都不用改文件，
# 首次启动时从 eval/seed/dataset.jsonl 导入（见 app/evaluation/dataset.py 的 seed_eval_data）。
# 题目字段（问题、题型、证据、标准答案、追问历史、同义改写题对……）整体放在 data 里，id 是 q01、u01 这样的编号。
eval_items = Table("eval_items", metadata,
    Column("id", String(16), primary_key=True),
    Column("position", Integer, nullable=False),
    Column("data", JSON, nullable=False),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)
# 专项评测集：管理员自建，每个专项针对一个方向（例如分片超长被截断、多轮对话记忆），题目只属于这个专项，
# 不计入调参分数。method 是评测方式：retrieval 只检索，answer 完整回答再评审，dialogue 按顺序问完一段对话。
eval_suites = Table("eval_suites", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(64), nullable=False, unique=True),
    Column("description", String(500)),
    Column("method", String(16), nullable=False),
    # 检索、回答方式用哪几路检索：hybrid 向量 + 关键词（默认，和线上一样），dense 只用向量，keyword 只用关键词。
    Column("search_mode", String(16)),
    Column("created_by", String(32), nullable=False),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)
# 专项的题目，字段随评测方式不同放在 data 里：
#   retrieval：question、evidence；answer：再加 reference_answer；dialogue：turns、question、reference_answer。
eval_suite_items = Table("eval_suite_items", metadata,
    Column("id", String(36), primary_key=True),
    Column("suite_id", String(36), nullable=False, index=True),
    Column("position", Integer, nullable=False),
    Column("data", JSON, nullable=False),
    Column("created_by", String(32), nullable=False),
    Column("created", String(32), nullable=False),
    Column("updated", String(32), nullable=False),
)

# 评测记录（调参评测和专项评测）：编号是"日期时间_提交号"；brief 是列表要用的概要（配置、总览指标、进度），
# data 是完整结果（含逐题明细，可能有几兆）。以前存成 eval/results 下的 JSON 文件，首次启动时导入。
eval_runs = Table("eval_runs", metadata,
    Column("id", String(64), primary_key=True),
    Column("kind", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("created", String(40), nullable=False),
    Column("brief", JSON, nullable=False),
    Column("data", JSON, nullable=False),
    Column("updated", String(40), nullable=False),
)

# 提示词版本（见 app/prompts.py）：每次在「提示词」页保存生成一个新版本，只增不改；
# 当前使用哪个版本存在 settings 表（key = prompts），回滚只改那里。内置版本（v0）在代码里，不存这张表。
prompt_versions = Table("prompt_versions", metadata,
    Column("prompt_id", String(32), primary_key=True),
    Column("version", Integer, primary_key=True, autoincrement=False),
    Column("text", Text, nullable=False),
    Column("note", String(200), nullable=False, default=""),
    Column("created_by", String(32), nullable=False),
    Column("created", String(40), nullable=False),
)
