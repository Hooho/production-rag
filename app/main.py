"""兼容入口；实际 API 路由位于 app.api.main。"""

from .api.main import app, create_app

__all__ = ["app", "create_app"]
