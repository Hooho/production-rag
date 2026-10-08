import json
import time
from typing import Any, TypedDict

from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph

from ..memory.service import Memory
from ..models import CITATION_REJECTED
from ..router.router import Router
from ..security import BLOCKED_ANSWER, OUTPUT_CHECKS, check_answer, detect_injection, injection_rule_catalog
from ..tools.data_query import DataQueryTool
from ..tools.orders import OrderTool
from ..tools.search import DocumentSearchTool
from .response import ResponseAgent, prompt_markers, prompt_version


class AgentState(TypedDict, total=False):
    store: Any
    models: Any
    owner: str
    session_id: str
    question: str
    previous: list[dict[str, Any]]
    last_order: str | None
    started_at: float
    steps: list[dict[str, Any]]
    ai_memories: list[dict[str, Any]]
    memory_context: dict[str, Any]
    analysis: dict[str, Any]
    decision: dict[str, Any]
    route: str
    order_id: str | None
    queries: list[str]
    standalone_query: str
    sources: list[dict[str, Any]]
    retrieval_stats: dict[str, Any]
    answer: str
    on_token: Any
    coverage: dict[str, Any] | None


class Agent:
    """使用 LangGraph 编排有界的 Router、Memory、Tools 和回答生成。"""

    def __init__(self, models=None):
        self.router = Router()
        self.memory = Memory()
        # 回答 Agent 负责生成最终回答；它持有的 FrameworkMemory 只管会话记忆（Checkpointer 和摘要中间件）。
        self.response_agent = ResponseAgent(models) if models is not None else None
        self.order_tool = OrderTool()
        self.data_tool = DataQueryTool()
        self.search_tool = DocumentSearchTool()
        # 注入攻击的向量样本库（app/security_samples.py），api 启动时设置；没有设置时输入检查只用规则。
        self.injection_samples = None
        # 注入检测模型（app/security_model.py），api 启动时设置；没有设置时不做第三层。
        self.injection_model = None
        # 主 Agent 创建自己的 LangGraph 图
        self.graph = self.build_graph()

    # 声明问答图及其条件分支，节点本身只返回共享状态更新。
    def build_graph(self):
        # 创建一张以 AgentState 为共享状态的 LangGraph。
        workflow = StateGraph(AgentState)
        
        # 注册节点
        workflow.add_node("request", self.receive_question)
        workflow.add_node("input_guard", self.guard_input)
        workflow.add_node("memory", self.read_memory)
        workflow.add_node("intent", self.identify_intent)
        workflow.add_node("router", self.route_question)
        workflow.add_node("order_tool", self.execute_order_tool)
        workflow.add_node("data_tool", self.execute_data_tool)
        workflow.add_node("greeting", self.answer_greeting)
        workflow.add_node("query", self.rewrite_query)
        workflow.add_node("retrieval", self.retrieve_documents)
        workflow.add_node("sufficiency", self.check_sufficiency)
        workflow.add_node("context", self.assemble_context)
        workflow.add_node("response", self.generate_response)
        workflow.add_node("output_guard", self.guard_output)
        workflow.add_node("complete", self.complete_run)
        
        # 定义节点之间的连接
        workflow.add_edge(START, "request")
        # 问题先做注入检查：命中规则直接结束，不读取记忆、不调用任何模型。
        workflow.add_edge("request", "input_guard")
        workflow.add_conditional_edges("input_guard", self.guard_destination, {
            "blocked": "complete", "memory": "memory",
        })
        # 以前 memory 和 intent 之间还有"应用框架记忆策略"一步：它在检索前执行，却要等回答生成后回头补写压缩结果，
        # 记忆上限等字段又和"组装模型上下文"重复。现在去掉这一步：规则放在组装上下文，压缩结果放在回答步骤。
        workflow.add_edge("memory", "intent")
        workflow.add_edge("intent", "router")
        
        # 条件路由
        workflow.add_conditional_edges("router", self.route_destination, {
            "order": "order_tool", "data": "data_tool", "greeting": "greeting", "knowledge": "query",
        })
        workflow.add_edge("order_tool", "complete")
        # 数据查询的回答由模板直接拼出数据库结果，和订单工具一样不经过回答模型，直接结束。
        workflow.add_edge("data_tool", "complete")
        workflow.add_edge("greeting", "complete")
        workflow.add_edge("query", "retrieval")
        # 检索之后先判断资料是否充分（必要时补充检索一次），再组装上下文，保证回答模型看到的是最终来源。
        workflow.add_edge("retrieval", "sufficiency")
        workflow.add_edge("sufficiency", "context")
        workflow.add_edge("context", "response")
        # 回答生成后再做输出检查，最终返回和保存的都是检查后的回答。
        workflow.add_edge("response", "output_guard")
        workflow.add_edge("output_guard", "complete")
        workflow.add_edge("complete", END)
        return workflow.compile()

    # 执行编译后的 LangGraph，并返回与 API 现有协议兼容的结果。
    def run(self, store, models, owner, session_id, question, previous, last_order, on_step=None, on_token=None):
        # on_token 放进状态传给回答节点，流式接口借此把模型逐段输出推给前端。
        initial: AgentState = {"store": store, "models": models, "owner": owner,
            "session_id": session_id, "question": question, "previous": previous,
            "last_order": last_order, "on_token": on_token, "started_at": time.monotonic(),
            "steps": [], "ai_memories": [], "sources": []}
        state = dict(initial)
        emitted = {}
        for update in self.graph.stream(initial, stream_mode="updates"):
            for values in update.values():
                state.update(values)
                if on_step is None:
                    continue
                for step in values.get("steps", []):
                    fingerprint = json.dumps(step, ensure_ascii=False, sort_keys=True, default=str)
                    if emitted.get(step["id"]) == fingerprint:
                        continue
                    emitted[step["id"]] = fingerprint
                    on_step(step)
        return {"answer": state["answer"], "route": state["route"],
            "sources": state.get("sources", []), "steps": state["steps"],
            "last_order": state.get("last_order"), "model_mode": models.mode,
            "orchestrator": "langgraph"}

    # 追加一个可观察步骤；run 会从 LangGraph updates 流中转发给前端。
    # 以前没有传 started_at 的步骤按"从请求开始到现在"计时，和单独计时的步骤混在一起，
    # 例如组装上下文只是程序拼接，却显示 27 秒。现在 duration_ms 统一是这一步自己的耗时：
    # 单独计时的步骤用各自的开始时间，其余步骤从上一步完成时算起；elapsed_ms 另记从请求开始的累计时间。
    def add_step(self, state, step_id, stage, title, detail, result=None, started_at=None):
        now = time.monotonic()
        elapsed_ms = round((now - state["started_at"]) * 1000)
        if started_at is not None:
            duration_ms = round((now - started_at) * 1000)
        else:
            previous = state["steps"][-1].get("elapsed_ms", 0) if state["steps"] else 0
            duration_ms = max(0, elapsed_ms - previous)
        item = {"id": step_id, "stage": stage, "title": title, "status": "completed",
            "detail": detail, "duration_ms": duration_ms, "elapsed_ms": elapsed_ms}
        if result is not None:
            item["result"] = result
            # MySQL 的 JSON 列不保留对象的键顺序（按键名长度重新排序），页面重新加载后字段顺序会和实时显示时不同；
            # 数组的顺序会保留，所以把字段顺序单独存一份，前端按它排列。
            item["field_order"] = list(result.keys())
        state["steps"].append(item)
        return item

    # 返回不调用模型时的处理说明。以前固定附带"模型调用：否 / 模型名称：无 / 模型类型：无"，
    # 程序拼接、规则检查这类步骤也列出三行空的模型信息，看起来像该调模型却没调；
    # 现在只说明这一步怎么处理、为了什么，调用了模型的步骤才显示模型信息。
    @staticmethod
    def no_model_info(process_method, purpose):
        return {"process_method": process_method, "process_purpose": purpose}

    # 以前模型信息分三行："模型调用：是 / 模型名称 / 模型类型"。写出了调用的是哪个模型，自然就知道调用了，
    # 现在合成一行"模型调用：MiniMax-M3（聊天大模型）"；没有调用模型的步骤只写处理方式，不出现模型字段。
    @staticmethod
    def model_called(name, kind):
        return f"{name}（{kind}）"

    # 返回聊天模型的具体名称和调用路径，区分真实模型调用与演示模式的程序逻辑。
    @staticmethod
    def chat_model_info(state, purpose, called):
        if called and state["models"].mode == "openai":
            models = state["models"]
            return {"model_called": Agent.model_called(models.llm_model, "聊天大模型"),
                "call_method": f"LangChain ChatOpenAI → {models.llm_base_url} ",
                "purpose": purpose}
        return Agent.no_model_info("未调用聊天模型", purpose)

    # 记录一次模型实际使用的历史记忆。以前写回"读取 Memory"这一步，但读取时并没有发给模型；
    # 现在由实际调用模型的步骤（意图识别、组织回答）把本步发送的记忆放进自己的结果里。
    def record_ai_memory(self, state, target, memory):
        state["ai_memories"].append({"target": target, **memory})

    # 接收并记录用户问题。
    def receive_question(self, state):
        # 历史记录数属于读取 Memory；编排框架每次都一样，不再重复显示。
        self.add_step(state, "request", "request", "接收问题", "问题已进入 LangGraph", {
            "question": state["question"],
            **self.no_model_info("LangGraph 接收请求", "记录用户问题并启动处理流程"),
        })
        return {"steps": state["steps"]}

    # 输入安全检查分三层，前一层拦下就不再往后查：
    # 1. 规则：写死的正则，认固定写法（app/security.py）；
    # 2. 攻击样本向量：和样本库里的攻击说法比语义相似度（app/security_samples.py）；
    # 3. 注入检测模型：guard 服务给出攻击概率（app/security_model.py）。
    # 拦下时路由设为 blocked 并给出固定回答；这条记录仍写入 runs 便于审计，但不会作为后续轮次的历史交给模型。
    # 每一层的结果都作为「检查的规则」清单里的一项写进记录，前端按层显示。
    def guard_input(self, state):
        from ..runtime_config import value as runtime_value
        from ..security_model import catalog_entry as model_entry
        from ..security_samples import catalog_entry as vector_entry
        question = state["question"]
        # 三层各自有开关（设置页「安全检查」）。第一层关闭时清单里只放一项「已关闭」，前端据此显示。
        if runtime_value("injection_rules_enabled"):
            hits = detect_injection(question)
            checked = injection_rule_catalog()
        else:
            hits = []
            checked = [{"rule": "rule_layer_off", "label": "规则匹配", "description": "已在设置里关闭，这一层跳过。"}]
        detail = "未发现注入特征" if not hits else "命中注入规则，已拒绝处理"
        samples, guard = self.injection_samples, self.injection_model
        # 规则命中的问题进样本库的「待确认」，管理员确认后，同类的换个说法在第二层也能认出来。
        if hits and samples is not None:
            samples.add_candidate(question, hits)
        if not hits and samples is not None:
            vector = samples.check(state["models"], question)
            if vector is not None:
                checked = checked + [vector_entry(vector)]
                if vector.get("action") == "block":
                    hits = [{"rule": "vector_similar", "text": vector["sample"]}]
                    detail = "和已知攻击样本意思相近，已拒绝处理"
        if guard is not None and hits:
            if runtime_value("injection_model_enabled"):
                checked = checked + [model_entry(skipped="前面的检查已经拦下，没有再交给模型判断。")]
        elif guard is not None:
            judged = guard.check(question)
            if judged is not None:
                checked = checked + [model_entry(judged)]
                # 模型判断为攻击的（不论拦没拦）进待确认：确认后加入样本库，下次在第二层就能拦下。
                if judged.get("action") and samples is not None:
                    samples.add_candidate(question, [{"rule": "model_judged"}])
                if judged.get("action") == "block":
                    hits = [{"rule": "model_judged", "text": f"攻击概率 {judged['score']:.2f}"}]
                    detail = "注入检测模型判断为攻击，已拒绝处理"
        self.add_step(state, "input_guard", "guard", "输入安全检查", detail, {
            "blocked": bool(hits), "rules": hits, "checked_rules": checked,
            **self.no_model_info("规则匹配 + 攻击样本向量匹配 + 注入检测模型", "识别问题中的直接提示注入"),
        })
        update = {"steps": state["steps"]}
        if hits:
            update.update({"route": "blocked", "answer": BLOCKED_ANSWER})
        return update

    # 为输入检查之后的条件边返回目标分支。
    def guard_destination(self, state):
        return "blocked" if state.get("route") == "blocked" else "memory"

    # 检查回答：复述系统说明时整段拦截，移除图片和来源里没有的链接。
    # 流式接口在生成过程中已经推送了原始文字，前端收到 complete 后会用这里检查后的回答替换。
    def guard_output(self, state):
        answer, issues = check_answer(state["answer"], state["sources"], prompt_markers())
        detail = "未发现问题" if not issues else f"处理了 {len(issues)} 处不安全内容"
        self.add_step(state, "output_guard", "guard", "输出安全检查", detail, {
            "issues": issues, "checked_rules": list(OUTPUT_CHECKS),
            **self.no_model_info("程序内规则检查", "拦截系统说明泄露，移除图片和来源外链接"),
        })
        return {"answer": answer, "steps": state["steps"]}

    # 从 MySQL 读取审计历史，并从 LangGraph Checkpointer 读取模型会话状态。
    def read_memory(self, state):
        framework = self.response_agent.memory.inspect(state["owner"], state["session_id"])
        # 长期记忆（跨会话的用户偏好、身份）：问题改写和生成回答都会用到；用户或设置页关闭时为空。
        framework["profile"] = self.response_agent.memory.long_term.profile(state["owner"])
        history_memory = []
        for item in state["previous"]:
            response = item.get("response") or {}
            history_memory.append({"created": item.get("created"),
                "question": item.get("question", ""), "answer": response.get("answer", "")})
        result = {"mysql_history_count": len(history_memory), "mysql_history": history_memory,
            "rolling_summary": framework["summary"] or "尚未生成",
            "checkpoint_backend": self.response_agent.memory.backend,
            "checkpoint_messages": framework["message_count"],
            # 滚动摘要的生成规则：超过多少 Token 压缩、保留多少 Token 原文、用哪个模型压缩，前端写在滚动摘要下面。
            "memory_trigger_tokens": self.response_agent.memory.trigger_tokens,
            "memory_keep_tokens": self.response_agent.memory.keep_tokens,
            "summary_model": state["models"].llm_model,
            "long_term_memory": [item["content"] for item in framework["profile"]],
            **self.no_model_info("MySQL + PostgreSQL Checkpoint/Store + Redis 读取", "读取历史记忆供后续阶段使用")}
        # Redis 短期状态目前只有最近订单号，只和订单追问有关；没有订单时不显示。
        if state.get("last_order"):
            result["redis_short_term"] = {"recent_order": state.get("last_order")}
        self.add_step(state, "memory", "memory", "读取 Memory",
            "读取 MySQL 审计历史、LangGraph Checkpoint 和 Redis 短期状态", result)
        return {"steps": state["steps"], "memory_context": framework,
            "ai_memories": state["ai_memories"]}

    # 按规则、小模型、DeepSeek 的优先级识别意图。
    def identify_intent(self, state):
        started = time.monotonic()
        analysis = state["models"].analyze_query(state["question"], state["previous"],
            state.get("last_order"), summary=state["memory_context"]["summary"],
            on_memory=lambda target, memory: self.record_ai_memory(state, target, memory),
            profile=state["memory_context"].get("profile"))
        # 这一步的重点是识别过程：先列出每一环的结果和是否采纳，再给最终结果；
        # 候选意图已经写在小模型那一环里，不再单独列出。
        # 调用了哪个模型、怎么调用的，识别过程里每一环已经写清楚，不再单独列"模型调用 / 调用方式"。
        # classifier（最终由哪一环决定）仍保存，追踪摘要要用；页面上看识别过程里标"采纳"的那一环即可。
        result = {"trace": analysis.get("trace", []),
            "intent": analysis["intent"], "confidence": analysis["confidence"],
            "classifier": analysis.get("classifier", "unknown"),
            "process_purpose": "识别用户意图、改写检索词并决定后续路由"}
        # 订单号只有订单问题才有，其他问题一直为空，不再显示。
        if analysis.get("order_id"):
            result["order_id"] = analysis["order_id"]
        # 每个模型收到的上下文已经写进识别过程的对应环节，这里不再单独列出"各次模型调用收到的上下文"。
        self.add_step(state, "intent", "intent", "意图识别", analysis["reason"], result, started_at=started)
        return {"analysis": analysis, "steps": state["steps"],
            "ai_memories": state["ai_memories"]}

    # 使用 Router 生成受控分支，不允许模型直接绕过权限调用工具。
    def route_question(self, state):
        decision = self.router.inspect(state["question"], state.get("last_order"), state["analysis"])
        route = decision["route"]
        destinations = {"order": "OrderTool", "data": "DataQueryTool", "knowledge": "DocumentSearchTool",
            "greeting": "直接回答"}
        # 判断依据：采用意图识别结果时直接写"意图识别结果为 xx"；以前沿用意图识别的说明
        # （"模型完成意图识别和检索词改写"），看不出为什么分到这里。程序规则决定的写规则原因。
        intent_labels = {"order": "订单查询", "data": "数据查询", "knowledge": "知识问答", "greeting": "问候"}
        basis = f"意图识别结果为{intent_labels[route]}" if decision.get("by") == "intent" else decision["reason"]
        self.add_step(state, "router", "router", "Router 分流",
            f"分流到 {destinations[route]}", {"route": route,
                "destination": destinations[route], "reason": decision["reason"], "basis": basis,
                **self.no_model_info("程序内 Router 规则", "根据意图和业务规则选择执行模块")})
        return {"decision": decision, "route": route, "order_id": decision.get("order_id"),
            "steps": state["steps"]}

    # 为 LangGraph 的条件边返回目标分支。
    def route_destination(self, state):
        return state["route"]

    # 执行当前用户范围内的订单查询工具。
    def execute_order_tool(self, state):
        started = time.monotonic()

        # 用户身份由服务端闭包注入，不暴露给模型或客户端参数。
        def get_my_order(order_id: str | None):
            return self.order_tool.execute(state["store"], state["owner"], order_id)

        tool = StructuredTool.from_function(get_my_order, name="get_my_order",
            description="查询当前已认证用户自己的订单")
        result = tool.invoke({"order_id": state.get("order_id")})
        last_order = result["order_id"] if result["order_id"] else state.get("last_order")
        self.add_step(state, "tool", "tool", "执行订单工具", "只查询当前用户有权限访问的订单", {
            "tool": "get_my_order", "order_id": state.get("order_id"), "answer": result["answer"],
            **self.no_model_info("LangChain Tool → MySQL 订单查询", "读取当前用户有权限访问的订单"),
        }, started_at=started)
        return {"answer": result["answer"], "last_order": last_order,
            "steps": state["steps"]}

    # 执行业务数据查询。用户身份由服务端注入，工具内部按用户所在部门的数据权限过滤，模型和客户端都不能指定。
    def execute_data_tool(self, state):
        started = time.monotonic()
        result = self.data_tool.execute(state["store"], state["models"], state["owner"], state["question"])
        planner = result.get("planner")
        detail = result.get("reason") if result["refused"] else \
            f"查询{result.get('data_type')}，共 {result.get('total')} 条"
        if planner == "llm":
            model_info = self.chat_model_info(state, "把问题转换成 JSON 查询计划（代码校验后执行）", True)
        else:
            model_info = self.no_model_info("规则生成查询计划", "把问题转换成查询计划（代码校验后执行）")
        rows = result.get("rows") or []
        self.add_step(state, "tool", "tool", "执行数据查询工具", detail, {
            "tool": "query_business_data", "planner": planner, "plan": result.get("plan"),
            "plan_error": result.get("plan_error"), "refused": result["refused"],
            "data_type": result.get("data_type"), "total": result.get("total"),
            "returned": len(rows), "aggregate_value": result.get("aggregate_value"),
            **model_info,
        }, started_at=started)
        return {"answer": result["answer"], "steps": state["steps"]}

    # 对问候问题直接返回固定回答。
    def answer_greeting(self, state):
        answer = "你好，可以询问知识库内容、查询订单 A1001 / B2001，或查询业务数据，例如“哪些商品快缺货了”。"
        self.add_step(state, "response", "agent", "Agent 组织回答", "问候问题无需调用外部工具", {
            "answer_type": "greeting",
            **self.no_model_info("程序内固定回答", "直接返回问候语"),
        })
        return {"answer": answer, "steps": state["steps"]}

    # 改写是由意图识别里哪一环完成的：大模型改写；本地小模型只分类不改写；规则兜底只在有代词时拼接上一个问题。
    @staticmethod
    def rewrite_method(state, standalone_query):
        classifier = state["analysis"].get("classifier")
        if classifier == "llm":
            return f"在意图识别中，通过 {state['models'].llm_model} 模型改写问题"
        if classifier == "small_model":
            return "意图识别由本地小模型完成，小模型只分类不改写，直接用原问题检索"
        if standalone_query != state["question"]:
            return "未调用大模型，按规则把上一个问题拼到前面补全代词"
        return "未调用大模型，直接用原问题检索"

    # 记录意图节点产生的独立问题和多路检索词。
    def rewrite_query(self, state):
        analysis = state["analysis"]
        queries = analysis.get("queries") or [state["question"]]
        standalone_query = analysis.get("standalone_query") or state["question"]
        self.add_step(state, "query", "tool", "Query Rewrite", "生成独立问题和多路检索词", {
            "input_question": state["question"],
            "standalone_query": standalone_query,
            "queries": queries,
            # 改写和意图识别是同一次模型调用，这里只写明是在意图识别中由谁改写的，不再单独列模型字段，免得看起来调用了两次。
            **self.no_model_info(self.rewrite_method(state, standalone_query), "补全问题并改写成多个检索词"),
        })
        # standalone_query 要单独保存下来交给重排：queries 是检索用的短句，不一定是完整问题。
        return {"queries": queries, "standalone_query": standalone_query, "steps": state["steps"]}

    # 执行向量、关键词融合和交叉编码器重排。
    def retrieve_documents(self, state):
        started = time.monotonic()

        # owner 过滤由服务端注入，LangChain Tool 只能检索当前用户的 Milvus 向量和全文索引。
        def search_my_documents(queries: list[str], rerank_query: str):
            return self.search_tool.execute(state["store"], state["models"],
                state["owner"], queries, rerank_query)

        tool = StructuredTool.from_function(search_my_documents, name="search_my_documents",
            description="在当前用户知识库中执行混合检索和重排")
        retrieval = tool.invoke({"queries": state["queries"],
            "rerank_query": state.get("standalone_query") or state["question"]})
        self.add_step(state, "retrieval", "tool", "混合检索与重排",
            f"融合向量和关键词召回，返回 {len(retrieval['sources'])} 条内容",
            self.retrieval_result(state, retrieval), started_at=started)
        return {"sources": retrieval["sources"], "retrieval_stats": retrieval["stats"],
            "steps": state["steps"]}

    # 检索步骤的展示内容；首次检索和充分性判断触发的补充检索共用，保证两次检索的诊断格式一致。
    def retrieval_result(self, state, retrieval):
        # 以前还带着工具名、框架名、命中数和来源列表，和下方的检索诊断（漏斗、候选明细）重复；现在只保留诊断。
        # stats 仍然保存，追踪摘要要用，前端不单独显示。
        return {
                # 只列出实际调用了的模型；重排没执行时不列重排模型。BM25、RRF 是算法不是模型，写在调用方式里。
                "model_called": self.model_called(state["models"].embedding_model, "向量模型") + (
                    "；" + self.model_called(retrieval["diagnostics"]["config"].get("rerank_model", state["models"].rerank_model), "重排模型")
                    if retrieval["stats"].get("reranked", 0) else ""),
                "call_method": "向量：本地 HTTP → embedding 服务 /v1/embeddings；重排：本地 HTTP → embedding 服务 /v1/rerank；BM25：Milvus 全文检索；RRF：程序内计算",
                "purpose": "召回候选、融合排名、重排候选并执行相关性阈值过滤",
                "stats": retrieval["stats"],
                # 完整的检索计算过程随步骤保存到 MySQL，刷新页面或查看历史时仍可展示。
                "diagnostics": retrieval["diagnostics"],
            }

    # 判断检索资料是否足以回答；不足时补充检索一次，仍不足则清空来源让回答阶段拒答。
    def check_sufficiency(self, state):
        started = time.monotonic()
        rerank_query = state.get("standalone_query") or state["question"]
        result = self.search_tool.check_sufficiency(state["store"], state["models"], state["owner"],
            state["queries"], rerank_query, {"sources": state["sources"]})
        if not result["checked"]:
            reason = "没有检索来源，回答阶段直接拒答" if not state["sources"] else \
                "未启用（需要 MODEL_MODE=openai，且「系统管理 › RAG 配置」里「检索充分性判断」是打开的）"
            self.add_step(state, "sufficiency", "tool", "检索充分性判断", reason, {
                "checked": False, **self.no_model_info("未调用模型", "判断检索资料能否回答问题"),
            }, started_at=started)
            return {"coverage": None, "steps": state["steps"]}
        if result["retried"]:
            retry = result["retry_retrieval"]
            first = "资料只能回答一部分" if result["judgements"][0]["verdict"] == "partial" else "资料不足"
            used = "" if result["retry_used"] else "，补充后没有变好，沿用原来的来源"
            self.add_step(state, "retrieval_retry", "tool", "补充检索",
                f"{first}，追加检索词“{result['retry_query']}”后返回 {len(retry['sources'])} 条内容{used}",
                self.retrieval_result(state, retry), started_at=started)
        labels = {"sufficient": "资料充分", "partial": "资料只能回答一部分", "insufficient": "资料不足，拒答"}
        self.add_step(state, "sufficiency", "tool", "检索充分性判断", labels[result["verdict"]], {
            "checked": True, "verdict": result["verdict"], "missing": result["missing"],
            "retried": result["retried"], "retry_query": result["retry_query"],
            "retry_used": result.get("retry_used", False), "refused": result["refused"], "judgements": result["judgements"],
            **self.chat_model_info(state, "判断检索资料能否回答问题，不足或只能回答一部分时给出补充检索词", True),
        }, started_at=started)
        update = {"sources": result["sources"], "steps": state["steps"],
            "coverage": {"verdict": result["verdict"], "missing": result["missing"]}}
        if result.get("retry_used"):
            update["retrieval_stats"] = result["retrieval"]["stats"]
        return update

    # 展示进入回答 Agent 的来源和当前 Checkpoint 记忆状态。
    def assemble_context(self, state):
        context = state["memory_context"]
        source_characters = 0
        for source in state["sources"]:
            source_characters += len(source.get("text", ""))
        # 说明直接写出组装了哪三部分、交给谁；以前"按预算组合……"看不出这一步的产出是发给大模型的上下文。
        self.add_step(state, "context", "agent", "组装模型上下文",
            "把【滚动摘要】【最近问答】【检索来源】组装成上下文发给大模型", {
                "memory_token_budget": self.response_agent.memory.trigger_tokens,
                "estimated_memory_tokens": context["estimated_tokens"],
                "recent_turns": len(context["turns"]),
                # 最近问答原文（问题 + 答案）的总字数，和摘要字数、来源字数一起看出上下文各块有多大。
                "recent_characters": sum(len(turn.get("question", "")) + len(turn.get("answer", "")) for turn in context["turns"]),
                "summary_characters": len(context["summary"]),
                "keep_tokens": self.response_agent.memory.keep_tokens,
                "source_count": len(state["sources"]),
                "source_characters": source_characters,
                "memory_managed_by": "SummarizationMiddleware",
                **self.no_model_info("程序内拼接记忆和检索来源", "按预算组装回答模型的输入上下文"),
            })
        return {"steps": state["steps"]}

    # 使用 LangChain ChatOpenAI 接口生成带可校验引用的回答。
    def generate_response(self, state):
        started = time.monotonic()
        sent_before = len(state["ai_memories"])
        answer, memory = self.response_agent.answer(state["owner"], state["session_id"],
            state["question"], state["sources"], on_token=state.get("on_token"),
            coverage=state.get("coverage"), profile=(state.get("memory_context") or {}).get("profile"))
        # 没有来源时回答是固定的拒答文本，本来就没有引用；原来也做引用校验，会把拒答替换成
        # "模型没有返回可校验的引用"，用户看到的像是出错而不是"知识库没有资料"。
        citation = None
        if state["models"].mode == "openai" and state["sources"]:
            citation = state["models"].check_citations(answer, state["sources"])
            if not citation["passed"]:
                # 拦截前保存模型原话，知识巡检据此判断是忘了标引用还是编造了来源编号；原来直接丢弃，事后无从排查。
                citation["raw_answer"] = answer[:4000]
                answer = CITATION_REJECTED
            self.record_ai_memory(state, "LangChain 回答 Agent", {
                "memory_summary": memory["summary"], "history_turns": memory["turns"],
                **({"long_term_memory": [item["content"] for item in state["memory_context"]["profile"]]}
                    if (state.get("memory_context") or {}).get("profile") else {}),
            })
        # 记忆压缩发生在回答模型调用之前（SummarizationMiddleware），结果记在本步；
        # 以前回头写进检索前的"应用框架记忆策略"步骤，时间顺序对不上。
        result = {
            **self.chat_model_info(state, "依据检索来源生成回答并校验 [S1] 引用", bool(state["sources"])),
            # 追踪摘要据此区分回答出自哪一版提示词，并统计 Token 用量。
            "prompt_version": prompt_version(), "token_usage": memory.get("token_usage"),
            "summary_updated": memory["summary_updated"],
            "checkpoint_messages_before": memory["previous_message_count"],
            "checkpoint_messages_sent": memory["message_count"],
            # 前端据此写明"对话历史超过多少 Token 会压缩"和"本轮问题"，让收到的上下文按时间顺序看得懂。
            "memory_trigger_tokens": self.response_agent.memory.trigger_tokens,
            "current_question": state["question"],
        }
        if citation is not None:
            result["citation_check"] = citation
        sent = state["ai_memories"][sent_before:]
        if sent:
            result["ai_memory_sent"] = list(sent)
        self.add_step(state, "response", "agent", "Agent 组织回答",
            "通过 LangChain 调用模型并校验引用", result, started_at=started)
        return {"answer": answer, "steps": state["steps"],
            "ai_memories": state["ai_memories"]}

    # 释放 LangGraph PostgreSQL Checkpointer 的连接池。
    def close(self):
        if self.response_agent is not None:
            self.response_agent.close()

    # 汇总 LangGraph 本轮运行结果。
    def complete_run(self, state):
        # 路由已在 Router 分流显示、总耗时已在标题栏显示、编排框架每次都一样，这里不再重复；
        # total_duration_ms 仍保存，追踪摘要要用，前端不单独显示。
        self.add_step(state, "complete", "complete", "完成本次处理",
            "LangGraph 已完成执行，结果将写入 MySQL", {
                "total_duration_ms": round((time.monotonic() - state["started_at"]) * 1000),
                **self.no_model_info("LangGraph 完成状态记录", "记录本次处理结果并持久化"),
            })
        return {"steps": state["steps"]}
