"""在 api 容器里用真实模型跑一次 Agent 模式问答，打印每一轮的关键字段，用来核对模型实际返回的格式。

用法（在项目目录）：
    docker compose exec api python -m scripts.agent_probe "订单 A1001 到哪了？还没签收的话能退货吗？" > reports/agent-probe.json
    docker compose exec api python -m scripts.agent_probe --user alice "退货政策是什么"

走的是正式接口（/sessions、/agent/chat、/agent/runs），和页面上提问完全一样，结果也会写进会话历史和执行记录。
令牌用容器里的 JWT_SECRET 现签，不需要密码；只在本机容器里运行。
"""
import argparse
import json
import os
import sys
from uuid import uuid4

import httpx

from app.auth import create_access_token

API = "http://localhost:8000"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("question")
    parser.add_argument("--user", default="admin")
    args = parser.parse_args()
    token = create_access_token(args.user, os.environ["JWT_SECRET"])
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=API, headers=headers, timeout=300, trust_env=False) as client:
        session_id = client.post("/sessions").json()["session_id"]
        request_id = str(uuid4())
        response = client.post("/agent/chat", json={"session_id": session_id, "request_id": request_id,
            "question": args.question})
        result = response.json() if response.headers.get("content-type", "").startswith("application/json") else response.text
        detail = client.get(f"/agent/runs/{request_id}").json()
    rounds = []
    for record in detail.get("rounds") or []:
        raw = json.loads(record["raw_response"]) if record.get("raw_response") else {}
        message = ((raw.get("choices") or [{}])[0]).get("message") or {}
        rounds.append({
            "round": record["round"], "kind": record["kind"],
            # 模型实际返回的 message 里有哪些字段：确认推理过程是在 reasoning_content、reasoning_details 还是 content 的 <think> 里。
            "message_fields": sorted(message),
            "reasoning": (record.get("reasoning") or "")[:500],
            "content": (record.get("content") or "")[:500],
            "tool_calls": [{"name": call.get("function", {}).get("name"), "arguments": call.get("function", {}).get("arguments")}
                for call in record.get("tool_calls") or []],
            "tool_results": [{"name": item.get("name"), "status": item.get("status"), "content": item.get("content", "")[:300]}
                for item in record.get("tool_results") or []],
            "finish_reason": record.get("finish_reason"), "usage": record.get("usage"),
            "cached_tokens": record.get("cached_tokens"), "model_ms": record.get("model_ms"),
            "citation_check": record.get("citation_check"), "error": record.get("error"),
        })
    output = {"status_code": response.status_code, "answer": result.get("answer") if isinstance(result, dict) else result,
        "agent": result.get("agent") if isinstance(result, dict) else None,
        "run": {key: value for key, value in detail.items() if key != "rounds"}, "rounds": rounds,
        "first_raw_response": (detail.get("rounds") or [{}])[0].get("raw_response")}
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
