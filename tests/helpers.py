"""测试共享工具。"""

import json
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import Mock, patch
from starlette.requests import Request

from backend.training.fields.field_registry import FIELDS


def config_from_field_defaults(**overrides) -> dict:
    """从字段注册表默认值构建配置，再叠加测试特定的覆盖项。"""
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update(overrides)
    return config


def valid_training_config(model_train_type="anima-lora", **overrides) -> dict:
    """Common valid schema inputs; individual tests own their overrides."""
    config = config_from_field_defaults(
        model_train_type=model_train_type,
        network_module="networks.lora_anima" if model_train_type == "anima-lora" else "networks.lora",
        pretrained_model_name_or_path="model.safetensors",
        vae="vae.safetensors", qwen3="qwen3.safetensors",
        train_data_dir="train", resolution="1024,768", output_name="test", output_dir="output",
    )
    config.update(overrides)
    return config


@contextmanager
def stub_supervisor():
    """Isolate launcher bookkeeping while keeping task execution real."""
    from backend.training.execution import supervisor

    with ExitStack() as stack:
        for name, options in (
            ("_get_trainer_script", {"return_value": Path("trainer.py")}),
            ("get_engine", {"return_value": Mock(python_executable=None)}),
            ("save_config_snapshot", {}),
            ("_build_train_env", {"return_value": {}}),
            ("_read_run_meta", {"return_value": {}}),
            ("_log_run_start", {}),
            ("_log_run_end", {}),
        ):
            stack.enter_context(patch.object(supervisor, name, **options))
        yield supervisor


def json_request(payload) -> Request:
    """Exercise routes with the real ASGI JSON boundary."""
    async def receive():
        return {"type": "http.request", "body": json.dumps(payload).encode("utf-8")}

    return Request({"type": "http", "method": "POST", "path": "/"}, receive)
