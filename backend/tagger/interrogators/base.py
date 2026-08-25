"""打标器基类与标签后处理流水线。

Interrogator 子类约定：load() 惰性加载模型，interrogate(image) 返回
{分类: [(标签, 置信度), ...]}；postprocess_tags 把原始结果按阈值/开关
收敛成 {最终标签文本: 置信度}。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image

from backend.log import log

tag_escape_pattern = re.compile(r'([\\()])')

# ── Camie Tagger v2 推荐分类阈值 ──────────────────────

# Macro-optimized: 每个标签权重相同，稀有标签友好，宁多勿少（推荐打标训练数据用）
CAMIE_MACRO_THRESHOLDS = {
    "general": 0.492,
    "character": 0.492,
    "copyright": 0.492,
    "artist": 0.492,
    "meta": 0.492,
    "year": 0.492,
    "rating": 0.492,
}

# Micro-optimized: 按标签出现频率加权，常见标签更精准，误报更少
CAMIE_MICRO_THRESHOLDS = {
    "general": 0.614,
    "character": 0.614,
    "copyright": 0.614,
    "artist": 0.614,
    "meta": 0.614,
    "year": 0.614,
    "rating": 0.614,
}

# 预设合集（供前端使用）
CAMIE_THRESHOLD_PRESETS = {
    "macro": CAMIE_MACRO_THRESHOLDS,
    "micro": CAMIE_MICRO_THRESHOLDS,
}

# 各分类显示名称
CATEGORY_LABELS = {
    "general": "特征 (General)",
    "character": "角色 (Character)",
    "copyright": "版权 (Copyright)",
    "artist": "画师 (Artist)",
    "meta": "元数据 (Meta)",
    "year": "年份 (Year)",
    "rating": "分级 (Rating)",
    "quality": "质量 (Quality)",
    "model": "模型 (Model)",
}


def create_onnx_session(model_path: str | Path):
    """创建 CUDA 优先的 ONNX 会话（打标模型共享的默认配置）。

    导入 onnxruntime 前先导入 torch 是有意为之：让 torch 自带的 CUDA 运行库
    先进入进程。两个依赖都不允许在模块 import 时就加载——打标模型按需加载。
    """
    import torch  # noqa: F401  # 确保 CUDA 运行库已加载
    from onnxruntime import InferenceSession

    try:
        from onnxruntime import SessionOptions

        options = SessionOptions()
        options.log_severity_level = 3
    except Exception:
        options = None

    return InferenceSession(
        str(model_path),
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        sess_options=options,
    )


class Interrogator:
    """单个打标模型：惰性加载、可卸载、可对单图推理。"""

    @staticmethod
    def postprocess_tags(
            tags: Dict[str, List[Tuple[str, float]]],

            threshold=0.35,
            character_threshold=0.6,
            category_thresholds: Optional[Dict[str, float]] = None,

            add_rating_tag=False,
            add_model_tag=False,

            additional_tags: Optional[List[str]] = None,
            exclude_tags: Optional[List[str]] = None,
            sort_by_alphabetical_order=False,
            add_confident_as_weight=False,
            replace_underscore=False,
            replace_underscore_excludes: Optional[List[str]] = None,
            escape_tag=False
    ) -> Dict[str, float]:
        """按阈值与开关把分类原始结果收敛为最终标签表。

        不改动传入的 tags；返回 {标签文本: 置信度}，默认按置信度降序。
        """
        overrides = category_thresholds or {}
        picked: Dict[str, float] = {}

        for category, entries in tags.items():
            if category == 'rating' and not add_rating_tag:
                continue
            if category == 'model' and not add_model_tag:
                continue
            floor = overrides.get(category)
            if floor is None:
                # 角色标签默认更严格（误标代价高），其余分类用全局阈值
                floor = character_threshold if category == 'character' else threshold
            for name, confidence in entries:
                if confidence >= floor:
                    picked[name] = confidence

        for name in additional_tags or []:
            picked[name] = 1.0
        for name in exclude_tags or []:
            picked.pop(name, None)

        if sort_by_alphabetical_order:
            ordered = dict(sorted(picked.items()))
        else:
            ordered = dict(sorted(picked.items(), key=lambda item: item[1], reverse=True))

        underscore_exempt = replace_underscore_excludes or []
        rendered: Dict[str, float] = {}
        for name, confidence in ordered.items():
            text = name
            if replace_underscore and name not in underscore_exempt:
                text = text.replace('_', ' ')
            if escape_tag:
                text = tag_escape_pattern.sub(r'\\\1', text)
            if add_confident_as_weight:
                text = f'({text}:{confidence})'
            rendered[text] = confidence
        return rendered

    def __init__(self, name: str) -> None:
        self.name = name

    def load(self):
        raise NotImplementedError()

    def unload(self) -> bool:
        unloaded = False
        for attr in ("model", "tags", "labels"):
            if getattr(self, attr, None) is not None:
                delattr(self, attr)
                unloaded = True
        if unloaded:
            log.info(f'Unloaded {self.name}')
        return unloaded

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        """
        对给定图片推理，返回 {分类: [(标签, 置信度), ...]}。

        分类约定: "rating", "general", "character", "copyright", "artist", "meta", "year", "quality", "model"
        """
        raise NotImplementedError()
