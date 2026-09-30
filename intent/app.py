import re

from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression


INTENT_EXAMPLES = {
    "order_lookup": [
        "查询订单 A1001",
        "帮我查一下订单状态",
        "我的订单现在到哪里了",
        "查看我的订单",
        "订单什么时候发货",
        "订单物流信息",
        "我想查询订单",
    ],
    "order_follow_up": [
        "它什么时候到",
        "这个订单到货了吗",
        "刚才那个订单呢",
        "这个多久发货",
        "那它现在到哪了",
        "预计哪天送到",
        "这个订单什么时候可以收到",
    ],
    "knowledge_qa": [
        "退货政策是什么",
        "如何申请退款",
        "公司的报销制度",
        "员工请假需要什么材料",
        "售后服务的规定",
        "知识库中的产品说明",
        "合同审批流程是什么",
    ],
    # 业务数据查询：统计、筛选商品、客户、库存、物流单、售后工单、促销活动和评价。
    # 具体查哪种数据、什么条件由 API 里的数据查询工具决定，这里只区分"是不是在查业务数据"。
    "data_query": [
        "哪些商品快缺货了",
        "这周有几单待发货",
        "VIP 客户有多少个",
        "现在有什么促销活动",
        "差评有哪些",
        "待处理的售后工单",
        "运输中的物流单有几个",
        "价格低于 100 的商品",
        "本月订单总金额是多少",
    ],
    "greeting": [
        "你好",
        "您好",
        "hi",
        "hello",
        "在吗",
        "早上好",
        "晚上好",
    ],
}

INTENT_ROUTES = {
    "order_lookup": "order",
    "order_follow_up": "order",
    "data_query": "data",
    "knowledge_qa": "knowledge",
    "greeting": "greeting",
}


def build_model():
    # 使用内置中文样本训练可快速启动的轻量意图分类器。
    texts = []
    labels = []
    for intent, examples in INTENT_EXAMPLES.items():
        for example in examples:
            texts.append(example)
            labels.append(intent)
    vectorizer = TfidfVectorizer(analyzer="char", ngram_range=(1, 3), sublinear_tf=True)
    features = vectorizer.fit_transform(texts)
    classifier = LogisticRegression(max_iter=500, class_weight="balanced", random_state=7)
    classifier.fit(features, labels)
    return vectorizer, classifier


vectorizer, classifier = build_model()
app = FastAPI(title="Local Intent Classifier")


class IntentInput(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[str] = Field(default_factory=list, max_length=3)
    last_order: str | None = Field(default=None, max_length=32)


def confidence_label(value):
    # 把分类概率映射为前端可读的置信度标签。
    if value >= 0.45:
        return "high"
    if value >= 0.35:
        return "medium"
    return "low"


def order_id_from_question(question, last_order):
    # 提取订单号；追问没有订单号时沿用会话记忆。
    match = re.search(r"\b[AB]\d{4}\b", question, re.IGNORECASE)
    if match:
        return match.group().upper()
    return last_order


# 采纳小模型结果的条件：最高概率不低于 MIN_CONFIDENCE，且比第二名至少高 MIN_MARGIN。
MIN_CONFIDENCE = 0.40
MIN_MARGIN = 0.18


@app.post("/v1/intent/classify")
def classify(body: IntentInput):
    # 返回意图、业务路由、置信度和候选类别。
    features = vectorizer.transform([body.question])
    probabilities = classifier.predict_proba(features)[0]
    ranked = []
    for label, probability in zip(classifier.classes_, probabilities):
        ranked.append({"intent": str(label), "probability": round(float(probability), 6)})
    ranked.sort(key=lambda item: item["probability"], reverse=True)
    top = ranked[0]
    second = ranked[1] if len(ranked) > 1 else {"probability": 0.0}
    confidence = float(top["probability"])
    margin = round(confidence - float(second["probability"]), 6)
    accepted = confidence >= MIN_CONFIDENCE and margin >= MIN_MARGIN
    # 返回未采纳的原因，识别过程里据此说明为什么还要交给大模型。
    reject_reason = None
    if confidence < MIN_CONFIDENCE:
        reject_reason = f"置信度低于采纳阈值 {MIN_CONFIDENCE:.2f}"
    elif margin < MIN_MARGIN:
        reject_reason = f"与第二名只差 {margin:.2f}，低于要求的 {MIN_MARGIN:.2f}"

    intent = top["intent"]
    return {
        "route": INTENT_ROUTES[intent],
        "intent": intent,
        "confidence": confidence,
        "confidence_label": confidence_label(confidence),
        "margin": margin,
        "accepted": accepted,
        "reject_reason": reject_reason,
        "order_id": order_id_from_question(body.question, body.last_order),
        "candidates": ranked[:3],
        "model": "tfidf-char-logistic-regression",
    }


@app.get("/health")
def health():
    # 检查分类服务进程是否已经加载模型。
    return {"status": "ready", "model": "tfidf-char-logistic-regression"}
