"""Agent 模式的工具层：把现有的检索、订单、业务数据查询包装成模型可以调用的工具。

每个工具做同样的四件事：
1. 校验模型给的参数，不合法时返回一句说明让模型自己改，不抛异常打断循环；
2. 注入身份：store、models、owner 由程序传入，不是工具参数，模型改不了；
3. 调用原来的函数（DocumentSearchTool、OrderTool、DataQueryTool），检索、权限、脱敏逻辑全部沿用；
4. 返回两份结果：content 是给模型看的带编号纯文本，trace 是完整结果，存进执行记录供页面展示。
"""

import inspect
import json
from dataclasses import dataclass, field

from .query_explanation import (
    QUERY_EXPLANATION_SCHEMA,
    RETRIEVAL_TOOLS,
    query_explanation,
    retrieval_arguments,
)

from ..business.service import DataError
from ..runtime_config import snapshot as runtime_snapshot
from ..security import sanitize_source
from ..tools.data_query import AGGREGATES, OPERATORS, ROW_LIMIT, DataQueryTool
from ..tools.orders import OrderTool
from ..tools.search import DocumentSearchTool

# 检索方式对应 DocumentSearchTool 的召回方式：hybrid 向量 + BM25，keyword 只用 BM25，vector 只用向量。
SEARCH_MODES = {
    "hybrid": ("dense", "keyword"),
    "keyword": ("keyword",),
    "vector": ("dense",),
}
# 每次要几条由模型自己定（top_k），不写默认 5 条；上限是设置页的 agent_return_limit，和固定流程的 return_limit 分开。
TOP_K_DEFAULT = 5
CONTEXT_COUNT_MAX = 3


class EvidencePool:
    """一次问答里所有工具返回的资料，统一编号：S 知识库、O 订单、D 业务数据。

    Agent 会多次调用工具，固定流程里每次检索都从 S1 开始编号，这里改成整次问答连续编号，
    回答里的 [S3] 才能唯一对应到一条资料。同一个分片被不同检索词再次命中时沿用原来的编号，不重复给模型。
    """

    def __init__(self):
        self.items = {}
        self.counters = {"S": 0, "O": 0, "D": 0}
        self.chunks = {}

    def add(self, prefix, item, chunk_id=None):
        if chunk_id is not None and chunk_id in self.chunks:
            return self.chunks[chunk_id], False
        self.counters[prefix] += 1
        evidence_id = f"{prefix}{self.counters[prefix]}"
        self.items[evidence_id] = item
        if chunk_id is not None:
            self.chunks[chunk_id] = evidence_id
        return evidence_id, True

    def get(self, evidence_id):
        return self.items.get(evidence_id)


@dataclass
class AgentContext:
    """一次问答的工具运行环境。身份和存储由服务端设置，模型只能通过工具参数影响查询内容。"""

    store: object
    models: object
    owner: str
    evidence: EvidencePool = field(default_factory=EvidencePool)
    search_tool: DocumentSearchTool = field(default_factory=DocumentSearchTool)
    order_tool: OrderTool = field(default_factory=OrderTool)
    data_tool: DataQueryTool = field(default_factory=DataQueryTool)


def result(content, ok=True, **trace):
    return {"content": content, "ok": ok, "trace": trace}


# 参数不合法时的统一返回：告诉模型哪里错了，让它下一轮自己修正。
def invalid(message):
    return result(f"参数错误：{message}", ok=False, error=message)


# ---------- search_knowledge ----------


