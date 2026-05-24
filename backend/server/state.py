"""
Shared application state — preset caches and loaders.
"""
import os

import toml


# ── Global caches ──────────────────────────────────────────
avaliable_presets: list[dict] = []


async def load_presets():
    avaliable_presets.clear()

    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    if not os.path.isdir(preset_dir):
        return

    for preset_name in os.listdir(preset_dir):
        with open(os.path.join(preset_dir, preset_name), encoding="utf-8") as f:
            content = f.read()
            avaliable_presets.append(toml.loads(content))
