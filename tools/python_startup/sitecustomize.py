"""Project-wide Python startup compatibility hooks."""
from __future__ import annotations

import importlib.metadata
import subprocess
import sys


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
