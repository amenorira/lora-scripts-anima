"""CL Tagger（cella110n/cl_tagger） interrogator。

模型约定（依据模型仓库自带的 tag_mapping.json 与公开推理脚本）：
- 输入 448×448、白底补齐方形、BICUBIC 缩放、/255 后按 0.5 均值/方差归一化的
  BGR float32 张量
- tag_mapping.json 是数据而非代码，支持两种布局：
  {"idx_to_tag": {...}, "tag_to_category": {...}}
  或 {索引: {"tag": ..., "category": ...}}
- rating / quality 分类只取置信度最高的一条，其余分类全量输出（阈值交给后处理）
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from PIL import Image

from backend.log import log
from backend.tagger import image_prep
from backend.tagger.interrogators.base import Interrogator, create_onnx_session
from backend.tagger.tagger_download import tagger_hub_download

_INPUT_SIZE = 448
# 均值/方差同为 0.5，即映射到 [-1, 1]
_NORM = 0.5

CATEGORY_NAMES = ("rating", "general", "character", "copyright",
                  "artist", "meta", "quality", "model")
# mapping JSON 里的类别写法（首字母大写）→ 内部键名
_CATEGORY_FROM_MAPPING = {name.capitalize(): name for name in CATEGORY_NAMES}
# 只保留 argmax 单标签的分类
_SINGLETON_CATEGORIES = frozenset({"rating", "quality"})


@dataclass
class LabelData:
    """标签名表 + 各分类的输出神经元索引。"""
    names: list                       # 神经元索引 → 标签名（空洞为 None）
    category_indices: dict            # 分类 → int64 索引数组


def _parse_tag_mapping(mapping: dict) -> LabelData:
    import numpy as np

    if "idx_to_tag" in mapping:
        idx_to_tag = {int(k): v for k, v in mapping["idx_to_tag"].items()}
        tag_to_category = mapping["tag_to_category"]
    else:
        try:
            entries = {int(k): v for k, v in mapping.items()}
            idx_to_tag = {idx: data["tag"] for idx, data in entries.items()}
            tag_to_category = {data["tag"]: data["category"] for data in entries.values()}
        except (KeyError, ValueError, AttributeError) as e:
            raise ValueError(
                f"Unsupported tag mapping format: {e}. "
                "Expect {'idx_to_tag', 'tag_to_category'} or per-index {'tag', 'category'} entries."
            )

    names = [None] * (max(idx_to_tag) + 1)
    buckets = {name: [] for name in CATEGORY_NAMES}
    for idx, tag in idx_to_tag.items():
        names[idx] = tag
        category = _CATEGORY_FROM_MAPPING.get(tag_to_category.get(tag, ""))
        if category is not None:
            buckets[category].append(idx)
    return LabelData(
        names=names,
        category_indices={k: np.array(v, dtype=np.int64) for k, v in buckets.items()},
    )


def _collect_tags(probs, labels: LabelData) -> Dict[str, List[Tuple[str, float]]]:
    """把输出概率整理成 {分类: [(标签, 置信度), ...]}，各分类内按置信度降序。"""
    import numpy as np

    result: Dict[str, List[Tuple[str, float]]] = {name: [] for name in CATEGORY_NAMES}
    for category in CATEGORY_NAMES:
        indices = labels.category_indices[category]
        valid = indices[indices < len(probs)]
        if len(valid) == 0:
            continue
        scores = probs[valid]
        if category in _SINGLETON_CATEGORIES:
            best = int(np.argmax(scores))
            name = labels.names[valid[best]]
            if name is not None:
                result[category].append((name, float(scores[best])))
        else:
            for idx, score in zip(valid, scores):
                name = labels.names[idx]
                if name is not None:
                    result[category].append((name, float(score)))
    for entries in result.values():
        entries.sort(key=lambda item: item[1], reverse=True)
    return result


def _to_input_tensor(image: Image.Image):
    import numpy as np

    prepared = image_prep.pad_to_square(image_prep.flatten_to_white(image))
    prepared = prepared.resize((_INPUT_SIZE, _INPUT_SIZE), Image.BICUBIC)
    tensor = np.asarray(prepared, dtype=np.float32) / 255.0
    tensor = tensor.transpose(2, 0, 1)[::-1]  # HWC → CHW，同时 RGB → BGR
    tensor = (tensor - _NORM) / _NORM
    return tensor[np.newaxis, ...]


class CLTaggerInterrogator(Interrogator):
    def __init__(
            self,
            name: str,
            model_path: str = 'model.onnx',
            tag_mapping_path: str = 'tag_mapping.json',
            **kwargs
    ) -> None:
        super().__init__(name)
        self.model_path = model_path
        self.tag_mapping_path = tag_mapping_path
        self.kwargs = kwargs

    def download(self) -> Tuple[Path, Path]:
        repo_id = self.kwargs['repo_id']
        cache_dir = self.kwargs.get('cache_dir')
        log.info(f"Loading {self.name} model file from {repo_id} / 正在加载模型")
        model_file = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.model_path, cache_dir=cache_dir))
        mapping_file = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.tag_mapping_path, cache_dir=cache_dir))
        return model_file, mapping_file

    def load(self) -> None:
        model_file, mapping_file = self.download()
        self.model = create_onnx_session(model_file)
        with open(mapping_file, "r", encoding="utf-8") as stream:
            self.labels = _parse_tag_mapping(json.load(stream))

        device = "CUDA" if "CUDAExecutionProvider" in self.model.get_providers() else "CPU"
        log.info(f'Loaded {self.name} model from {model_file} (device: {device}) / 模型加载完成')
        if device == "CPU":
            log.info('  ⚠ GPU inference not enabled, fell back to CPU. Check onnxruntime-gpu and CUDA versions to enable acceleration. / 未启用 GPU 推理，已回退 CPU。如需加速，请检查 onnxruntime-gpu 版本与 CUDA 是否匹配。')

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        import numpy as np

        if getattr(self, "model", None) is None:
            self.load()

        input_name = self.model.get_inputs()[0].name
        output_name = self.model.get_outputs()[0].name
        logits = self.model.run([output_name], {input_name: _to_input_tensor(image)})[0][0]

        if not np.isfinite(logits).all():
            log.warning("NaN or Inf detected in model output. Clamping... / 模型输出出现 NaN 或 Inf，已钳制……")
            logits = np.nan_to_num(logits, nan=0.0, posinf=1.0, neginf=0.0)

        # 输出是 logits，套一层裁剪过的 sigmoid 防 exp 溢出
        probs = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
        return _collect_tags(probs, self.labels)
