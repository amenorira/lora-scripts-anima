"""Project-wide Python startup compatibility hooks."""
from __future__ import annotations

import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys

# Launchers expose only this hooks directory through PYTHONPATH. During site
# initialization, Python has not yet added cwd (or the script directory) to
# sys.path, so project imports must be rooted in this file's location first.
_PROJECT_ROOT = str(Path(__file__).resolve().parents[2])
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from tools.runtime_paths import configure_runtime_paths

configure_runtime_paths()

# Load the optional CUDA extension only in explicitly selected training/probe
# processes. A stale wheel must not break otherwise independent SDPA runs.
if os.environ.get("ANIMA_ENABLE_FLASH_ATTN") != "1":
    sys.modules["flash_attn"] = None


_BNB_GAUDI_PROBE = "pip list | grep habana-torch-plugin"
_PATCH_FLAG = "_anima_bitsandbytes_windows_compat"


def _install_bitsandbytes_windows_compat() -> None:
    if sys.platform != "win32" or getattr(subprocess, _PATCH_FLAG, False):
        return

    original_run = subprocess.run

    def run_with_bitsandbytes_compat(*popenargs, **kwargs):
        command = popenargs[0] if popenargs else kwargs.get("args")
        if command == _BNB_GAUDI_PROBE and kwargs.get("shell"):
            try:
                plugin_version = importlib.metadata.version("habana-torch-plugin")
            except importlib.metadata.PackageNotFoundError:
                plugin_version = None

            text_mode = bool(
                kwargs.get("text")
                or kwargs.get("universal_newlines")
                or kwargs.get("encoding") is not None
            )
            stdout = f"habana-torch-plugin {plugin_version}\n" if plugin_version else ""
            stderr = ""
            if not text_mode:
                stdout = stdout.encode("utf-8")
                stderr = b""

            result = subprocess.CompletedProcess(command, 0 if plugin_version else 1, stdout, stderr)
            if kwargs.get("check"):
                result.check_returncode()
            return result

        return original_run(*popenargs, **kwargs)

    run_with_bitsandbytes_compat.__wrapped__ = original_run
    subprocess.run = run_with_bitsandbytes_compat
    setattr(subprocess, _PATCH_FLAG, True)


_install_bitsandbytes_windows_compat()


if os.environ.get("ANIMA_TRAIN_LOG_LOCK"):
    from tools.python_startup.training_logging import install as install_training_logging

    install_training_logging(os.environ["ANIMA_TRAIN_LOG_LOCK"])


if os.environ.get("ANIMA_TENSORBOARD_DIR"):
    from tools.python_startup.tensorboard_layout import install_import_hook as install_tb_layout

    install_tb_layout()


if os.environ.get("LORA_SCRIPTS_TRUE_LR_LOGGING") == "1":
    from tools.python_startup.lr_logging import install_import_hook

    install_import_hook()


if os.environ.get("ANIMA_TRAIN_METRICS") == "1":
    from tools.python_startup.training_metrics import install_import_hook as install_training_metrics

    install_training_metrics()
