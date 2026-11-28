"""Seed user-owned settings from versioned examples without overwriting edits."""
from __future__ import annotations

import os
from pathlib import Path

from backend.constants import CONFIG_DIR, HF_CACHE_DIR, REPO_ROOT


def ensure_user_defaults(root: Path | None = None) -> None:
    if root is None:
        defaults = REPO_ROOT / "tools" / "defaults"
        config_dir = CONFIG_DIR
        hf_home = Path(os.environ.get("HF_HOME", str(HF_CACHE_DIR)))
    else:
        defaults = root / "tools" / "defaults"
        config_dir = root / "config"
        hf_home = Path(os.environ.get("HF_HOME", str(root / "huggingface")))

    for source, target in (
        (defaults / "sample_prompts.txt", config_dir / "sample_prompts.txt"),
        (defaults / "accelerate.yaml", hf_home / "accelerate" / "default_config.yaml"),
    ):
        if target.exists():
            continue
        contents = source.read_bytes()
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as destination:
                destination.write(contents)
        except FileExistsError:
            # Another launch created it after the existence check.
            pass