def search_knowledge(ctx, query, mode="hybrid", top_k=TOP_K_DEFAULT):
    if not isinstance(query, str) or not query.strip():
        return invalid("query 不能为空")
    if mode not in SEARCH_MODES:
        return invalid(f"mode 只能是 {'、'.join(SEARCH_MODES)}")
    if isinstance(top_k, bool) or not isinstance(top_k, int):
        return invalid("top_k 应为整数")
    settings = runtime_snapshot()
    cap = settings["agent_return_limit"]
    requested = top_k
    top_k = max(1, min(top_k, cap))
    query = query.strip()
    # Agent 的检索词按提示词要求写成完整问句，所以重排也直接用它，不再另外补全问题。
    # 相关度阈值、返回上限、要不要父块扩展都用 Agent 自己的设置（agent_ 开头），和固定流程分开设。
    retrieval = ctx.search_tool.execute(
        ctx.store,
        ctx.models,
        ctx.owner,
        [query],
        query,
        methods=SEARCH_MODES[mode],
        min_score=settings["agent_rerank_min_score"],
        parent=settings["agent_parent_context"],
        return_limit=cap,
        excellent_score=settings["agent_excellent_score"],
    )
    # 过了相关度阈值的资料，最多给 agent_return_limit 条；模型要得更少（top_k）就再少取，不能绕过阈值。
    # 不低于 Agent 优秀阈值的资料全部给，不受模型自己要的 top_k 限制（检索那边也已经不受上限限制）。
    stats = retrieval.get("stats") or {}
    given = max(top_k, stats.get("excellent", 0))
    sources = retrieval["sources"][:given]
    # 过了阈值却没给模型的条数：超出上限被截掉的，加上模型自己要得少没取的。以前不说，模型以为拿到的就是全部。
    hidden = len(retrieval["sources"]) - len(sources) + stats.get("beyond_limit", 0)
    if not sources:
        return result(
            "没有找到相关资料。可以换一种问法，或者用 keyword 模式搜索名称、编号等原话。",
            query=query,
            mode=mode,
            top_k=top_k,
            given=0,
            evidence_ids=[],
            retrieval=retrieval,
        )
    blocks = []
    evidence_ids = []
    repeated = []
    for source in sources:
        # 原来的 id 是这次检索内的编号（每次从 S1 开始），换成整次问答的编号后不再保留。
        item = {key: value for key, value in source.items() if key != "id"}
        evidence_id, is_new = ctx.evidence.add(
            "S", {"type": "knowledge", **item}, chunk_id=source["chunk_id"]
        )
        evidence_ids.append(evidence_id)
        if not is_new:
            repeated.append(evidence_id)
            blocks.append(
                f"[{evidence_id}] 和前面返回的 {evidence_id} 是同一段资料，见上文。"
            )
            continue
        blocks.append(format_source(evidence_id, source))
    # 这次返回的资料前面全都给过：明确告诉模型这次检索没有新资料。原来只逐条写“同一段资料”，模型要自己比对编号，
    # 评测里常见换几种说法反复拿回同一批资料（无新增检索）。这里只给信息、不强制停，查不查由模型决定。
    if len(repeated) == len(evidence_ids):
        blocks.insert(
            0,
            f"这次检索没有新资料：返回的 {'、'.join(repeated)} 前面都已经给过。"
            "换说法再查大多还是拿回同一批资料；已有资料能回答用户的问题就直接回答，"
            "还缺某一部分时，只针对缺的那部分换一个角度查，或者用 keyword 模式查名称、编号、原话。",
        )
    truncated = truncation_note(
        requested, top_k, cap, hidden, len(sources), stats.get("excellent_score")
    )
    if truncated:
        blocks.insert(0, truncated)
    return result(
        "\n\n".join(blocks),
        query=query,
        mode=mode,
        top_k=top_k,
        requested_top_k=requested,
        given=len(sources),
        hidden=hidden,
        evidence_ids=evidence_ids,
        retrieval=retrieval,
        no_new=len(repeated) == len(evidence_ids),
    )


