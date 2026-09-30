import re


class Router:
    """用可解释规则选择问候、订单工具或知识检索。"""

    # 返回路由、意图、置信度和触发规则，供执行链展示。
    # by 为 intent 表示直接采用意图识别的结果；没有 by 的是下面的程序规则（订单号、订单关键词、问候词等）决定的。
    def inspect(self, question, last_order, analysis=None):
        # 意图识别判定为数据查询时优先采用，不再被下面的订单号规则抢走：
        # "A1001 的快递到哪了"含订单号，但问的是物流单。
        if analysis and analysis.get("route") == "data":
            return {"route": "data", "intent": "data_query", "confidence": analysis.get("confidence", "medium"),
                "order_id": last_order, "classifier": analysis.get("classifier", "unknown"),
                "classifier_confidence": analysis.get("classifier_confidence"),
                "candidates": analysis.get("candidates", []),
                "reason": analysis.get("reason", "识别为业务数据查询"), "by": "intent"}
        match = re.search(r"\b[AB]\d{4}\b", question, re.IGNORECASE)
        if match:
            order_id = match.group().upper()
            return {
                "route": "order",
                "intent": "order_lookup",
                "confidence": "high",
                "order_id": order_id,
                "classifier": "rule",
                "reason": "识别到订单编号",
            }
        if analysis and analysis.get("route") in {"order", "knowledge", "greeting"}:
            order_id = analysis.get("order_id") or last_order
            return {"route": analysis["route"], "intent": analysis.get("intent", "knowledge_qa"),
                "confidence": analysis.get("confidence", "medium"), "order_id": order_id,
                "classifier": analysis.get("classifier", "unknown"),
                "classifier_confidence": analysis.get("classifier_confidence"),
                "candidates": analysis.get("candidates", []),
                "reason": analysis.get("reason", "模型完成意图识别"), "by": "intent"}
        if "订单" in question:
            return {
                "route": "order",
                "intent": "order_lookup",
                "confidence": "high",
                "order_id": last_order,
                "classifier": "rule",
                "reason": "问题包含订单关键词，使用当前会话订单记忆",
            }
        if last_order and any(word in question for word in ("它", "到货", "什么时候到")):
            return {
                "route": "order",
                "intent": "order_follow_up",
                "confidence": "medium",
                "order_id": last_order,
                "classifier": "rule",
                "reason": "代词或到货问题命中最近订单记忆",
            }
        if question.strip(" ！!。. ") in {"你好", "您好", "hi", "hello"}:
            return {
                "route": "greeting",
                "intent": "greeting",
                "confidence": "high",
                "order_id": last_order,
                "classifier": "rule",
                "reason": "命中问候词",
            }
        return {
            "route": "knowledge",
            "intent": "knowledge_qa",
            "confidence": "medium",
            "order_id": last_order,
            "classifier": "fallback",
            "reason": "未命中业务工具规则，转知识库检索",
        }

    # 返回路由类型和可选订单号。
    def choose(self, question, last_order):
        decision = self.inspect(question, last_order)
        return decision["route"], decision["order_id"]
