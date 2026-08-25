"""打标输出文件名模板引擎。

模板语法：`[name]`、`[extension]`、`[hash:algo]`、`[timestamp:fmt]`、
`[date:fmt]`、`[output_extension]`，未识别的占位符原样保留。
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

_TOKEN = re.compile(r"\[([^\[\]]+)\]")


@dataclass(frozen=True)
class FileContext:
    """模板求值所需的文件信息。output_ext 不带点（如 "txt"）。"""
    path: Path
    output_ext: str


def _file_digest(ctx: FileContext, algorithm: str = "sha1") -> str:
    try:
        digest = hashlib.new(algorithm)
    except ValueError:
        raise ValueError(f"'{algorithm}' is not a supported hash algorithm")
    with open(ctx.path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _timestamp(ctx: FileContext, fmt: str = "%Y%m%d_%H%M%S") -> str:
    return datetime.now().strftime(fmt)


def _date(ctx: FileContext, fmt: str = "%Y%m%d") -> str:
    return datetime.now().strftime(fmt)


_RENDERERS: dict[str, Callable[..., str]] = {
    "name": lambda ctx: ctx.path.stem,
    "extension": lambda ctx: ctx.path.suffix.lstrip("."),
    "hash": _file_digest,
    "timestamp": _timestamp,
    "date": _date,
    "output_extension": lambda ctx: ctx.output_ext,
}


def render(template: str, ctx: FileContext) -> str:
    """渲染模板。占位符内部的参数以冒号分隔（如 [hash:md5]）。

    渲染函数必须返回 str；抛出 TypeError/ValueError 视为模板错误，
    由调用方决定如何呈现。
    """
    def substitute(match: re.Match) -> str:
        parts = match[1].split(":")
        renderer = _RENDERERS.get(parts[0])
        if renderer is None:
            return match[0]
        return renderer(ctx, *parts[1:])

    return _TOKEN.sub(substitute, template)
