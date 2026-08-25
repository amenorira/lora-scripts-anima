"""SmilingWolf WD 系列打标器（wd-eva02-large-tagger-v3 / wd-vit-large-tagger-v3 等）。

模型约定（来自作者公开的参考实现与模型卡）：
- 输入为 BGR float32、0-255 不归一化、白色补齐方形后缩放到模型要求边长
- 输出前 4 个神经元是 rating（general/sensitive/questionable/explicit），
  其余按 selected_tags.csv 顺序对齐为一般标签
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

from PIL import Image

from backend.log import log
from backend.tagger import image_prep
from backend.tagger.interrogators.base import Interrogator, create_onnx_session
from backend.tagger.tagger_download import tagger_hub_download

# rating 神经元固定在输出头部
_RATING_COUNT = 4


class WaifuDiffusionInterrogator(Interrogator):
    def __init__(
            self,
            name: str,
            model_path: str = 'model.onnx',
            tags_path: str = 'selected_tags.csv',
            **kwargs
    ) -> None:
        super().__init__(name)
        self.model_path = model_path
        self.tags_path = tags_path
        self.kwargs = kwargs

    def download(self) -> Tuple[Path, Path]:
        repo_id = self.kwargs['repo_id']
        cache_dir = self.kwargs.get('cache_dir')
        log.info(f"Loading {self.name} model file from {repo_id}")
        model_file = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.model_path, cache_dir=cache_dir))
        tags_file = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.tags_path, cache_dir=cache_dir))
        return model_file, tags_file

    def load(self) -> None:
        import pandas as pd

        model_file, tags_file = self.download()
        self.model = create_onnx_session(model_file)
        self.tags = pd.read_csv(tags_file)

        device = "CUDA" if "CUDAExecutionProvider" in self.model.get_providers() else "CPU"
        log.info(f'Loaded {self.name} model from {model_file} (device: {device})')
        if device == "CPU":
            log.info('  ⚠ 未启用 GPU 推理，已回退 CPU。如需加速，请检查 onnxruntime-gpu 版本与 CUDA 是否匹配。')

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        import numpy as np

        if getattr(self, "model", None) is None:
            self.load()

        input_shape = self.model.get_inputs()[0].shape
        target_size = input_shape[1]

        # 白底化 + 补方形 + 缩放，然后 RGB → BGR 的 float32 批次张量
        prepared = image_prep.prepare_square(image, target_size)
        tensor = np.asarray(prepared, dtype=np.float32)[:, :, ::-1]
        tensor = np.expand_dims(tensor, 0)

        input_name = self.model.get_inputs()[0].name
        output_name = self.model.get_outputs()[0].name
        confidences = self.model.run([output_name], {input_name: tensor})[0]

        tag_frame = self.tags[:][['name']]
        tag_frame = tag_frame.assign(confidence=confidences[0])

        ratings = dict(tag_frame[:_RATING_COUNT].values)
        generals = dict(tag_frame[_RATING_COUNT:].values)

        result: Dict[str, List[Tuple[str, float]]] = {
            "rating": [],
            "general": [],
            "character": [],
            "copyright": [],
            "artist": [],
            "meta": [],
            "quality": [],
            "model": [],
        }
        for name, confidence in ratings.items():
            result["rating"].append((name, confidence))
        for name, confidence in generals.items():
            result["general"].append((name, confidence))
        return result