# 还有过了相关度阈值、没给模型的资料时，告诉它没给全、为什么没给全，下一步怎么做由它自己决定。
# given 比 top_k 多：多出来的是相关性不低于优秀阈值（excellent）的资料，也告诉模型为什么比它要的多。
def truncation_note(requested, top_k, cap, hidden, given=None, excellent=None):
    if given is not None and given > top_k:
        note = f"你要了 {top_k} 条，相关性 {excellent:.2f} 以上的资料有 {given} 条，都给你了。"
        if hidden > 0:
            note += f"另有 {hidden} 条相关性低一些、过了相关度线没有返回；需要时换一个更具体的说法再查。"
        return note
    if hidden <= 0:
        return ""
    if requested > cap:
        return (
            f"没有给全：你要了 {requested} 条，按设置每次最多返回 {cap} 条，另有 {hidden} 条过了相关度线没有返回。"
            "需要时换一个更具体的说法再查。"
        )
    if top_k < cap:
        return (
            f"没有给全：按你要的 {top_k} 条返回，另有 {hidden} 条过了相关度线没有返回；"
            f"需要时可以调大 top_k（最多 {cap}）再查。"
        )
    return f"没有给全：每次最多返回 {cap} 条，另有 {hidden} 条过了相关度线没有返回。需要时换一个更具体的说法再查。"


# 一条资料：编号、标题和小节，然后是正文（父块已带"标题路径"时正文里有完整路径）。
def format_source(evidence_id, source):
    head = f"[{evidence_id}] 《{source['title']}》"
    if source.get("heading"):
        head += f"· {source['heading']}"
    if source.get("relevance") is not None:
        head += f"（相关性 {source['relevance']:.2f}{'，相关性较低，仅供参考' if source.get('low_relevance') else ''}）"
    return f"{head}\n{source['text']}"


# ---------- read_context ----------


def read_context(ctx, source_id, direction="after", count=1):
    """读取一条知识库资料的前文或后文。

    只能读已经检索到的资料（S 编号），不接受任意文档 id：检索时已经按权限过滤过，
    所以能拿到 S 编号就说明有权查看这份文档，这里不用再查一次权限。
    读到的内容仍然沿用原来的编号，回答引用 [S1] 即可。
    """
    if direction not in ("before", "after"):
        return invalid("direction 只能是 before 或 after")
    if isinstance(count, bool) or not isinstance(count, int):
        return invalid("count 应为整数")
    count = max(1, min(count, CONTEXT_COUNT_MAX))
    item = ctx.evidence.get(source_id) if isinstance(source_id, str) else None
    if item is None or item.get("type") != "knowledge":
        return invalid(
            f"{source_id} 不是已检索到的知识库资料编号，只能读取 S 开头的编号"
        )
    positions = [
        part["position"]
        for part in item.get("parent_parts") or []
        if part.get("position") is not None
    ]
    if item.get("document_id") is None or not positions:
        return result(
            f"{source_id} 没有位置信息，无法读取前后文。", ok=False, source_id=source_id
        )
    # 记录已经读到的范围，连续读后文时从上次的末尾继续，不重复返回同一段。
    start = item.get("read_start", min(positions))
    end = item.get("read_end", max(positions))
    edge = start if direction == "before" else end
    rows = ctx.store.neighbor_chunks(item["document_id"], edge, count)
    if direction == "before":
        picked = [row for row in rows if row["position"] < edge]
    else:
        picked = [row for row in rows if row["position"] > edge]
    label = "前文" if direction == "before" else "后文"
    if not picked:
        return result(
            f"[{source_id} {label}] 已经到文档{'开头' if direction == 'before' else '结尾'}，没有更多内容。",
            source_id=source_id,
            direction=direction,
            chunk_ids=[],
        )
    limit = runtime_snapshot()["parent_max_chars"]
    parts = []
    chunk_ids = []
    total = 0
    # 读前文时从离当前段最近的分片开始取，超出长度上限就停，保证拿到的是紧挨着的内容。
    ordered = list(reversed(picked)) if direction == "before" else picked
    for row in ordered:
        content = row["content"] or row["text"] or ""
        if parts and total + len(content) > limit:
            break
        total += len(content)
        parts.append((row["position"], content))
        chunk_ids.append(row["id"])
    parts.sort()
    text, injection_hits = sanitize_source("\n".join(content for _, content in parts))
    covered = [position for position, _ in parts]
    if direction == "before":
        item["read_start"] = min(covered)
    else:
        item["read_end"] = max(covered)
    return result(
        f"[{source_id} {label}] 《{item['title']}》\n{text}",
        source_id=source_id,
        direction=direction,
        positions=covered,
        chunk_ids=chunk_ids,
        injection=injection_hits,
    )


