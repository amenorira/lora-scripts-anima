"""Keep disposable runtime files in the project's managed cache tree."""
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


def configure_runtime_paths(*, testing: bool = False, root: Path | None = None) -> None:
    """Configure before ML imports; children inherit the same explicit paths.

    Python otherwise silently falls back to cwd if system temporary directories
    are unwritable. A managed directory must succeed rather than polluting cwd.
    User-selected compiler/cache directories remain authoritative.
    """
    project = root if root is not None else ROOT
    cache = project / "cache" / ("tests" if testing else "runtime")
    inherited = os.environ.get("ANIMA_TEMP_DIR") if not testing else None
    temporary = Path(inherited) if inherited else cache / "tmp"
    temporary = temporary.resolve()
    temporary.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(temporary)
    for key in ("ANIMA_TEMP_DIR", "TMPDIR", "TEMP", "TMP"):
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
