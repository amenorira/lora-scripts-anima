# from https://github.com/toriato/stable-diffusion-webui-wd14-tagger
import os
from pathlib import Path
from typing import Dict, List, Tuple

from PIL import Image
from backend.tagger.interrogators.base import Interrogator, create_onnx_session
from backend.tagger import dbimutils
from backend.tagger.tagger_download import tagger_hub_download
from backend.log import log


class WaifuDiffusionInterrogator(Interrogator):
    def __init__(
            self,
            name: str,
            model_path='model.onnx',
            tags_path='selected_tags.csv',
            **kwargs
    ) -> None:
        super().__init__(name)
        self.model_path = model_path
        self.tags_path = tags_path
        self.kwargs = kwargs

    def download(self) -> Tuple[os.PathLike, os.PathLike]:
        log.info(f"Loading {self.name} model file from {self.kwargs['repo_id']}")
        repo_id = self.kwargs['repo_id']
        cache_dir = self.kwargs.get('cache_dir')

        model_path = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.model_path, cache_dir=cache_dir))
        tags_path = Path(tagger_hub_download(
            repo_id=repo_id, filename=self.tags_path, cache_dir=cache_dir))
        return model_path, tags_path

    def load(self) -> None:
        import pandas as pd
        model_path, tags_path = self.download()

        self.model = create_onnx_session(model_path)

        device = "CUDA" if "CUDAExecutionProvider" in self.model.get_providers() else "CPU"
        log.info(f'Loaded {self.name} model from {model_path} (device: {device})')
        if device == "CPU":
            log.info('  ⚠ 未启用 GPU 推理，已回退 CPU。如需加速，请检查 onnxruntime-gpu 版本与 CUDA 是否匹配。')

        self.tags = pd.read_csv(tags_path)

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        import numpy as np
        # init model
        if not hasattr(self, 'model') or self.model is None:
            self.load()

        # code for converting the image and running the model is taken from the link below
        # thanks, SmilingWolf!
        # https://huggingface.co/spaces/SmilingWolf/wd-v1-4-tags/blob/main/app.py

        # convert an image to fit the model
        _, height, _, _ = self.model.get_inputs()[0].shape

        # alpha to white
        image = image.convert('RGBA')
        new_image = Image.new('RGBA', image.size, 'WHITE')
        new_image.paste(image, mask=image)
        image = new_image.convert('RGB')
        image = np.asarray(image)

        # PIL RGB to OpenCV BGR
        image = image[:, :, ::-1]

        image = dbimutils.make_square(image, height)
        image = dbimutils.smart_resize(image, height)
        image = image.astype(np.float32)
        image = np.expand_dims(image, 0)

        # evaluate model
        input_name = self.model.get_inputs()[0].name
        label_name = self.model.get_outputs()[0].name
        confidents = self.model.run([label_name], {input_name: image})[0]

        tags = self.tags[:][['name']]
        tags['confidents'] = confidents[0]

        # first 4 items are for rating (general, sensitive, questionable, explicit)
        ratings = dict(tags[:4].values)

        # rest are regular tags
        tags = dict(tags[4:].values)

        result = {
            "rating": [],
            "general": [],
            "character": [],
            "copyright": [],
            "artist": [],
            "meta": [],
            "quality": [],
            "model": []
        }

        for tag, conf in ratings.items():
            result["rating"].append((tag, conf))

        for tag, conf in tags.items():
            result["general"].append((tag, conf))

        return result
