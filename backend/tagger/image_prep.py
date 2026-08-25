"""打标图片预处理：纯 PIL 实现，替代旧版 cv2 工具函数。

约定：
- 透明区域一律合成到白底（打标模型按白底训练）
- 方形补齐用白边居中，缩放按方向选滤波器（放大 BICUBIC / 缩小 BOX 面积平均）
  ——面积平均对齐打标模型参考实现里的 INTER_AREA，缩采样抗锯齿且不振铃
"""
from __future__ import annotations

from PIL import Image


def flatten_to_white(image: Image.Image) -> Image.Image:
    """任意模式 → 白底 RGB。RGBA/LA 的 alpha 通道作掩码贴到白底上。"""
    if image.mode == "RGB":
        return image
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[3])
        return canvas
    return image.convert("RGB")


def pad_to_square(image: Image.Image, fill=(255, 255, 255), min_side: int = 0) -> Image.Image:
    """白边居中补齐为正方形；补齐边长不小于 min_side。已是正方形且达标时原样返回（不复制）。"""
    width, height = image.size
    side = max(width, height, min_side)
    if width == height == side:
        return image
    canvas = Image.new(image.mode, (side, side), fill)
    canvas.paste(image, ((side - width) // 2, (side - height) // 2))
    return canvas


def resize_to(image: Image.Image, size: int) -> Image.Image:
    """等比缩放到 size×size（调用方保证已补齐方形）；尺寸已达标时原样返回。"""
    if image.size == (size, size):
        return image
    # 缩小用 BOX（面积平均，同 INTER_AREA 一族）；放大用 BICUBIC 防过锐
    resample = Image.BOX if image.size[0] > size else Image.BICUBIC
    return image.resize((size, size), resample)


def prepare_square(image: Image.Image, size: int) -> Image.Image:
    """打标模型标准前处理：白底化 → 补方形（不小于目标边长）→ 缩放。"""
    return resize_to(pad_to_square(flatten_to_white(image), min_side=size), size)
