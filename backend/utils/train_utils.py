"""模型类型识别与训练数据目录校验。

safetensors 读取头部 JSON，对键名做"整键或点/下划线分段前缀"匹配；
老式 .ckpt/.pt 只对文件头部做字节探测（不反序列化，避免 pickle 风险）。
新增模型家族时只需向 KEY_SIGNATURES / LEGACY_PROBES 各加一行。
"""
from __future__ import annotations

import json
import os
import re
from enum import Enum
from pathlib import Path
from typing import Dict, Iterator, Optional

from backend.log import log


class ModelType(Enum):
    UNKNOWN = -1
    SD15 = 1
    SD2 = 2
    SDXL = 3
    SD3 = 4
    FLUX = 5
    LUMINA = 6
    ANIMA = 7
    LoRA = 10


# 顺序即优先级：特征越具体的家族越靠前（LoRA 键是通用前缀，必须最后判）
KEY_SIGNATURES = (
    (ModelType.ANIMA, (
        "llm_adapter.out_proj.weight",
        "t_embedding_norm.scale",
        "blocks.0.adaln_modulation.1.weight",
    )),
    (ModelType.LUMINA, (
        "cap_embedder.0.weight",
        "context_refiner.0.attention.k_norm.weight",
    )),
    (ModelType.FLUX, (
        "double_blocks.0.img_mlp.0.weight",
        "guidance_in.in_layer.weight",
        "model.diffusion_model.double_blocks",
        "double_blocks.0.img_attn.norm.query_norm.scale",
    )),
    (ModelType.SD3, (
        "model.diffusion_model.x_embedder.proj.weight",
        "model.diffusion_model.joint_blocks.0.context_block.attn.proj.weight",
    )),
    (ModelType.SDXL, (
        "conditioner.embedders.1.model.transformer.resblocks",
    )),
    (ModelType.SD15, (
        "model.diffusion_model",
        "cond_stage_model.transformer.text_model",
    )),
    (ModelType.LoRA, (
        "lora_te_text_model_encoder",
        "lora_unet_up_blocks",
        "lora_unet_input_blocks_4_1_transformer_blocks_0_attn1_to_k.alpha",
        "lora_unet_input_blocks_4_1_transformer_blocks_0_attn1_to_k.lora_up.weight",
        "lora_unet",
        "lora_te",
        "lora_A.weight",
    )),
)

# .ckpt/.pt 头部字节探测（顺序同理）
LEGACY_PROBES = (
    (ModelType.FLUX, (b"model.diffusion_model.double_blocks",
                      b"double_blocks.0.img_attn.norm.query_norm.scale")),
    (ModelType.SD3, (b"model.diffusion_model.x_embedder.proj.weight",)),
    (ModelType.SDXL, (b"conditioner.embedders.1.model.transformer.resblocks",)),
    (ModelType.SD15, (b"model.diffusion_model", b"cond_stage_model.transformer.text_model")),
    (ModelType.LoRA, (b"lora_unet", b"lora_te")),
)

# 训练用底模类型白名单（LoRA 产物不能当底模）
BASE_MODEL_TYPES = frozenset({
    ModelType.SD15, ModelType.SD2, ModelType.SD3, ModelType.SDXL,
    ModelType.FLUX, ModelType.LUMINA, ModelType.ANIMA,
})

_IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
# 数据集子目录命名："repeat_名称"，如 10_zkz
_DATASET_DIR_RE = re.compile(r"^\d+_.+")
# 采样 prompt 里的功能开关（--n 负面词 / --s 步数 / --l 权重 / --d 种子）
_PROMPT_FLAGS = ("--n", "--s", "--l", "--d")


def _key_matches(key: str, signature: str) -> bool:
    """整键相等，或签名是键的"."/"_"分段前缀（避免子串误配，如 lora_te 命中 lora_te2）。"""
    return key == signature or key.startswith(signature + ".") or key.startswith(signature + "_")


