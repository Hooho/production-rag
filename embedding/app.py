import os
from threading import Lock, Thread

from fastapi import FastAPI
from pydantic import BaseModel, Field
from fastembed import TextEmbedding
from fastembed.rerank.cross_encoder import TextCrossEncoder
from tokenizers import Tokenizer


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
model = TextEmbedding(model_name=MODEL_NAME)
# 模型自带的分词器开启了截断：超过上限的文字在向量化时被直接丢掉，而且不会报错。
# 复制一份关闭截断和补齐的分词器，才能数出分片的真实 token 数，判断它有没有被截断。
MAX_TOKENS = model.model.tokenizer.truncation["max_length"]
counter = Tokenizer.from_str(model.model.tokenizer.to_str())
counter.no_truncation()
counter.no_padding()
reranker = None
reranker_lock = Lock()
# 重排模型的加载状态，供 /health 查看：loading、ready 或 failed: 原因。
reranker_state = "loading"
app = FastAPI(title="Local Embedding Service")


class EmbeddingInput(BaseModel):
    model: str = Field(default=MODEL_NAME)
    input: list[str] = Field(min_length=1, max_length=64)


class TokenizeInput(BaseModel):
    input: list[str] = Field(min_length=1, max_length=64)


class RerankInput(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    documents: list[str] = Field(min_length=1, max_length=32)


# 返回 OpenAI 兼容的 Embedding 响应，供 API 和 Worker 共用本地模型。
@app.post("/v1/embeddings")
def embeddings(body: EmbeddingInput):
    vectors = list(model.embed(body.input))
    data = []
    for index, vector in enumerate(vectors):
        data.append({"object": "embedding", "index": index, "embedding": vector.tolist()})
    return {"object": "list", "data": data, "model": MODEL_NAME,
        "usage": {"prompt_tokens": 0, "total_tokens": 0}}


# 返回每段文字在当前模型下的真实 token 数（含 [CLS]/[SEP]）和模型的最大输入长度。
# 超过上限时 cut 是被截掉部分在原文里的起始字符位置：模型只保留开头 MAX_TOKENS - 2 个 token（另外两个是
# [CLS]/[SEP]），从下一个 token 开始的文字没有参与向量计算。没超限时 cut 为 null。
@app.post("/v1/tokenize")
def tokenize(body: TokenizeInput):
    data = []
    for index, encoding in enumerate(counter.encode_batch(body.input)):
        cut = None
        if len(encoding.ids) > MAX_TOKENS:
            cut = encoding.offsets[MAX_TOKENS - 1][0]
        data.append({"index": index, "tokens": len(encoding.ids), "cut": cut})
    return {"object": "list", "data": data, "model": MODEL_NAME, "max_tokens": MAX_TOKENS}


# 加载交叉编码器（首次需要下载）。加锁：后台预加载和第一次重排请求同时到来时只加载一次，后到的等待它完成。
def get_reranker():
    global reranker, reranker_state
    with reranker_lock:
        if reranker is None:
            reranker_state = "loading"
            try:
                reranker = TextCrossEncoder(model_name=os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-base"))
                reranker_state = "ready"
            except Exception as error:
                reranker_state = f"failed: {str(error)[:300]}"
                raise
    return reranker


# 以前重排模型在第一个问题到来时才加载，冷启动（下载约 1 GB、加载几十秒）会让那次重排超时，
# 面板显示未重排，问答流也可能被代理断开。现在服务启动后立即在后台加载；
# 不阻塞启动和健康检查，向量接口照常可用，api 也不用等它（下载慢时不会拖住整个项目启动）。
def preload_reranker():
    try:
        get_reranker()
    except Exception:
        pass


Thread(target=preload_reranker, daemon=True).start()


# 返回与候选文档顺序对应的交叉编码器相关性分数。
@app.post("/v1/rerank")
def rerank(body: RerankInput):
    scores = list(get_reranker().rerank(body.query, body.documents))
    data = []
    for index, score in enumerate(scores):
        value = score.score if hasattr(score, "score") else score
        data.append({"index": index, "score": float(value)})
    return {"object": "list", "data": data, "model": os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-base")}


# 健康检查不执行推理，只确认模型进程已加载。
@app.get("/health")
def health():
    return {"status": "ready", "model": MODEL_NAME, "reranker": reranker_state}
