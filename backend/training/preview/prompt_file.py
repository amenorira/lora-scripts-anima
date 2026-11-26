"""Snapshot external sd-scripts prompts before starting the trainer processes."""
import json
from pathlib import Path
import re
import sys
import tomllib


def _scheduled_entry(entry):
    if isinstance(entry, dict):
        return entry.get("sample_steps") != 0
    # Line-format prompts use the last --s option, just like sd-scripts.
    steps = re.findall(r"(?:^| --)s (\d+)", entry, re.IGNORECASE)
    return not steps or int(steps[-1]) != 0


def require_scheduled_prompt(entries):
    if not any(_scheduled_entry(entry) for entry in entries):
        raise ValueError("MOSS scheduled previews require a non-reserved prompt / MOSS 自动预览至少需要一条非保留提示词")


def _validate_prompt(path: Path, index: int, entry: dict, *, moss: bool) -> None:
    # Cached text encoders read the field directly; an omitted negative prompt uses "".
    if entry.get("negative_prompt") is None:
        entry.pop("negative_prompt", None)
    for key, value in entry.items():
        if value is None and key in ("seed", "controlnet_image", "image"):
            continue
        if key in ("prompt", "negative_prompt", "sample_sampler", "controlnet_image", "image"):
            valid = isinstance(value, str)
            expected = "text / 文本"
        elif key in ("width", "height", "sample_steps"):
            minimum = 0 if key == "sample_steps" else 1
            valid = type(value) is int and value >= minimum
            expected = f"integer >= {minimum} / 不小于 {minimum} 的整数"
        elif key == "seed":
            valid = type(value) is int and -(2**63) <= value < 2**64
            expected = "integer seed in [-2^63, 2^64-1] / 有效的整数种子"
        elif key in ("scale", "flow_shift", "guidance_scale"):
            if moss and key == "flow_shift":
                # MOSS reads this field with float() before sampling.
                try:
                    value = entry[key] = float(value)
                except (TypeError, ValueError, OverflowError):
                    value = None
            valid = type(value) in (int, float) and -sys.float_info.max <= value <= sys.float_info.max
            expected = "finite number / 有限数值"
        else:
            continue
        if not valid:
            raise ValueError(f"{path}: prompt #{index}, {key}: expected {expected}")


def read_prompt_entries(path: Path, *, moss: bool = False) -> list:
    """Read the supported containers. String entries still use the trainer's line parser."""
    suffix = path.suffix.lower()
    if suffix not in (".txt", ".json", ".toml"):
        raise ValueError(f"{path}: expected .txt, .json or .toml / 提示词文件须为 TXT、JSON 或 TOML 格式")
    text = path.read_text(encoding="utf-8-sig")
    if suffix == ".txt":
        entries = [line.strip() for line in text.split("\n") if line.strip() and not line.startswith("#")]
    elif suffix == ".json":
        entries = json.loads(text)
    else:
        prompt = tomllib.loads(text).get("prompt")
        if not isinstance(prompt, dict) or not isinstance(prompt.get("subset"), list):
            raise ValueError(f"{path}: expected [[prompt.subset]] / 缺少提示词子表")
        subsets = prompt.pop("subset")
        if not all(isinstance(subset, dict) for subset in subsets):
            raise ValueError(f"{path}: invalid prompt subset / 提示词子表无效")
        entries = [prompt | subset for subset in subsets]
    if not isinstance(entries, list):
        raise ValueError(f"{path}: expected a list of prompts / 提示词须为字符串或对象列表")
    for index, entry in enumerate(entries, 1):
        if isinstance(entry, dict):
            _validate_prompt(path, index, entry, moss=moss)
        elif not isinstance(entry, str):
            raise ValueError(f"{path}: prompt #{index}: expected text or object / 提示词须为字符串或对象")
    return entries
