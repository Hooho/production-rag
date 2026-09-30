import os
from uuid import uuid4

import httpx


# 用用户名密码登录，返回带访问令牌的请求头。原来直接使用 .env 里的 API Key。
def login(client, username, password):
    response = client.post("/auth/login", json={"username": username, "password": password})
    response.raise_for_status()
    return {"Authorization": "Bearer " + response.json()["access_token"]}


# 导入两份私有资料，演示检索、工具、记忆、幂等及越权拒绝。
def main():
    base = os.getenv("API_URL", "http://localhost:8000")
    with httpx.Client(base_url=base, timeout=90) as client:
        alice = login(client, "alice", os.environ["ALICE_PASSWORD"])
        bob = login(client, "bob", os.environ["BOB_PASSWORD"])
        document = client.post("/documents", headers=alice, json={"title": "售后制度",
            "content": "退货政策：商品签收后 7 天内可以申请退货。商品需保持完好，退货运费由买家承担。"})
        document.raise_for_status()
        private = client.post("/documents", headers=bob, json={"title": "Bob 私有资料",
            "content": "退货政策：Bob 的专属退货期限为 30 天。内部识别码 BOB-PRIVATE。"})
        private.raise_for_status()
        response = client.post("/sessions", headers=alice)
        response.raise_for_status()
        session_id = response.json()["session_id"]
        for question in ("退货政策是什么？", "查询订单 A1001", "它什么时候到？", "查询订单 B2001"):
            payload = {"session_id": session_id, "request_id": str(uuid4()), "question": question}
            response = client.post("/chat", headers=alice, json=payload)
            response.raise_for_status()
            result = response.json()
            assert "BOB-PRIVATE" not in str(result)
            repeated = client.post("/chat", headers=alice, json=payload)
            repeated.raise_for_status()
            assert repeated.json() == result
            print(f"\n问题：{question}\n路由：{result['route']}\n回答：{result['answer']}")
        denied = client.get(f"/sessions/{session_id}", headers=bob)
        assert denied.status_code == 404
        print("\n验证通过：重复请求返回原结果，Bob 无法读取 Alice 的会话。")


if __name__ == "__main__":
    main()