# ---------- lookup_order ----------


def lookup_order(ctx, order_id):
    if not isinstance(order_id, str) or not order_id.strip():
        return invalid("order_id 不能为空，例如 A1001")
    order_id = order_id.strip().upper()
    # 权限和软删除都在 OrderTool 里检查：没权限的订单和不存在的订单返回同一句话，不暴露订单是否存在。
    outcome = ctx.order_tool.execute(ctx.store, ctx.owner, order_id)
    if outcome["answer"].startswith("没有找到"):
        return result(outcome["answer"], order_id=order_id, found=False)
    evidence_id, _ = ctx.evidence.add("O", {"type": "order", **outcome})
    return result(
        f"[{evidence_id}] {outcome['answer']}",
        order_id=order_id,
        found=True,
        evidence_id=evidence_id,
    )


# ---------- query_data ----------


def query_data(ctx, data_type, filters=None, aggregate=None, order_by=None, limit=10):
    plan = {
        "data_type": data_type,
        "filters": filters or [],
        "aggregate": aggregate,
        "order_by": order_by,
        "limit": limit,
    }
    try:
        outcome = ctx.data_tool.execute_plan(ctx.store, ctx.owner, plan)
    except (DataError, KeyError, TypeError, ValueError) as error:
        # 条件不合法时把原因返回给 Agent 修正，校验规则和固定流程相同（check_plan），模型写不出越权或不存在的字段。
        message = str(getattr(error, "message", error))
        return result(f"查询失败：{message}", ok=False, plan=plan, error=message)
    evidence_id, _ = ctx.evidence.add("D", {"type": "data", **outcome})
    return result(
        f"[{evidence_id}] {outcome['answer']}", evidence_id=evidence_id, **outcome
    )


# ---------- 工具定义 ----------

TOOLS = {
    "search_knowledge": search_knowledge,
    "read_context": read_context,
    "lookup_order": lookup_order,
    "query_data": query_data,
}


def tool_definitions(ctx):
    """生成发给模型的 tools 列表。

    query_data 的描述里带数据字典（build_schemas），按当前用户权限生成：没权限的数据类型和敏感字段不出现。
    同一次问答里每轮的 tools 完全相同，可以命中模型服务的前缀缓存。
    """
    readable, _ = ctx.data_tool.load_access(ctx.store, ctx.owner)
    cap = runtime_snapshot()["agent_return_limit"]
    definitions = [
        function(
            "search_knowledge",
            "在知识库中检索资料（制度、政策、说明文档等）。内部会做召回、融合、重排和相关性过滤，"
            "返回带编号的资料 [S1]、[S2]…。",
            {
                "query": {
                    "type": "string",
                    "description": "检索词。hybrid、vector 模式写完整问句，代词换成具体名称；"
                    "keyword 模式只写要精确匹配的词，如名称、编号、原话。",
                },
                "mode": {
                    "type": "string",
                    "enum": list(SEARCH_MODES),
                    "description": "检索方式，默认 hybrid。",
                },
                "top_k": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": cap,
                    "description": f"最多返回几条，默认 {min(TOP_K_DEFAULT, cap)}，最多 {cap}。",
                },
                "query_explanation": QUERY_EXPLANATION_SCHEMA,
            },
            ["query", "query_explanation"],
        ),
        function(
            "read_context",
            "读取一条已检索到的知识库资料的前文或后文，用于资料被截断、需要看上下文的情况。读到的内容沿用原编号。",
            {
                "source_id": {
                    "type": "string",
                    "description": "已检索到的资料编号，如 S1。",
                },
                "direction": {
                    "type": "string",
                    "enum": ["before", "after"],
                    "description": "before 前文，after 后文。",
                },
                "count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CONTEXT_COUNT_MAX,
                    "description": "读几个相邻分片，默认 1。",
                },
                "query_explanation": QUERY_EXPLANATION_SCHEMA,
            },
            ["source_id", "direction", "query_explanation"],
        ),
        function(
            "lookup_order",
            "按订单号查询单个订单的状态和预计送达时间，返回 [O1]…。",
            {"order_id": {"type": "string", "description": "订单号，如 A1001。"}},
            ["order_id"],
        ),
    ]
    if readable:
        definitions.append(
            function(
                "query_data",
                query_data_description(ctx, readable),
                {
                    "data_type": {
                        "type": "string",
                        "enum": readable,
                        "description": "要查询的数据类型。",
                    },
                    "filters": {
                        "type": "array",
                        "description": "筛选条件，最多 10 个，条件之间是“并且”。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {
                                    "type": "string",
                                    "description": "字段名（name），不是中文名。",
                                },
                                "op": {"type": "string", "enum": list(OPERATORS)},
                                "value": {
                                    "description": "比较的值；op 为 field_lt 时填另一个字段名。"
                                },
                            },
                            "required": ["field", "op", "value"],
                        },
                    },
                    "aggregate": {
                        "type": "object",
                        "description": "需要统计时填写；只看明细时不填。",
                        "properties": {
                            "op": {"type": "string", "enum": list(AGGREGATES)},
                            "field": {
                                "type": "string",
                                "description": "统计的数值字段；count 不需要。",
                            },
                        },
                        "required": ["op"],
                    },
                    "order_by": {
                        "type": "object",
                        "properties": {
                            "field": {"type": "string"},
                            "direction": {"type": "string", "enum": ["asc", "desc"]},
                        },
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": ROW_LIMIT,
                        "description": "最多返回几行明细，默认 10。",
                    },
                },
                ["data_type"],
            )
        )
    return definitions


