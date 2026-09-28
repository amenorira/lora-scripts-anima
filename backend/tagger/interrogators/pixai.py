"""PixAI Tagger: pinned upstream architecture/processor, local full-score inference."""
from __future__ import annotations

from PIL import Image

from backend.log import log
from backend.tagger.interrogators.base import Interrogator
from backend.tagger.tagger_download import tagger_hub_download

REPO_ID = "pixai-labs/pixai-tagger-v1.0"
REVISION = "9fe10addf9326e292da8a85a98ea74cd91b41771"
FILES = ("config.json", "preprocessor_config.json", "tagger_pipeline.py", "model.safetensors")


class PixAITaggerInterrogator(Interrogator):
    def __init__(self, name: str, *, cache_dir: str | None = None):
        super().__init__(name)
        self.cache_dir = cache_dir

    @staticmethod
    def validate_precision(precision: str) -> None:
        if precision not in ("auto", "bf16", "fp32"):
            raise ValueError("Invalid PixAI precision / 无效的 PixAI 推理精度")

    def _configure_precision(self, precision: str) -> None:
        import torch

        self.validate_precision(precision)
        device = self.model.device
        supported = device.type == "cuda" and torch.cuda.is_bf16_supported()
        dtype = torch.bfloat16 if precision != "fp32" and supported else torch.float32
        state = (precision, str(device), dtype)
        if getattr(self, "_precision_state", None) != state:
            if precision == "bf16" and not supported:
                log.warning("BF16 unavailable; falling back to FP32 / 设备不支持 BF16，已回退 FP32")
            self.precision_label = "BF16 mixed precision" if dtype == torch.bfloat16 else "FP32"
            log.info(f"{self.name} on {device}: weights=FP32, inference={self.precision_label} "
                     f"(requested={precision}) / 权重与推理精度")
            self._precision_state = state
        self.autocast_dtype = dtype

    def load(self, precision: str = "auto") -> None:
        import torch
        from transformers import AutoImageProcessor, AutoModel

        paths = [tagger_hub_download(REPO_ID, filename, cache_dir=self.cache_dir,
                                     revision=REVISION) for filename in FILES]
        folder = paths[0].parent
        processor = AutoImageProcessor.from_pretrained(
            folder, trust_remote_code=True, local_files_only=True, backend="pil")
        model = AutoModel.from_pretrained(
            folder, trust_remote_code=True, local_files_only=True,
            dtype=torch.float32).eval()
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        # Keep complex RoPE buffers intact: casting the entire model to BF16
        # would discard their imaginary components. Autocast only the forward.
        model = model.to(device)
        self.processor = processor
        self.model = model
        self._configure_precision(precision)
        log.info(f"Loaded {self.name} on {device} / 模型加载完成")

    def interrogate(self, image: Image.Image, *, precision: str = "auto") -> dict[str, list[tuple[str, float]]]:
        import torch

        self.validate_precision(precision)
        if getattr(self, "model", None) is None:
            self.load(precision)
        else:
            self._configure_precision(precision)
        model = self.model
        inputs = self.processor(image, return_tensors="pt")["pixel_values"].to(model.device)
        with torch.inference_mode(), torch.autocast(
            device_type=model.device.type, dtype=self.autocast_dtype,
            enabled=self.autocast_dtype != torch.float32,
        ):
            logits = model(inputs)
        scores = logits.float().sigmoid()[0].cpu().tolist()
        tags = model.config.tags
        splits = model.config.tags_split
        if len(scores) != len(tags) or sum(count for _, count in splits) != len(tags):
            raise ValueError("PixAI tag vocabulary does not match model output / 标签与输出维度不匹配")
        result = {}
        offset = 0
        for category, count in splits:
            end = offset + count
            result[category] = sorted(zip(tags[offset:end], scores[offset:end]),
                                      key=lambda item: item[1], reverse=True)
            offset = end
        return result

    def unload(self) -> bool:
        import gc
        import torch

        model = getattr(self, "model", None)
        on_cuda = model is not None and model.device.type == "cuda"
        del model
        unloaded = super().unload()
        self.__dict__.pop("processor", None)
        self.__dict__.pop("_precision_state", None)
        if on_cuda:
            gc.collect()
            torch.cuda.empty_cache()
        return unloaded
