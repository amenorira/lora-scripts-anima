"""测试共享工具。"""

import json
from starlette.requests import Request

from backend.training.field_registry import FIELDS


def config_from_field_defaults(**overrides) -> dict:
    """从字段注册表默认值构建配置，再叠加测试特定的覆盖项。"""
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update(overrides)
    return config


def json_request(payload) -> Request:
    """Exercise routes with the real ASGI JSON boundary."""
    async def receive():
        return {"type": "http.request", "body": json.dumps(payload).encode("utf-8")}

    return Request({"type": "http", "method": "POST", "path": "/"}, receive)
