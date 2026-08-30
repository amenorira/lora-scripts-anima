"""训练输入校验：底模路径预检与训练数据目录检查。

底模只做路径预检（存在即可，HF 仓库名放行），能否加载由训练核心自己校验。
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterator, Optional

from backend.log import log


_IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
# 数据集子目录命名："repeat_名称"，如 10_zkz
_DATASET_DIR_RE = re.compile(r"^\d+_.+")
# 采样 prompt 里的功能开关（--n 负面词 / --s 步数 / --l 权重 / --d 种子）
_PROMPT_FLAGS = ("--n", "--s", "--l", "--d")


def validate_model(model_name: str):
    """底模路径预检：存在即可，能否加载由训练核心自己校验。
    返回 (是否可用, 提示信息)。HF 仓库名（如 org/repo）直接放行。
    """
    if os.path.isdir(model_name):
        # diffusers 目录含 model_index.json；路径里带 unet 的多半是拆好的组件目录
        if "model_index.json" not in os.listdir(model_name) and "unet" not in model_name:
            log.warning(f"model_index.json not found under {model_name}, is this a complete HF model folder? / "
                        f"目录里没看到 model_index.json，请确认这是完整的 HF 模型目录")
        return True, "ok"

    if os.path.isfile(model_name):
        return True, "ok"

    if model_name.count("/") == 1 \
            and model_name[0] not in (".", "/") \
            and model_name.rsplit(".", 1)[-1] not in ("pt", "pth", "ckpt", "safetensors"):
        return True, "ok"

    return False, "Validation failed: base model file not found, check the path / 校验失败：找不到底模文件，请检查路径"


def validate_data_dir(path: str) -> bool:
    """校验训练数据目录：需存在，且含 `数字_名称` 格式的子目录；没有的话给出可操作的修复提示。"""
    if not os.path.isdir(path):
        log.error(f"Data dir {path} does not exist, check your params / 数据目录不存在：{path}（请检查参数）")
        return False

    with os.scandir(path) as entries:
        subdirs = [e.name for e in entries if e.is_dir()]
    if not subdirs:
        log.warning("No subdir found in data dir / 数据目录下没有子目录")

    legal = [name for name in subdirs if _DATASET_DIR_RE.match(name)]
    if legal:
        log.info(f"Found {len(legal)} legal dataset subdirs / 找到 {len(legal)} 个合规数据集子目录")
        return True

    log.warning(f"No legal dataset subdir found in {path} / 在 {path} 中未找到合规数据集子目录")
    if count_images(path, recursive=False, stop_after=1) > 0:
        img_count = count_images(path, recursive=False)
        repeat = suggest_num_repeat(img_count)
        log.error(
            f"Images present but no repeat-prefixed subdir, create '{path}/{repeat}_zkz' and move images into it / "
            f"数据目录 '{path}' 里有图片但没有 repeat 前缀子目录（如 '{repeat}_zkz'），请建立该子目录并移入图片"
        )
    else:
        log.error(f"No images found in {path} / 在 {path} 中没有找到图片")
    return False


def suggest_num_repeat(img_count: int) -> int:
    """按图片数量推荐 repeat 值：图越少重复越多。"""
    for upper_bound, repeat in ((10, 7), (50, 5), (100, 3)):
        if img_count <= upper_bound:
            return repeat
    return 1


def _iter_images(path: str, recursive: bool) -> Iterator[Path]:
    iterator = Path(path).rglob("*") if recursive else Path(path).glob("*")
    return (p for p in iterator if p.is_file() and p.suffix.lower() in _IMAGE_EXTS)


def count_images(path: str, recursive: bool = True, stop_after: Optional[int] = None) -> int:
    """统计图片数；stop_after 命中即提前返回，避免为阈值判断遍历整个数据集。"""
    count = 0
    for _ in _iter_images(path, recursive):
        count += 1
        if stop_after is not None and count >= stop_after:
            break
    return count


def is_prompt_like(s: str) -> bool:
    """判断采样串里是否带 --n/--s/--l/--d 这类功能开关。"""
    return any(flag in s for flag in _PROMPT_FLAGS)


_FLOAT_CONFIG_KEYS = ("guidance_scale", "sigmoid_scale", "discrete_flow_shift")


def fix_config_types(config: dict) -> None:
    """TOML/JSON 里可能被写成字符串的浮点参数，就地转回 float。"""
    for key in _FLOAT_CONFIG_KEYS:
        if key in config:
            config[key] = float(config[key])
