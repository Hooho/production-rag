"""查询服务商模型目录；不保存配置，也不调用模型生成内容。"""

import time
from urllib.parse import urlsplit, urlunsplit

import httpx


SUPPORTED_PROVIDERS = {"deepseek", "qwen", "kimi", "openai", "ollama"}


def list_models(provider, base_url, api_key):
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError("该服务商暂未接入模型列表查询，请手动填写模型名称")
    url = urlsplit(base_url.rstrip("/"))
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("请填写有效的服务地址，不包含账号、查询参数或片段")
    path = url.path.rstrip("/")
    if provider == "ollama":
        path = path.removesuffix("/v1") + "/api/tags"
    elif provider == "qwen":
        path = (
            path.removesuffix("/compatible-mode/v1").removesuffix("/api/v1")
            + "/api/v1/models"
        )
    else:
        path += "/models"
    endpoint = urlunsplit((url.scheme, url.netloc, path, "", ""))
    headers = {"Authorization": f"Bearer {api_key}"} if provider != "ollama" else {}
    names = set()
    started = time.monotonic()
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        for page in range(1, 101):
            if time.monotonic() - started > 30:
                raise ValueError("查询模型列表超时，请重试")
            params = (
                {"page_no": page, "page_size": 100, "capabilities": "TG"}
                if provider == "qwen"
                else None
            )
            response = client.get(endpoint, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("模型列表响应格式无效，请手动填写或重试")
            if provider == "qwen":
                output = data.get("output")
                if data.get("success") is False or not isinstance(output, dict):
                    raise ValueError(
                        "百炼模型列表查询失败，请检查密钥及业务空间服务地址"
                    )
                rows, field = output.get("models"), "model"
            else:
                rows, field = (
                    (data.get("models"), "name")
                    if provider == "ollama"
                    else (data.get("data"), "id")
                )
            if not isinstance(rows, list):
                raise ValueError("模型列表响应格式无效，请手动填写或重试")
            for row in rows:
                name = row.get(field) if isinstance(row, dict) else None
                if not isinstance(name, str) or not name.strip():
                    raise ValueError("模型列表响应缺少有效的模型名称")
                names.add(name.strip())
            if provider != "qwen":
                return sorted(names)
            total = output.get("total")
            if not isinstance(total, int) or total < 0:
                raise ValueError("百炼模型列表响应缺少有效的分页总数")
            if page * 100 >= total:
                return sorted(names)
            if not rows:
                raise ValueError("百炼模型列表分页不完整，请重试")
    raise ValueError("模型列表页数过多，请手动填写模型名称")
