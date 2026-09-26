"""Keep a broken user-installed FlashAttention optional for vendor imports."""
from __future__ import annotations

import importlib.abc
import importlib.machinery
import sys
import warnings


class _FlashLoader(importlib.abc.Loader):
    def __init__(self, loader):
        self.loader = loader

    def create_module(self, spec):
        return self.loader.create_module(spec)

    def exec_module(self, module):
        try:
            self.loader.exec_module(module)
        except Exception as exc:
            for name in list(sys.modules):
                if name.startswith("flash_attn."):
                    sys.modules.pop(name, None)
            warnings.warn(
                f"External flash-attn unavailable: {exc}. Use native SDPA or manually repair/remove "
                "flash-attn in the project venv. / 外部 flash-attn 无法加载，请使用原生 SDPA，"
                "或在项目 venv 中自行重装兼容版本或卸载该扩展。",
                RuntimeWarning,
            )
            # Vendor optional imports catch ImportError, but old DLLs may raise OSError.
            raise ImportError("Optional flash-attn could not be loaded") from exc


class _FlashFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != "flash_attn":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is not None and spec.loader is not None:
            spec.loader = _FlashLoader(spec.loader)
        return spec


def install() -> None:
    if not any(isinstance(finder, _FlashFinder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _FlashFinder())
