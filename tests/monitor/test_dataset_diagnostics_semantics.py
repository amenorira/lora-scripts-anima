"""Regression coverage for diagnostic comparisons and caption provenance."""
import json
import math
from pathlib import Path
from unittest.mock import patch

from backend.monitor import dataset_diagnostics as diagnostics
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


def _row(image, timestep, loss, *, epoch=1, dataset=0, subset=0, width=512, height=512):
    return {
        "image": str(image), "image_id": diagnostics._image_id_for_key(str(image)),
        "dataset": dataset, "subset": subset, "timestep": timestep, "loss": loss,
        "step": epoch, "epoch": epoch, "width": width, "height": height,
        "batch_size": 1, "loss_weight": 1.0,
    }


class DatasetDiagnosticsSemanticsTests(CrossDriveSandbox):
    def _record(self, **config):
        run = self.output / "diagnostic-semantics"
        run.mkdir(exist_ok=True)
        lines = [f"{key} = {json.dumps(str(value))}" for key, value in config.items()]
        (run / "config.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
        return {"run_path": str(run), "run_dir": "output/diagnostic-semantics"}

    def test_timestep_scale_follows_profile(self):
        self.assertEqual(diagnostics._timestep_scale("sdxl-lora"), "thousand")
        self.assertEqual(diagnostics._timestep_scale("moss-image-lora"), "thousand")
        self.assertEqual(diagnostics._timestep_scale("anima-lora"), "unit")
        self.assertEqual(diagnostics._timestep_scale("unknown"), "unknown")

    def test_classification_applies_inclusive_thresholds_after_sample_and_reference_gates(self):
        eligible = dict(count=3, comparable_count=3, non_finite_count=0, mean_residual=0.20, slope=-0.02, min_count=3)
        cases = [
            ({}, "learning"),
            ({"slope": math.nextafter(-0.02, 0.0)}, "attention"),
            ({"slope": None}, "attention"),
            ({"mean_residual": math.nextafter(0.20, 0.0)}, "normal"),
            ({"mean_residual": -0.20}, "easy"),
            ({"mean_residual": math.nextafter(-0.20, 0.0)}, "normal"),
            ({"count": 2, "comparable_count": 2}, "insufficient"),
            ({"comparable_count": 2}, "insufficient_reference"),
            ({"count": 2, "comparable_count": 2, "non_finite_count": 1}, "non_finite"),
        ]
        for overrides, expected in cases:
            with self.subTest(overrides=overrides):
                self.assertEqual(diagnostics._classify_image(**(eligible | overrides)), expected)
        record = self._record()
        record["extra"] = {"trainer_file": "anima_train_network.py"}
        self.assertEqual(diagnostics._detect_profile(record), "anima-lora")

    def test_repeated_samples_of_one_image_are_not_a_peer_reference(self):
        rows = [_row("a.png", 0.5, 1.0, epoch=i) for i in range(1, 4)]
        record = self._record(model_train_type="anima-lora")
        record["extra"] = {"profile_id": "anima-lora"}
        control = Path(record["run_path"]) / "log" / ".run-control"
        control.mkdir(parents=True)
        (control / "loss.jsonl").write_text(
            "\n".join([json.dumps({"run_id": "run1"}), *(json.dumps(row) for row in rows)]) + "\n",
            encoding="utf-8",
        )
        try:
            result = diagnostics.analyze_dataset_diagnostics(record, min_count=3)
            image = result["by_image"][0]
            self.assertEqual((image["count"], image["comparable_count"], image["epochs"]), (3, 0, 3))
            self.assertEqual(image["status"], "insufficient_reference")
            self.assertIsNone(image["mean_residual"])
            self.assertIsNone(image["slope"])
            self.assertEqual(result["by_timestep"][0]["count"], 3)
            self.assertEqual(result["by_timestep"][0]["comparable_count"], 0)
        finally:
            diagnostics.clear_dataset_diagnostics_cache()

    def test_regularization_uses_full_path_not_folder_basename(self):
        train = self.root / "train" / "1_person" / "a.png"
        regularization = self.root / "reg" / "1_person" / "b.png"
        record = self._record(train_data_dir=train.parents[1], reg_data_dir=regularization.parents[1])
        lookup, roots = diagnostics._build_subset_lookup({"metadata": {"ss_reg_dataset_dirs": {"1_person": {}}}}, record)
        self.assertFalse(diagnostics._row_is_reg(_row(train, 1, 1), lookup, roots))
        self.assertTrue(diagnostics._row_is_reg(_row(regularization, 1, 1), lookup, roots))
        self.assertEqual(diagnostics._resolve_subset_label(_row(train, 1, 1), lookup), "1_person")
        self.assertIsNone(diagnostics._row_is_reg(_row(train, 1, 1), {}, set()))

    def test_caption_uses_configured_extension_and_rejects_conflicting_editor_target(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        image.with_suffix(".txt").write_text("old text", encoding="utf-8")
        image.with_suffix(".caption").write_text("training text", encoding="utf-8")
        record = self._record(caption_extension=".caption")
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertEqual((result["text"], result["path"]), ("training text", str(image.with_suffix(".caption"))))
        self.assertFalse(result["editor_safe"])
        image.with_suffix(".txt").unlink()
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertTrue(result["editor_safe"])

    def test_subset_extension_overrides_dataset_and_global_extension(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        image.with_suffix(".words").write_text("subset text", encoding="utf-8")
        record = self._record(caption_extension=".txt")
        (Path(record["run_path"]) / "dataset.toml").write_text(
            '[general]\ncaption_extension = ".txt"\n[[datasets]]\ncaption_extension = ".caption"\n'
            f'[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".words"\n',
            encoding="utf-8",
        )
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertEqual((result["source"], result["text"]), ("sidecar", "subset text"))
        self.assertEqual(result["path"], str(image.with_suffix(".words")))
        self.assertFalse(result["editor_safe"])

    def test_face_crop_fallback_and_metadata_are_not_editable_as_sidecars(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person_1_2_3_4.png"
        image.touch()
        shared = folder / "person.caption"
        shared.write_text("shared", encoding="utf-8")
        record = self._record(caption_extension=".caption")
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertEqual((result["path"], result["text"]), (str(shared), "shared"))
        self.assertFalse(result["editor_safe"])

        metadata = self.root / "dataset.json"
        metadata.write_text(json.dumps({str(image): {"caption": "portrait", "tags": "solo"}}), encoding="utf-8")
        record = self._record(in_json=metadata)
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertEqual((result["source"], result["text"]), ("metadata", "portrait,solo"))
        self.assertEqual(result["path"], str(metadata))
        self.assertFalse(result["editor_safe"])

    def test_missing_sidecar_uses_dreambooth_folder_class_tokens(self):
        folder = self.root / "train" / "1_blue_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        record = self._record(train_data_dir=folder.parent, caption_extension=".txt")
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)])
        self.assertEqual((result["source"], result["text"]), ("class_tokens", "blue_person"))
        self.assertFalse(result["editor_safe"])

    def test_metadata_for_nonlocal_key_can_be_located_by_runtime_subset(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        metadata = self.root / "dataset.json"
        metadata.write_text(json.dumps({"opaque-key": {"caption": "metadata caption"}}), encoding="utf-8")
        record = self._record()
        (Path(record["run_path"]) / "dataset.toml").write_text(
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\n'
            f'metadata_file = {json.dumps(metadata.as_posix())}\n', encoding="utf-8"
        )
        manifest = {"metadata": {"ss_datasets": [{"subsets": [{"metadata_file": metadata.name}]}]}}
        lookup, _ = diagnostics._build_subset_lookup(manifest, record)
        result = diagnostics._read_caption_preview(None, record=record, rows=[_row("opaque-key", 1, 1)], subset_lookup=lookup)
        self.assertEqual((result["source"], result["text"], result["path"]), ("metadata", "metadata caption", str(metadata)))
        self.assertFalse(result["editor_safe"])
        without_manifest = diagnostics._read_caption_preview(None, record=record, rows=[_row("opaque-key", 1, 1)])
        self.assertEqual((without_manifest["source"], without_manifest["text"]), ("metadata", "metadata caption"))

    def test_different_subset_caption_sources_are_ambiguous(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        record = self._record(caption_extension=".txt")
        (Path(record["run_path"]) / "dataset.toml").write_text(
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".txt"\n'
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".caption"\n',
            encoding="utf-8",
        )
        result = diagnostics._read_caption_preview(
            image, record=record, rows=[_row(image, 1, 1, dataset=0), _row(image, 1, 1, dataset=1)]
        )
        self.assertEqual(result["source"], "ambiguous")
        self.assertFalse(result["editor_safe"])

    def test_subset_index_selects_correct_extension_when_directory_is_reused(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        image.with_suffix(".txt").write_text("first", encoding="utf-8")
        image.with_suffix(".caption").write_text("second", encoding="utf-8")
        record = self._record(caption_extension=".txt")
        (Path(record["run_path"]) / "dataset.toml").write_text(
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = "txt"\n'
            f'[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".caption"\n',
            encoding="utf-8",
        )
        first = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1, subset=0)])
        second = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1, subset=1)])
        both = diagnostics._read_caption_preview(
            image, record=record, rows=[_row(image, 1, 1, subset=0), _row(image, 1, 1, subset=1)]
        )
        self.assertEqual((first["text"], second["text"]), ("first", "second"))
        self.assertEqual(both["source"], "ambiguous")

    def test_manifest_alignment_accounts_for_skipped_subsets(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        image.with_suffix(".txt").write_text("actual", encoding="utf-8")
        image.with_suffix(".caption").write_text("duplicate", encoding="utf-8")
        record = self._record(caption_extension=".caption")
        (Path(record["run_path"]) / "dataset.toml").write_text(
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps((self.root / "empty").as_posix())}\n'
            f'[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".txt"\n'
            f'[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\ncaption_extension = ".caption"\n',
            encoding="utf-8",
        )
        manifest = {"metadata": {"ss_datasets": [{"subsets": [{"image_dir": "1_person", "is_reg": False}]}]}}
        lookup, _ = diagnostics._build_subset_lookup(manifest, record)
        result = diagnostics._read_caption_preview(image, record=record, rows=[_row(image, 1, 1)], subset_lookup=lookup)
        self.assertEqual((result["text"], result["path"]), ("actual", str(image.with_suffix(".txt"))))

    def test_existing_shared_sidecar_is_not_ambiguous_when_fallback_tokens_differ(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "person.png"
        image.touch()
        image.with_suffix(".txt").write_text("shared", encoding="utf-8")
        record = self._record(caption_extension=".txt")
        (Path(record["run_path"]) / "dataset.toml").write_text(
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\nclass_tokens = "one"\n'
            f'[[datasets]]\n[[datasets.subsets]]\nimage_dir = {json.dumps(folder.as_posix())}\nclass_tokens = "two"\n',
            encoding="utf-8",
        )
        result = diagnostics._read_caption_preview(
            image, record=record, rows=[_row(image, 1, 1, dataset=0), _row(image, 1, 1, dataset=1)]
        )
        self.assertEqual((result["source"], result["text"]), ("sidecar", "shared"))
        self.assertTrue(result["editor_safe"])

    def test_metadata_preview_cache_is_revision_aware_and_size_bounded(self):
        metadata = self.root / "dataset.jsonl"
        metadata.write_text(json.dumps({"image_path": "item", "caption": "first"}) + "\n", encoding="utf-8")
        diagnostics._read_metadata_revision.cache_clear()
        first = diagnostics._metadata_caption_preview(str(metadata), "item", {})
        again = diagnostics._metadata_caption_preview(str(metadata), "item", {})
        self.assertEqual((first["text"], again["text"]), ("first", "first"))
        self.assertEqual(diagnostics._read_metadata_revision.cache_info().hits, 1)
        metadata.write_text(json.dumps({"image_path": "item", "caption": "changed value"}) + "\n", encoding="utf-8")
        changed = diagnostics._metadata_caption_preview(str(metadata), "item", {})
        self.assertEqual(changed["text"], "changed value")
        with patch.object(diagnostics, "_MAX_METADATA_PREVIEW_BYTES", 1):
            large = diagnostics._metadata_caption_preview(str(metadata), "item", {})
        self.assertEqual((large["source"], large["path"], large["text_available"]), ("metadata", str(metadata), False))
        self.assertFalse(large["editor_safe"])

    def test_summary_and_detail_preserve_uncomparable_samples(self):
        folder = self.root / "train" / "1_person"
        folder.mkdir(parents=True)
        image = folder / "a.png"
        peer = folder / "b.png"
        other = folder / "c.png"
        missing = folder / "d.png"
        for path in (image, peer, other, missing):
            path.touch()
        image.with_suffix(".caption").write_text("actual", encoding="utf-8")
        image.with_suffix(".txt").write_text("old", encoding="utf-8")
        record = self._record(caption_extension=".caption", model_train_type="sdxl-lora")
        record["extra"] = {"profile_id": "sdxl-lora"}
        control = Path(record["run_path"]) / "log" / ".run-control"
        control.mkdir(parents=True)
        rows = [_row(image, 1.0, 1.0, epoch=1, width=512, subset=0),
                _row(image, 1.0, 1.0, epoch=2, width=768, subset=1),
                _row(image, 1.0, 1.0, epoch=3, width=768, subset=1),
                _row(peer, 1.0, 3.0), _row(other, 500.0, 2.0), _row(missing, None, 999.0)]
        with (control / "loss.jsonl").open("w", encoding="utf-8") as stream:
            stream.write(json.dumps({"run_id": "run1"}) + "\n")
            for row in rows:
                stream.write(json.dumps(row) + "\n")
        try:
            result = diagnostics.analyze_dataset_diagnostics(record, min_count=1)
            images = {entry["name"]: entry for entry in result["by_image"]}
            self.assertEqual(result["timestep_scale"], "thousand")
            self.assertEqual(result["summary"]["samples"], 6)
            self.assertEqual(result["summary"]["comparable_count"], 4)
            self.assertEqual(images["a.png"]["comparable_count"], 3)
            self.assertEqual(set(images["a.png"]["resolutions"]), {"512x512", "768x512"})
            self.assertEqual(set(images["a.png"]["subsets"]), {"0-0", "0-1"})
            self.assertEqual(images["c.png"]["status"], "insufficient_reference")
            self.assertEqual(images["d.png"]["status"], "insufficient_reference")
            self.assertIsNone(images["d.png"]["mean_residual"])
            self.assertEqual(sum(bucket["count"] for bucket in result["by_timestep"]), 5)
            detail = diagnostics.read_dataset_diagnostic_image(record, image_id=images["a.png"]["image_id"], min_count=1)
            self.assertEqual(detail["caption"]["text"], "actual")
            self.assertFalse(detail["caption"]["editor_safe"])
            self.assertEqual(detail["image"]["mean_residual"], images["a.png"]["mean_residual"])
            missing_detail = diagnostics.read_dataset_diagnostic_image(record, image_id=images["d.png"]["image_id"], min_count=1)
            self.assertIsNone(missing_detail["samples"][0]["residual"])
        finally:
            diagnostics.clear_dataset_diagnostics_cache()
