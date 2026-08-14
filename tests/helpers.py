"""测试共享工具。"""

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
