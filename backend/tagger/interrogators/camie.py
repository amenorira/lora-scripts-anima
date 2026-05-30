"""
Camie Tagger v2 interrogator — ViT-based anime image tagging model.

Model: Camais03/camie-tagger-v2
Architecture: ViT backbone + cross-attention refinement pipeline
Categories: general, character, copyright, artist, meta, year, rating
Tags: ~70,527
Input: 512×512 RGB, ImageNet normalization
Output: dual (initial + refined logits), we use refined
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from PIL import Image
from huggingface_hub import hf_hub_download

from backend.tagger.interrogators.base import Interrogator


class CamieTaggerInterrogator(Interrogator):
    """Interrogator for Camais03/camie-tagger-v2 ONNX model."""

    def __init__(
            self,
            name: str,
            model_filename: str = "camie-tagger-v2.onnx",
            metadata_filename: str = "camie-tagger-v2-metadata.json",
            **kwargs
    ) -> None:
        super().__init__(name)
        self.model_filename = model_filename
        self.metadata_filename = metadata_filename
        self.kwargs = kwargs

    def download(self) -> Tuple[Path, Path]:
        repo_id = self.kwargs.get("repo_id", "Camais03/camie-tagger-v2")
        print(f"Loading {self.name} model from {repo_id}")

        model_path = Path(hf_hub_download(
            repo_id=repo_id,
            filename=self.model_filename,
        ))
        metadata_path = Path(hf_hub_download(
            repo_id=repo_id,
            filename=self.metadata_filename,
        ))
        return model_path, metadata_path

    def load(self) -> None:
        model_path, metadata_path = self.download()

        import torch  # noqa: ensure CUDA libs loaded
        from onnxruntime import InferenceSession

        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        opts = None
        try:
            from onnxruntime import SessionOptions
            opts = SessionOptions()
            opts.log_severity_level = 3  # suppress verbose logs
        except Exception:
            pass

        self.model = InferenceSession(
            str(model_path),
            providers=providers,
            sess_options=opts,
        )

        device = (
            "CUDA" if "CUDAExecutionProvider" in self.model.get_providers()
            else "CPU"
        )
        print(f"Loaded {self.name} model from {model_path} (device: {device})")

        # ── Parse metadata JSON ──────────────────────────────
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)

        # Camie v2 metadata 嵌套结构: dataset_info.tag_mapping.idx_to_tag / tag_to_category
        dataset_info = metadata.get("dataset_info", metadata)
        tag_mapping = dataset_info.get("tag_mapping", dataset_info)

        self.idx_to_tag = tag_mapping.get("idx_to_tag", {})
        self.tag_to_category = tag_mapping.get("tag_to_category", {})

        # 读取图像尺寸
        model_info = metadata.get("model_info", {})
        self.img_size = model_info.get("img_size", 512)

        total_tags = dataset_info.get("total_tags", len(self.idx_to_tag))
        print(f"  Tags: {total_tags}, "
              f"Categories: {len(set(self.tag_to_category.values()))}, "
              f"Image size: {self.img_size}")

    def preprocess_image(self, image: Image.Image) -> np.ndarray:
        """
        Camie v2 预处理：
        - 转 RGB
        - 等比缩放保持宽高比，短边填到 img_size
        - 填充色使用 ImageNet 均值 (124, 116, 104)
        - ImageNet 归一化: mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]
        - 输出 CHW 格式，加 batch 维度
        """
        image = image.convert("RGB")
        w, h = image.size
        size = self.img_size
        ratio = w / h

        if ratio > 1:
            new_w = size
            new_h = int(size / ratio)
        else:
            new_h = size
            new_w = int(size * ratio)

        image = image.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # 用 ImageNet 均值做填充色
        pad_color = (124, 116, 104)
        new_image = Image.new("RGB", (size, size), pad_color)
        paste_x = (size - new_w) // 2
        paste_y = (size - new_h) // 2
        new_image.paste(image, (paste_x, paste_y))

        # 转 numpy 并归一化
        data = np.array(new_image).astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        data = (data - mean) / std

        # HWC → CHW，加 batch 维度
        return data.transpose(2, 0, 1)[np.newaxis, :]

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        """推理并返回分类标签。"""

        if not hasattr(self, "model") or self.model is None:
            self.load()

        input_tensor = self.preprocess_image(image).astype(np.float32)
        input_name = self.model.get_inputs()[0].name

        outputs = self.model.run(None, {input_name: input_tensor})

        # 双输出模型: outputs[0]=initial, outputs[1]=refined, outputs[2]=candidates
        if len(outputs) >= 2:
            logits = outputs[1]  # 使用 refined predictions
        else:
            logits = outputs[0]

        # sigmoid
        def stable_sigmoid(x):
            return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))

        probs = stable_sigmoid(logits[0])  # shape: (num_tags,)

        # ── 按分类组织标签 ──────────────────────────────────
        result = {
            "rating": [],
            "general": [],
            "character": [],
            "copyright": [],
            "artist": [],
            "meta": [],
            "year": [],
        }

        for idx, prob in enumerate(probs):
            idx_str = str(idx)
            tag_name = self.idx_to_tag.get(idx_str)
            if tag_name is None:
                tag_name = self.idx_to_tag.get(idx)  # 尝试 int key
            if tag_name is None:
                continue

            category = self.tag_to_category.get(tag_name, "general")

            if category in result:
                result[category].append((tag_name, float(prob)))
            else:
                # fallback
                result["general"].append((tag_name, float(prob)))

        # 每个分类内按置信度降序排列
        for cat in result:
            result[cat] = sorted(result[cat], key=lambda x: x[1], reverse=True)

        return result
