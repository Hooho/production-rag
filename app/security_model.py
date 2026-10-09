# 输入安全检查的第三层：交给注入检测模型判断（guard 服务，默认 Llama Prompt Guard 2）。
#
# 三层的顺序：规则 → 攻击样本向量 → 模型。越便宜、越确定的放前面：规则只认固定写法，样本库认得「意思接近的已知攻击」，
# 模型兜住没见过的新写法。前两层已经拦下的问题不再交给模型；第二层只记录没拦的，仍然交给模型判断。
#
# 模型给出 0～1 的攻击概率，超过阈值时按设置拦截或只记录（设置页「安全检查」）。模型判断为攻击的问题进「安全样本」
# 的待确认，管理员确认后加入样本库，下次同类的问题在第二层就能拦下，不用再等模型。
#
# guard 服务没部署（没有设置 GUARD_URL）、还在加载、或调用出错时，这一层跳过，不影响问答。
import logging
import os
import time

import httpx

from .runtime_config import value as runtime_value


logger = logging.getLogger("production-rag-security")


class InjectionModel:
    def __init__(self, url=None):
        # GUARD_URL 形如 http://guard:8092；不设置就不调用（本地开发、测试不需要这个服务）。
        self.url = (url if url is not None else os.getenv("GUARD_URL", "")).rstrip("/")

    def deployed(self):
        return bool(self.url)

    # 服务状态：ready 可用、loading 正在下载或加载模型、failed 加载失败（带原因）、unreachable 连不上、missing 没部署。
    def health(self, timeout=1.5):
        if not self.url:
            return {"status": "missing"}
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(self.url + "/health")
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as error:
            return {"status": "unreachable", "error": f"{type(error).__name__}"}

    def score(self, text, timeout=3.0):
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=1.0)) as client:
            response = client.post(self.url + "/v1/classify", json={"input": [text]})
            if response.status_code == 503:
                raise RuntimeError(response.json().get("detail") or "模型还没加载好")
            response.raise_for_status()
            body = response.json()
            return float(body["data"][0]["score"]), body.get("model")

    # 一次判断多段文字（导入文档时扫描分片用），返回每段的攻击概率。guard 服务每次最多收 16 段，这里分批发。
    def score_many(self, texts, timeout=30.0):
        scores = []
        model = None
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=1.0)) as client:
            for start in range(0, len(texts), 16):
                response = client.post(self.url + "/v1/classify", json={"input": texts[start:start + 16]})
                if response.status_code == 503:
                    raise RuntimeError(response.json().get("detail") or "模型还没加载好")
                response.raise_for_status()
                body = response.json()
                model = body.get("model")
                for item in sorted(body["data"], key=lambda item: item["index"]):
                    scores.append(float(item["score"]))
        return scores, model

    # 输入安全检查调用：返回攻击概率、阈值和处置（block 拦截 / log 只记录 / None 低于阈值）。
    # 关闭时返回 None；没部署、调用失败时返回 skipped 或 error，这一层跳过。
    def check(self, question):
        if not runtime_value("injection_model_enabled"):
            return None
        threshold = runtime_value("injection_model_threshold")
        mode = runtime_value("injection_model_action")
        result = {"threshold": threshold, "mode": mode}
        if not self.url:
            return {**result, "skipped": "没有部署注入检测模型服务（GUARD_URL 未设置）"}
        started = time.monotonic()
        try:
            score, model = self.score(question)
        except Exception as error:
            logger.warning("injection_model_failed error=%s", error)
            return {**result, "error": f"{type(error).__name__}: {str(error)[:200]}"}
        action = (mode if mode in ("block", "log") else "log") if score >= threshold else None
        return {**result, "score": round(score, 4), "model": model, "action": action,
            "duration_ms": round((time.monotonic() - started) * 1000)}


# 写进输入安全检查清单里的一项，前端按清单显示第三层。
def catalog_entry(result=None, skipped=None):
    entry = {"rule": "model_judged", "label": "注入检测模型判断", "examples": [], "model_check": result or {}}
    if skipped:
        entry["description"] = skipped
        entry["model_check"] = {**(result or {}), "skipped": skipped}
    elif result.get("skipped"):
        entry["description"] = f"{result['skipped']}，跳过。"
    elif result.get("error"):
        entry["description"] = f"模型调用失败，跳过（{result['error']}）。"
    else:
        score = f"攻击概率 {result['score']:.2f}，阈值 {result['threshold']:.2f}"
        name = f"{result['model'].split('/')[-1]} " if result.get("model") else ""
        if result["action"] == "block":
            entry["description"] = f"{name}判断为注入攻击（{score}），已拦截。"
        elif result["action"] == "log":
            entry["description"] = f"{name}判断为注入攻击（{score}）。当前是只记录模式，没有拦截。"
        else:
            entry["description"] = f"{name}判断为正常问题（{score}），放行。"
    return entry
