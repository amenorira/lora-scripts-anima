"""
Shared application state — preset caches and loaders.
"""
import os

import toml

from backend.constants import PRESETS_DIR
from backend.log import log


# ── Global caches ──────────────────────────────────────────
avaliable_presets: list[dict] = []


async def load_presets():
    avaliable_presets.clear()

    if not PRESETS_DIR.is_dir():
        return

    for preset_name in os.listdir(PRESETS_DIR):
        preset_path = PRESETS_DIR / preset_name
        if not preset_path.suffix == ".toml":
            continue
        try:
            with open(preset_path, encoding="utf-8") as f:
                content = f.read()
                avaliable_presets.append(toml.loads(content))
        except (toml.TomlDecodeError, Exception) as e:
            log.warning(f"Failed to load preset / 预设加载失败: {preset_name} — {e}")
