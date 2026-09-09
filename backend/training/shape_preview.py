"""Inspect the actual Anima network constructors without allocating model weights."""
import ast
import copy
import importlib
import inspect
import json
import logging
import math
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SUPPORTED = {"networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"}
_pool = None


def preview_pool():
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=1)
    return _pool


def close_preview_pool():
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None


def _anima_config():
    # Read the same fixed architecture as the training loader, without loading weights.
    source = ROOT / "vendor/sd-scripts/library/anima_utils.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "dit_config" for t in node.targets):
            return {ast.literal_eval(k): ({"attn_mode": "torch", "split_attn": False}[v.id]
                    if isinstance(v, ast.Name) else ast.literal_eval(v))
                    for k, v in zip(node.value.keys, node.value.values)}
    raise ValueError("Anima architecture configuration was not found")


def _capture_options(constructor):
    signature = inspect.signature(constructor)

    def wrapped(self, *args, **kwargs):
        bound = signature.bind(self, *args, **kwargs)
        bound.apply_defaults()
        constructor(self, *args, **kwargs)
        self._preview_options = {**bound.arguments.get("kwargs", {}), **bound.arguments}

    return wrapped


def inspect_network(form):
    """Keep constructor chatter out of the console in the isolated preview worker."""
    previous_level = logging.root.manager.disable
    loggers = [logging.getLogger(name) for name in ("LyCORIS", "networks.lokr")]

    def preview_filter(record):
        message = record.getMessage()
        expected_notice = message.startswith("UNet: No modules matched the following target module classes:") or re.fullmatch(
            r"(?:LoKr: )?lora_dim \d+ is (?:too )?large for dim=\d+ and factor=-?\d+, using full matrix mode\.", message
        )
        return not (record.levelno == logging.WARNING and expected_notice)

    for logger in loggers:
        logger.addFilter(preview_filter)
    logging.disable(max(previous_level, logging.INFO))
    try:
        return _inspect_network(form)
    finally:
        logging.disable(previous_level)
        for logger in loggers:
            logger.removeFilter(preview_filter)


