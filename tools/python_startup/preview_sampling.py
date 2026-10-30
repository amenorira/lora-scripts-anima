"""Install only the requested preview wrapper after its normal module import.

No trainer entry point is replaced. Torch is imported only when the target
sampling library is ready, never during interpreter or DataLoader startup.
"""
from __future__ import annotations

import builtins
import functools
import sys


_FLAG = "_anima_preview_sampling_hook"


def install_import_hook(config_path):
    if getattr(builtins, _FLAG, False):
        return
    original_import = builtins.__import__
    installing = False
    installed = False

    def patch_loaded():
        nonlocal installing, installed
        if installed or installing:
            return
        # Avoid reading config or importing training dependencies in unrelated processes.
        targets = ("library.anima_train_utils", "library.moss_image_train_utils")
        def ready(name):
            module = sys.modules.get(name)
            return module is not None and not getattr(getattr(module, "__spec__", None), "_initializing", False)

        if not any(ready(name) for name in targets):
            return
        installing = True
        try:
            from backend.training.preview.config import read_config
            from backend.training.preview.compat import MODULES, PreviewCompatibilityError

            document = read_config(config_path)
            module = sys.modules.get(MODULES[document["architecture"]])
            if module is None or not ready(MODULES[document["architecture"]]):
                return
            function = getattr(module, "sample_images", None)
            if not callable(function):
                raise PreviewCompatibilityError("sd-scripts sampling function is missing / 找不到预览采样函数")
            if not getattr(function, "_anima_preview_loras", False):
                from backend.training.preview.sampling import wrap_sampler

                module.sample_images = wrap_sampler(function, document)
            installed = True
        finally:
            installing = False

    @functools.wraps(original_import)
    def import_with_preview(*args, **kwargs):
        result = original_import(*args, **kwargs)
        patch_loaded()  # Errors must reach the trainer, never silently drop an adapter.
        return result

    builtins.__import__ = import_with_preview
    setattr(builtins, _FLAG, True)
    patch_loaded()