def _classify_keys(keys) -> ModelType:
    key_list = list(keys)
    for model_type, signatures in KEY_SIGNATURES:
        if any(_key_matches(key, sig) for sig in signatures for key in key_list):
            return model_type
    return ModelType.UNKNOWN


def _read_safetensors_header(path: str) -> Optional[Dict]:
    """解析 safetensors 头部 JSON；文件不存在或损坏时返回 None。"""
    try:
        with open(path, "rb") as f:
            header_len = int.from_bytes(f.read(8), "little")
            return json.loads(f.read(header_len))
    except (OSError, ValueError) as e:
        log.warning(f"model file {path} can't open: {e}")
        return None


def _probe_legacy_checkpoint(path: str) -> ModelType:
    with open(path, "rb") as f:
        head = f.read(1024 * 1024)
    for model_type, needles in LEGACY_PROBES:
        if any(needle in head for needle in needles):
            return model_type
    return ModelType.UNKNOWN


def guess_model_type(path: str) -> ModelType:
    if path.endswith(".safetensors"):
        header = _read_safetensors_header(path)
        if header is None:
            return ModelType.UNKNOWN
        return _classify_keys(header.keys())
    if path.endswith((".pt", ".ckpt")):
        try:
            return _probe_legacy_checkpoint(path)
        except OSError as e:
            log.warning(f"model file {path} can't open: {e}")
    return ModelType.UNKNOWN


def validate_model(model_name: str, training_type: str = "sdxl-lora"):
    """校验底模输入。返回 (是否可用, 提示信息)。HF 仓库名（如 org/repo）直接放行。"""
    if os.path.isdir(model_name):
        # diffusers 目录含 model_index.json；路径里带 unet 的多半是拆好的组件目录
        if "model_index.json" not in os.listdir(model_name) and "unet" not in model_name:
            log.warning(f"目录里没看到 model_index.json，请确认这是完整的 HF 模型目录 / "
                        f"model_index.json not found under {model_name}, is this a complete HF model folder?")
        return True, "ok"

    if os.path.isfile(model_name):
        model_type = guess_model_type(model_name)
        if model_type == ModelType.UNKNOWN:
            log.error(f"无法从键名识别模型类型：{model_name} / Can't recognize model type from {model_name}")
        if model_type not in BASE_MODEL_TYPES:
            return False, ("Pretrained model is not a Stable Diffusion, Flux, Lumina or Anima checkpoint "
                           "/ 校验失败：底模不是支持的模型类型")
        return True, "ok"

    if model_name.count("/") == 1 \
            and model_name[0] not in (".", "/") \
            and model_name.rsplit(".", 1)[-1] not in ("pt", "pth", "ckpt", "safetensors"):
        return True, "ok"

    return False, "model not found"


def validate_data_dir(path: str) -> bool:
    """校验训练数据目录：需存在，且含 `数字_名称` 格式的子目录；没有的话给出可操作的修复提示。"""
    if not os.path.isdir(path):
        log.error(f"数据目录不存在：{path}（请检查参数）/ Data dir {path} does not exist, check your params")
        return False

    with os.scandir(path) as entries:
        subdirs = [e.name for e in entries if e.is_dir()]
    if not subdirs:
        log.warning("No subdir found in data dir")

    legal = [name for name in subdirs if _DATASET_DIR_RE.match(name)]
    if legal:
        log.info(f"Found {len(legal)} legal dataset")
        return True

    log.warning(f"No legal dataset found in {path}")
    if count_images(path, recursive=False, stop_after=1) > 0:
        img_count = count_images(path, recursive=False)
        repeat = suggest_num_repeat(img_count)
        log.error(
            f"Dataset directory '{path}' has images but no subdirectory with repeat prefix (e.g., '{repeat}_zkz'). "
            f"Please organize your dataset: create a subdirectory like '{path}/{repeat}_zkz' and move images into it."
        )
    else:
        log.error(f"No images found in {path}")
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
