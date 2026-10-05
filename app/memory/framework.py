import math
import os
import re

from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg_pool import ConnectionPool

from .. import prompts
from ..models import strip_think
from ..runtime_config import value as runtime_value


# 中日韩文字和全角标点：常见模型的分词器里一个字通常就是一个 Token（0.6–1 个，按 1 个算偏保守）。
WIDE_CHARS = re.compile("[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
# 每条消息的角色、分隔符等格式开销。
MESSAGE_OVERHEAD = 3


def text_tokens(text):
    wide = len(WIDE_CHARS.findall(text))
    return wide + math.ceil((len(text) - wide) / 4)


# 估算对话记忆的 Token。LangChain 默认按「字符数 ÷ 4」估算，那是按英文设计的，中文会少算到三分之一左右：
# 7700 个汉字只算出约 2000 Token，「2400 Token 压缩」实际要到近一万字才触发。
# 这里中日韩文字每个算 1 个 Token，其他字符仍按 4 个算 1 个；不用模型报告的用量放大（那个用量包含检索资料，见下面中间件的说明）。
# 没有用模型自己的分词器：要和回答模型绑定、构建时下载，记忆阈值只是控制线，估算误差在两三成以内就够用。
def memory_token_counter(messages):
    total = 0
    for message in messages:
        content = message.content
        if isinstance(content, str):
            text = content
        else:
            text = "".join(item if isinstance(item, str) else str(item.get("text", "")) for item in content
                if isinstance(item, str) or isinstance(item, dict))
        total += text_tokens(text) + MESSAGE_OVERHEAD
    return total


# 是不是用户的提问（压缩生成的摘要也是一条 HumanMessage，用 lc_source 区分）。
def is_question(message):
    return isinstance(message, HumanMessage) and message.additional_kwargs.get("lc_source") != "summarization"


# 把按 Token 算出的切点对齐到一轮问答的开头。messages 的最后一条是本轮问题。
# LangChain 按 Token 保留时，从最新的消息往前加到超出预算为止，只保证工具调用和结果不拆开，
# 不保证一问一答成对：可能留下一段回答，而它对应的问题已经进了摘要，模型看到的上下文是断的。
# 这里切点落在回答上时往后挪到下一个问题（多压一条，保留的原文仍在预算以内）；
# 对齐后连上一轮完整问答都留不下（上一轮回答特别长）时，强制保留上一轮问答：这一轮会超出预算一些，
# 下一轮压缩时它就会进摘要，不会一直超。返回 0 表示不压缩：切点前没有任何问答（例如之前只有一轮），
# 只剩旧摘要时也不压缩，否则只是把摘要再总结一遍。
def align_cutoff(messages, cutoff):
    if cutoff <= 0:
        return 0
    questions = [index for index, message in enumerate(messages) if is_question(message)]
    aligned = next((index for index in questions if index >= cutoff), len(messages))
    if len(questions) >= 2:
        aligned = min(aligned, questions[-2])
    return aligned if any(index < aligned for index in questions) else 0


# 推理模型压缩记忆时会把 <think> 思考过程一起写进摘要。摘要每一轮都会发给模型，
# 思考过程白白占用记忆 Token 上限，还可能干扰回答；这里在摘要生成后去掉思考过程。
# 回答里的思考过程保留给用户折叠查看，摘要只给模型用，所以两处处理方式不同。
# 另外按 Token 保留原文时把切点对齐到一轮问答的开头（见 align_cutoff）。
#
# 只按对话记忆本身的大小判断要不要压缩。LangChain 还有一个条件：上一次模型调用报告的总 Token 超过阈值也压缩；
# 可那个总数包括系统提示词、检索资料和回答，知识问答一次就有三四千 Token，结果每轮都压缩，和记忆多大无关。
# 估算 Token 用自己的 memory_token_counter：中文按字计数，也不用上一次调用的用量去放大。
class ThinkFreeSummarizationMiddleware(SummarizationMiddleware):
    def _should_summarize_based_on_reported_tokens(self, messages, threshold):
        return False

    def _determine_cutoff_index(self, messages):
        return align_cutoff(messages, super()._determine_cutoff_index(messages))

    def _create_summary(self, messages_to_summarize):
        return strip_think(super()._create_summary(messages_to_summarize)).strip()

    async def _acreate_summary(self, messages_to_summarize):
        return strip_think(await super()._acreate_summary(messages_to_summarize)).strip()


class FrameworkMemory:
    """管理 Checkpoint、摘要中间件和历史消息，不创建或调用回答 Agent。"""

    # 生成评测使用独立的进程内记忆，避免每道评测题把临时回答写入正式 PostgreSQL Checkpointer。
    def __init__(self, models, use_postgres=True):
        self.models = models
        # 压缩阈值和压缩后保留的原文 Token 在设置页修改（见 app/runtime_config.py）；改了以后回答 Agent 在下一次提问前重建中间件。
        self.trigger_tokens = runtime_value("memory_trigger_tokens")
        self.keep_tokens = runtime_value("memory_keep_tokens")
        self.pool = None
        database_url = os.getenv("LANGGRAPH_DATABASE_URL", "") if use_postgres else ""
        if database_url:
            self.pool = ConnectionPool(conninfo=database_url, min_size=1, max_size=5,
                kwargs={"autocommit": True, "prepare_threshold": 0})
            self.checkpointer = PostgresSaver(self.pool)
            self.checkpointer.setup()
            self.backend = "postgres"
        else:
            self.checkpointer = InMemorySaver()
            self.backend = "memory"
        self.middleware = None
        self.summary_identity = None
        self.rebuild()

    def rebuild(self):
        """切换摘要模型，保留原有 Checkpoint。"""
        self.middleware = None
        # 压缩提示词在「提示词」页管理（app/prompts.py）；记下用的是哪一版，改了以后回答 Agent 在下一次提问前重建。
        self.summary_identity = prompts.identity("memory_summary")
        if self.models.chat_model is None:
            return
        summary_prompt = prompts.compose("memory_summary", template=True)
        self.middleware = ThinkFreeSummarizationMiddleware(model=self.models.chat_model,
            trigger=("tokens", self.trigger_tokens), keep=("tokens", self.keep_tokens),
            summary_prompt=summary_prompt, token_counter=memory_token_counter)

    # 生成同时包含用户身份和会话编号的 Checkpoint 线程编号。
    @staticmethod
    def thread_id(owner, session_id):
        return f"{owner}:{session_id}"

    # 将框架消息状态转换为前端可展示的摘要和问答轮次。
    def describe_messages(self, messages: list[BaseMessage]):
        summary = ""
        turns = []
        pending_question = None
        for message in messages:
            if message.additional_kwargs.get("lc_source") == "summarization":
                summary = self.message_text(message)
                prefix = "Here is a summary of the conversation to date:\n\n"
                if summary.startswith(prefix):
                    summary = summary[len(prefix):]
                # 改动之前生成的摘要里可能还带着思考过程，展示和统计时同样去掉。
                summary = strip_think(summary)
                pending_question = None
                continue
            if isinstance(message, HumanMessage):
                pending_question = self.message_text(message)
                continue
            if isinstance(message, AIMessage) and pending_question is not None:
                turns.append({"question": pending_question, "answer": self.message_text(message)})
                pending_question = None
        estimated_tokens = 0
        if self.middleware is not None:
            estimated_tokens = self.middleware.token_counter(messages)
        return {"summary": summary, "turns": turns, "message_count": len(messages),
            "estimated_tokens": estimated_tokens}

    # 直接读取 Checkpoint 消息，记忆模块不依赖回答 Agent。
    def inspect(self, owner, session_id):
        if self.models.chat_model is None:
            return self.describe_messages([])
        config = {"configurable": {"thread_id": self.thread_id(owner, session_id)}}
        checkpoint = self.checkpointer.get(config)
        messages = list(checkpoint.get("channel_values", {}).get("messages", [])) if checkpoint else []
        return self.describe_messages(messages)

    # 将文本和多模态消息内容统一为可展示文本。
    @staticmethod
    def message_text(message):
        if isinstance(message.content, str):
            return message.content
        parts = []
        for item in message.content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        return "\n".join(parts)

    # 每个会话的快照数和占用空间（字节），供「会话记忆」页面显示：{session_id: {"snapshots": n, "bytes": n}}。
    # PostgreSQL 时直接按表统计：checkpoints 每个快照一行，checkpoint_blobs 存消息等大块数据，checkpoint_writes 存步骤中途的写入。
    # 进程内存储（测试、评测）只能数快照，没有占用空间。
    def storage(self, owner, session_ids):
        threads = {self.thread_id(owner, session_id): session_id for session_id in session_ids}
        result = {session_id: {"snapshots": 0, "bytes": 0 if self.pool is not None else None} for session_id in session_ids}
        if not threads:
            return result
        if self.pool is None:
            for thread, session_id in threads.items():
                result[session_id]["snapshots"] = sum(1 for _ in self.checkpointer.list(
                    {"configurable": {"thread_id": thread}}))
            return result
        names = list(threads)
        queries = [
            ("snapshots", "SELECT thread_id, count(*), coalesce(sum(pg_column_size(checkpoint) + pg_column_size(metadata)), 0) "
                "FROM checkpoints WHERE thread_id = ANY(%s) GROUP BY thread_id"),
            ("blobs", "SELECT thread_id, 0, coalesce(sum(length(blob)), 0) FROM checkpoint_blobs "
                "WHERE thread_id = ANY(%s) GROUP BY thread_id"),
            ("writes", "SELECT thread_id, 0, coalesce(sum(length(blob)), 0) FROM checkpoint_writes "
                "WHERE thread_id = ANY(%s) GROUP BY thread_id"),
        ]
        with self.pool.connection() as connection:
            for kind, sql in queries:
                for thread, count, size in connection.execute(sql, (names,)).fetchall():
                    item = result[threads[thread]]
                    if kind == "snapshots":
                        item["snapshots"] = count
                    item["bytes"] += int(size or 0)
        return result

    # 关闭 PostgreSQL 连接池；内存 Checkpointer 不需要释放资源。
    def close(self):
        if self.pool is not None:
            self.pool.close()

    # 检查生产 Checkpointer 的 PostgreSQL 连接。
    def ready(self):
        if self.pool is None:
            return
        with self.pool.connection() as connection:
            connection.execute("SELECT 1")
