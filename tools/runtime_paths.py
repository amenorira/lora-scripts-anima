"""Explicit project scratch directories and opt-in test cache isolation."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def runtime_cache_dir(*parts: str) -> Path:
    directory = ROOT / "cache" / "runtime"
    directory = directory.joinpath(*parts)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def configure_test_paths(*, root: Path | None = None) -> None:
    """Isolate test/diagnostic files; never called by application startup."""
    project = root if root is not None else ROOT
    cache = project / "cache" / "tests"
    temporary = (cache / "tmp").resolve()
    temporary.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(temporary)
    for key in ("TMPDIR", "TEMP", "TMP"):
        os.environ[key] = str(temporary)
    for key, relative in (
        ("TORCHINDUCTOR_CACHE_DIR", "torchinductor"),
        ("TORCH_EXTENSIONS_DIR", "torch_extensions"),
        ("TRITON_CACHE_DIR", "triton"),
        ("LYCORIS_KERNEL_CACHE_DIR", "lycoris_kernels"),
        ("CUDA_CACHE_PATH", "cuda"),
        ("XDG_CACHE_HOME", "xdg"),
    ):
        os.environ.setdefault(key, str((cache / relative).resolve()))
