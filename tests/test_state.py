"""
Tests for backend/app/state.py — schema/preset cache management.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure the project root is on sys.path
sys.path.insert(0, str(Path(__file__).parents[1]))


class TestLoadSchemas:
    """Schema cache loading from backend/schema/ directory."""

    def test_load_schemas_empty_dir(self, tmp_path, monkeypatch):
        """Loading from empty directory should result in empty list."""
        from backend.app.state import avaliable_schemas, load_schemas

        monkeypatch.chdir(tmp_path)
        schema_dir = tmp_path / "backend" / "schema"
        schema_dir.mkdir(parents=True)

        avaliable_schemas.clear()
        import asyncio
        asyncio.run(load_schemas())

        assert avaliable_schemas == []

    def test_load_schemas_with_files(self, tmp_path, monkeypatch):
        """Loading from directory with .ts files should populate list."""
        from backend.app.state import avaliable_schemas, load_schemas

        monkeypatch.chdir(tmp_path)
        schema_dir = tmp_path / "backend" / "schema"
        schema_dir.mkdir(parents=True)

        # Create a mock schema file
        (schema_dir / "test.ts").write_text("export default {}", encoding="utf-8")
        (schema_dir / "lora-basic.ts").write_text("Schema.string()", encoding="utf-8")

        avaliable_schemas.clear()
        import asyncio
        asyncio.run(load_schemas())

        assert len(avaliable_schemas) == 2
        names = [s["name"] for s in avaliable_schemas]
        assert "test" in names
        assert "lora-basic" in names
        assert all("hash" in s for s in avaliable_schemas)

    def test_load_schemas_missing_dir(self, tmp_path, monkeypatch):
        """Loading from non-existent directory should not crash."""
        from backend.app.state import avaliable_schemas, load_schemas

        monkeypatch.chdir(tmp_path)
        # No backend/schema/ directory

        avaliable_schemas.clear()
        import asyncio
        asyncio.run(load_schemas())

        assert avaliable_schemas == []


class TestLoadPresets:
    """Preset cache loading from config/presets/ directory."""

    def test_load_presets_empty_dir(self, tmp_path, monkeypatch):
        """Loading from empty directory should result in empty list."""
        from backend.app.state import avaliable_presets, load_presets

        monkeypatch.chdir(tmp_path)
        preset_dir = tmp_path / "config" / "presets"
        preset_dir.mkdir(parents=True)

        avaliable_presets.clear()
        import asyncio
        asyncio.run(load_presets())

        assert avaliable_presets == []

    def test_load_presets_with_files(self, tmp_path, monkeypatch):
        """Loading from directory with .toml files should populate list."""
        from backend.app.state import avaliable_presets, load_presets

        monkeypatch.chdir(tmp_path)
        preset_dir = tmp_path / "config" / "presets"
        preset_dir.mkdir(parents=True)

        (preset_dir / "example.toml").write_text(
            '[metadata]\nname = "example"\nversion = "1.0"\n'
            'author = "test"\ntrain_type = "sd-lora"\ndescription = "test preset"\n'
            '\n[data]\nlearning_rate = "0.0001"\n',
            encoding="utf-8"
        )

        avaliable_presets.clear()
        import asyncio
        asyncio.run(load_presets())

        assert len(avaliable_presets) == 1
        assert avaliable_presets[0]["metadata"]["name"] == "example"

    def test_load_presets_missing_dir(self, tmp_path, monkeypatch):
        """Loading from non-existent directory should not crash."""
        from backend.app.state import avaliable_presets, load_presets

        monkeypatch.chdir(tmp_path)

        avaliable_presets.clear()
        import asyncio
        asyncio.run(load_presets())

        assert avaliable_presets == []
