# 提示注入检测模型服务：输入安全检查的第三层（app/security_model.py 调用）。
#
# 默认用 Meta 的 Llama Prompt Guard 2（86M，多语言，基于 mDeBERTa），是一个二分类模型：
# 输入一段文字，输出它是正常内容还是注入 / 越狱攻击的概率。不是生成模型，CPU 上一次几十到一百毫秒。
#
# 下载：模型在 Hugging Face 上需要先同意 Llama 许可，再用 HF_TOKEN 下载（只在第一次，之后在 guard_cache 卷里）。
# 服务启动后在后台加载，不阻塞启动；没加载好或加载失败时 /v1/classify 返回 503，api 那边当作跳过这一层，不影响问答。
import os
from threading import Thread

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


MODEL_NAME = os.getenv("PROMPT_GUARD_MODEL", "meta-llama/Llama-Prompt-Guard-2-86M")
MAX_TOKENS = 512
state = {"status": "loading", "error": None}
runtime = {}
app = FastAPI(title="Prompt Injection Guard")


# 「正常」那一类的下标：Prompt Guard 2 是 benign / malicious 两类，第 1 版是 BENIGN / INJECTION / JAILBREAK 三类。
# 攻击概率 = 1 - 正常的概率，两个版本都适用；标签名里找不到 benign 时按第 0 类算。
def benign_index(config):
    for index, label in (config.id2label or {}).items():
        if "benign" in str(label).lower():
            return int(index)
    return 0


def load():
    try:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        torch.set_num_threads(int(os.getenv("GUARD_THREADS", "2")))
        token = os.getenv("HF_TOKEN") or None
        tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, token=token)
        model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, token=token)
        model.eval()
        runtime.update({"torch": torch, "tokenizer": tokenizer, "model": model, "benign": benign_index(model.config)})
        state.update({"status": "ready", "error": None})
    except Exception as error:
        message = f"{type(error).__name__}: {str(error)[:300]}"
        if "gated" in message.lower() or "401" in message or "403" in message:
            message += "（需要先在 Hugging Face 上同意模型许可，并在 .env 里设置 HF_TOKEN）"
        state.update({"status": "failed", "error": message})


Thread(target=load, daemon=True).start()


class ClassifyInput(BaseModel):
    input: list[str] = Field(min_length=1, max_length=16)


# 每段文字给出攻击概率（0～1）。超过 512 个 token 的长文字切成几段分别判断，取最高的一段：
# 攻击指令常常藏在一段正常内容的后面，只看开头会漏掉。
@app.post("/v1/classify")
def classify(body: ClassifyInput):
    if state["status"] != "ready":
        raise HTTPException(503, f"模型{'还在加载' if state['status'] == 'loading' else '加载失败'}：{state['error'] or MODEL_NAME}")
    torch, tokenizer, model = runtime["torch"], runtime["tokenizer"], runtime["model"]
    data = []
    for index, text in enumerate(body.input):
        encoded = tokenizer(text, truncation=True, max_length=MAX_TOKENS, stride=64, padding=True,
            return_overflowing_tokens=True, return_tensors="pt")
        inputs = {key: value for key, value in encoded.items() if key in ("input_ids", "attention_mask", "token_type_ids")}
        with torch.no_grad():
            probabilities = torch.softmax(model(**inputs).logits, dim=-1)
        attack = 1 - probabilities[:, runtime["benign"]]
        data.append({"index": index, "score": round(float(attack.max()), 4), "windows": int(attack.shape[0])})
    return {"object": "list", "data": data, "model": MODEL_NAME}


# 健康检查只看进程活着（模型下载失败也不让容器反复重启）；模型状态写在返回里，api 据此判断能不能用。
@app.get("/health")
def health():
    return {"status": state["status"], "error": state["error"], "model": MODEL_NAME}
