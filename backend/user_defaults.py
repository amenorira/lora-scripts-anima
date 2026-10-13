"""Seed user-owned settings from versioned examples without overwriting edits."""

import os
from pathlib import Path


def ensure_user_defaults(root: Path | None = None) -> None:
    root = root or Path(__file__).resolve().parents[1]
    hf_home = Path(os.environ.get("HF_HOME", str(root / "huggingface")))
    defaults = root / "tools" / "defaults"
    for source, target in (
        (defaults / "sample_prompts.txt", root / "config" / "sample_prompts.txt"),
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