def _inspect_network(form):
    """Runs in a dedicated CPU worker; FakeTensorMode also handles DoRA initialization."""
    from backend.training.adapter import adapt_config

    if form.get("model_train_type") != "anima-lora":
        raise ValueError("Only Anima adapter training is supported / 仅支持 Anima 适配器训练")
    config, _ = adapt_config(copy.deepcopy(form))
    module_name = config.get("network_module")
    if module_name not in SUPPORTED:
        raise ValueError("Unsupported custom network / 暂不支持此自定义网络")
    if config.get("dim_from_weights"):
        raise ValueError("Dimensions from checkpoint cannot be estimated / 暂不支持从已有权重推导结构")
    if config.get("save_model_as", "safetensors") != "safetensors":
        raise ValueError("File size estimation requires safetensors / 文件大小估算仅支持 safetensors")

    for path in (ROOT / "vendor", ROOT / "vendor/sd-scripts"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    import torch
    from torch._subclasses.fake_tensor import FakeTensorMode
    from library.anima_models import Anima

    network_module = importlib.import_module(module_name)
    kwargs = dict(item.split("=", 1) for item in config.get("network_args", []) if "=" in item)
    rank = int(config.get("network_dim", 4))
    alpha = float(config.get("network_alpha", 1))
    if rank < 1 or not math.isfinite(alpha):
        raise ValueError("Invalid dim or alpha / dim 或 alpha 无效")
    precision = config.get("save_precision") or ("bf16" if config.get("full_bf16") else "fp16" if config.get("full_fp16") else "float")
    bytes_per = {"fp16": 2, "bf16": 2, "float": 4, "fp32": 4}.get(precision)
    if bytes_per is None:
        raise ValueError("Unknown save precision / 无法识别保存精度")
    with FakeTensorMode():
        model = Anima(**_anima_config())
        originals = {id(m): (name, m) for name, m in model.named_modules()}
        text_encoders = []
        if not config.get("network_train_unet_only"):
            from transformers import Qwen3Config, Qwen3Model

            qwen_path = Path(config.get("qwen3") or "")
            config_path = qwen_path / "config.json" if qwen_path.is_dir() and config.get("qwen3") else ROOT / "vendor/sd-scripts/configs/qwen3_06b/config.json"
            qwen_config = json.loads(config_path.read_text(encoding="utf-8"))
            if qwen_config.get("model_type") != "qwen3":
                raise ValueError("Unknown text encoder architecture / 不支持此文本编码器结构")
            encoder = Qwen3Model(Qwen3Config(**qwen_config))
            text_encoders.append(encoder)
            originals.update({id(m): (f"qwen3.{name}", m) for name, m in encoder.named_modules()})
        with ExitStack() as stack:
            if module_name == "lycoris.kohya":
                # Presets mutate these class attributes; restore them even on failure.
                cls = network_module.LycorisNetworkKohya
                for key in ("ENABLE_CONV", "UNET_TARGET_REPLACE_MODULE", "UNET_TARGET_REPLACE_NAME",
                            "TEXT_ENCODER_TARGET_REPLACE_MODULE", "TEXT_ENCODER_TARGET_REPLACE_NAME",
                            "MODULE_ALGO_MAP", "NAME_ALGO_MAP", "USE_FNMATCH", "TARGET_EXCLUDE_NAME"):
                    stack.enter_context(patch.object(cls, key, copy.deepcopy(getattr(cls, key))))
            for class_name in ("LoRAModule", "LoConModule", "LoHaModule", "LohaModule", "LoKrModule", "LokrModule"):
                cls = getattr(network_module, class_name, None)
                if cls is not None:
                    stack.enter_context(patch.object(cls, "__init__", _capture_options(cls.__init__)))
            network = network_module.create_network(1.0, rank, alpha, None, text_encoders, model, **kwargs)
        groups = {}
        header = {}
        offset = 0
        total_params = 0
        full_count = 0
        adapters = ([] if config.get("network_train_text_encoder_only") else network.unet_loras) + network.text_encoder_loras
        for adapter in adapters:
            original = getattr(adapter, "org_module", None)
            if original is None:
                original = adapter.org_module_ref[0]
            if isinstance(original, (list, tuple)):
                original = original[0]
            name, original = originals[id(original)]
            if not isinstance(original, torch.nn.Linear):
                raise ValueError(f"Unsupported preview module / 暂不支持此模块预览: {name}")
            algo_class = type(adapter).__name__
            algo = {"LoRAModule": "lora", "LoConModule": "lora", "LoHaModule": "loha", "LohaModule": "loha", "LoKrModule": "lokr", "LokrModule": "lokr"}.get(algo_class)
            if algo is None:
                raise ValueError(f"Unsupported per-module algorithm / 暂不支持此逐层算法: {algo_class}")
            # Native adapters register the original module until apply_to().
            if "org_module" in adapter._modules:
                del adapter.org_module
            params = sum(p.numel() for p in adapter.parameters())
            saved = adapter.state_dict()
            shapes = {k: list(v.shape) for k, v in saved.items()}
            saved_elements = sum(v.numel() for v in saved.values())
            for key, tensor in saved.items():
                size = tensor.numel() * bytes_per
                header[f"{adapter.lora_name}.{key}"] = {"dtype": {"fp16": "F16", "bf16": "BF16"}.get(precision, "F32"), "shape": list(tensor.shape), "data_offsets": [offset, offset + size]}
                offset += size
            local_rank = int(adapter.lora_dim)
            options = adapter._preview_options
            scale = float(adapter.scale)
            w2_full = algo == "lokr" and "lokr_w2" in shapes
            local_alpha = options.get("alpha")
            if local_alpha is None or local_alpha == 0 or (w2_full and "lokr_w1" in shapes):
                local_alpha = local_rank
            full_count += int(w2_full)
            group_name = re.sub(r"((?:blocks|layers)\.)\d+", r"\1*", name)
            details = {"name": group_name, "in": original.in_features, "out": original.out_features,
                       "algo": algo, "rank": local_rank, "alpha": float(local_alpha), "scale": scale, "shapes": shapes,
                       "params": params, "weightBytes": saved_elements * bytes_per,
                       "w2Full": w2_full, "factor": int(options.get("factor", -1)),
                       "decomposeBoth": bool(options.get("decompose_both", False)),
                       "unbalanced": bool(options.get("unbalanced_factorization", False)),
                       "rsLora": bool(getattr(adapter, "rs_lora", False)),
                       "fullMatrix": bool(getattr(adapter, "full_matrix", False)),
                       "useScalar": "scalar" in dict(adapter.named_parameters())}
            key = json.dumps(details, sort_keys=True)
            if key not in groups:
                groups[key] = {**details, "count": 0, "paths": []}
            groups[key]["count"] += 1
            groups[key]["paths"].append(name)
            total_params += params
        rows = list(groups.values())
        for index, row in enumerate(rows):
            row["id"] = str(index)
        # All tensors have the save dtype; safetensors orders their payload by name.
        cursor = 0
        for key in sorted(header):
            tensor_header = header[key]
            start, end = tensor_header["data_offsets"]
            tensor_header["data_offsets"] = [cursor, cursor + end - start]
            cursor += end - start
        header_bytes = len(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        return {"groups": rows, "moduleCount": len(adapters), "params": total_params,
                "weightBytes": offset, "estimatedBytes": offset + 8 + ((header_bytes + 7) // 8) * 8,
                "precision": precision, "fullW2Count": full_count,
                "module": module_name, "metadataEstimated": True}