# query_data 的描述：用法说明 + 数据字典。数据字典和固定流程 llm_plan 用的是同一份（build_schemas）。
def query_data_description(ctx, readable):
    schemas = ctx.data_tool.build_schemas(readable)
    operators = "、".join(f"{key}（{label}）" for key, label in OPERATORS.items())
    return (
        "查询业务数据（订单、物流、库存、售后等记录），返回 [D1]…。数字和明细直接来自数据库。\n"
        f"filters 里的 field 必须使用下面数据字典中的字段名；op 可选：{operators}；"
        "field_lt 表示和同一行另一个字段比较，例如库存 < 安全库存。\n"
        "枚举字段的 value 只能从 options 里选；日期写成 YYYY-MM-DD。\n"
        "数据字典：\n" + json.dumps(schemas, ensure_ascii=False)
    )


def function(name, description, properties, required):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


def execute_tool(ctx, name, arguments):
    """执行模型给出的一次工具调用。arguments 是接口返回的 JSON 字符串。

    工具名不存在、参数不是合法 JSON、缺参数或多了参数时都返回错误说明，不抛异常，让模型下一轮自己修正。
    """
    handler = TOOLS.get(name)
    if handler is None:
        return invalid(f"没有名为 {name} 的工具，可用的工具：{'、'.join(TOOLS)}")
    try:
        parsed = (
            json.loads(arguments)
            if isinstance(arguments, str) and arguments.strip()
            else (arguments or {})
        )
    except json.JSONDecodeError as error:
        return invalid(f"arguments 不是合法的 JSON：{error.msg}")
    if not isinstance(parsed, dict):
        return invalid("arguments 应为 JSON 对象")
    if name in RETRIEVAL_TOOLS:
        try:
            query_explanation(parsed)
        except ValueError as error:
            return invalid(str(error))
    execution = retrieval_arguments(name, parsed)
    # 先按函数签名核对参数名，缺少必填参数或多了参数时直接告诉模型；不用 try 包住整个调用，
    # 以免把工具内部的程序错误误报成"参数不正确"。
    try:
        inspect.signature(handler).bind(ctx, **execution)
    except TypeError as error:
        return invalid(f"{name} 的参数不正确：{error}")
    outcome = handler(ctx, **execution)
    outcome["trace"]["arguments"] = parsed
    return outcome
