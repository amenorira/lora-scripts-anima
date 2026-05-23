"""
Shared application state — schema/preset caches and loaders.
"""
import hashlib
import os

import toml


# ── Global caches ──────────────────────────────────────────
avaliable_schemas: list[dict] = []
avaliable_presets: list[dict] = []


async def load_schemas():
    avaliable_schemas.clear()

    schema_dir = os.path.join(os.getcwd(), "backend", "schema")
    if not os.path.isdir(schema_dir):
        return

    for schema_name in os.listdir(schema_dir):
        with open(os.path.join(schema_dir, schema_name), encoding="utf-8") as f:
            content = f.read()
            avaliable_schemas.append({
                "name": schema_name.rstrip(".ts"),
                "schema": content,
                "hash": hashlib.md5(content.encode()).hexdigest(),
            })


async def load_presets():
    avaliable_presets.clear()

    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    if not os.path.isdir(preset_dir):
        return

    for preset_name in os.listdir(preset_dir):
        with open(os.path.join(preset_dir, preset_name), encoding="utf-8") as f:
            content = f.read()
            avaliable_presets.append(toml.loads(content))
