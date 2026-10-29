import httpx
import pytest

from app import model_catalog


@pytest.mark.parametrize(
    "provider,base,path,body",
    [
        (
            "deepseek",
            "https://api.deepseek.com",
            "/models",
            {"data": [{"id": "deepseek-flash"}]},
        ),
        (
            "kimi",
            "https://api.moonshot.cn/v1/",
            "/v1/models",
            {"data": [{"id": "kimi-k3"}]},
        ),
        (
            "openai",
            "https://api.openai.com/v1",
            "/v1/models",
            {"data": [{"id": "gpt-test"}]},
        ),
        (
            "ollama",
            "http://host.docker.internal:11434/v1",
            "/api/tags",
            {"models": [{"name": "qwen3:8b"}]},
        ),
    ],
)
def test_provider_endpoints(monkeypatch, provider, base, path, body):
    def respond(request):
        assert request.url.path == path
        assert request.headers.get("Authorization") == (
            None if provider == "ollama" else "Bearer secret"
        )
        return httpx.Response(200, json=body)

    client = httpx.Client
    monkeypatch.setattr(
        model_catalog.httpx,
        "Client",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    assert len(model_catalog.list_models(provider, base, "secret")) == 1


def test_qwen_native_pagination(monkeypatch):
    pages = []

    def respond(request):
        assert str(request.url).startswith(
            "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/models?"
        )
        assert request.url.params["capabilities"] == "TG"
        page = int(request.url.params["page_no"])
        pages.append(page)
        return httpx.Response(
            200,
            json={
                "success": True,
                "output": {
                    "total": 101,
                    "models": [{"model": "qwen-plus"}, {"model": f"qwen-{page}"}],
                },
            },
        )

    client = httpx.Client
    monkeypatch.setattr(
        model_catalog.httpx,
        "Client",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    assert model_catalog.list_models(
        "qwen",
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "secret",
    ) == ["qwen-1", "qwen-2", "qwen-plus"]
    assert pages == [1, 2]


@pytest.mark.parametrize("body", [[], {}, {"data": "bad"}, {"data": [{}]}])
def test_reject_invalid_response(monkeypatch, body):
    client = httpx.Client
    monkeypatch.setattr(
        model_catalog.httpx,
        "Client",
        lambda **kwargs: client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json=body)
            ),
            **kwargs,
        ),
    )
    with pytest.raises(ValueError):
        model_catalog.list_models("deepseek", "https://api.deepseek.com", "secret")


def test_reject_unsupported_provider_and_credentials_in_url():
    with pytest.raises(ValueError):
        model_catalog.list_models("minimax", "https://api.minimaxi.com/v1", "secret")
    with pytest.raises(ValueError):
        model_catalog.list_models(
            "openai", "https://user:password@example.com/v1", "secret"
        )
