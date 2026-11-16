import asyncio
from collections import OrderedDict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngImageFile, PngInfo

from backend.monitor import artifacts, routes, sample_metadata
from backend.monitor.artifacts import newest_previews
from backend.monitor.sample_metadata import file_version, legacy_sample_metadata, read_sample_records, write_sample_batch


class SampleMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / "sample" / "demo_000200_00_20261114090000_42.png"
        self.image.parent.mkdir()
        Image.new("RGB", (64, 80)).save(self.image)
        self.relative = self.image.relative_to(self.root).as_posix()
        self.batch = {"id": "batch-200", "order": 200, "step": 200, "epoch": None, "expected": 1, "status": "complete"}
        self.params = {"architecture": "anima", "prompt": "portrait", "negative_prompt": "blur", "seed": 42,
                       "width": 64, "height": 80, "steps": 30, "cfg_scale": 5.0, "sampler": "euler",
                       "scheduler": "native", "flow_shift": 3.0, "loras": []}

    def write(self, *, batch=None, params=None, rank=0, processes=1, extra=None):
        item = {"params": params or self.params, "prompt_index": 0, **(extra or {})}
        return write_sample_batch(self.root, batch or self.batch, {self.relative: item}, process_index=rank, num_processes=processes)

    def read(self):
        return read_sample_records(self.root, {self.relative: file_version(self.image)})

    def test_pairing_preserves_prompt_negative_seed_and_effective_settings(self):
        self.write()
        initial = self.read()[self.relative]
        self.assertTrue(initial["comparable"])
        self.assertEqual(initial["batch_status"], "complete")
        for key, value in (("prompt", "profile"), ("negative_prompt", "text"), ("seed", 43), ("cfg_scale", 7)):
            params = {**self.params, key: value}
            self.write(params=params)
            changed = self.read()[self.relative]
            self.assertNotEqual(initial["pair_key"], changed["pair_key"])
            if key in {"prompt", "negative_prompt"}:
                self.assertNotEqual(initial["prompt_id"], changed["prompt_id"])
            self.assertEqual(initial["condition_key"] == changed["condition_key"], key != "cfg_scale")
        self.write(batch={**self.batch, "id": "batch-400", "step": 400, "order": 400})
        later = self.read()[self.relative]
        self.assertEqual(initial["pair_key"], later["pair_key"])

    def test_preview_metadata_reads_png_text_without_getexif_or_pixel_decode_when_no_exif_header_exists(self):
        info = PngInfo()
        info.add_text("parameters", json.dumps(self.params))
        info.add_itxt("anima_sample", json.dumps({"schema_version": 1, "params": self.params}))
        Image.new("RGB", (64, 80)).save(self.image, pnginfo=info)
        with (patch.object(routes, "resolve_artifact_file", return_value=self.image),
              patch.object(Image.Image, "getexif", side_effect=AssertionError("no EXIF header")) as getexif,
              patch.object(PngImageFile, "load", side_effect=AssertionError("must not decode pixels"))):
            response = asyncio.run(routes.monitor_preview_metadata(run_dir="output/test", path=self.relative, request=None))
        data = json.loads(response.body)["data"]
        getexif.assert_not_called()
        self.assertEqual(json.loads(data["png_text"]["parameters"]), self.params)
        self.assertEqual(json.loads(data["png_text"]["anima_sample"])["schema_version"], 1)
        self.assertEqual(data["exif"], {})
        self.assertEqual((data["format"], data["width"], data["height"]), ("PNG", 64, 80))

    def test_preview_metadata_parses_an_existing_png_exif_header_without_pixel_decode(self):
        exif = Image.Exif()
        exif[315] = "sample artist"
        Image.new("RGB", (64, 80)).save(self.image, exif=exif)
        with (patch.object(routes, "resolve_artifact_file", return_value=self.image),
              patch.object(PngImageFile, "load", side_effect=AssertionError("must not decode pixels"))):
            response = asyncio.run(routes.monitor_preview_metadata(run_dir="output/test", path=self.relative, request=None))
        data = json.loads(response.body)["data"]
        self.assertEqual(data["exif"]["315"], "sample artist")

    def test_unverified_or_random_parameters_never_pair(self):
        self.write(extra={"params_complete": False})
        self.assertFalse(self.read()[self.relative]["comparable"])
        for seed in (None, -1):
            self.write(params={**self.params, "seed": seed})
            sample = self.read()[self.relative]
            self.assertFalse(sample["comparable"])
            self.assertIsNone(sample["condition_key"])

    def test_epoch_sampling_preserves_progress_and_parameters(self):
        self.write(batch={**self.batch, "id": "epoch-3", "epoch": 3, "step": 1200})
        sample = self.read()[self.relative]
        self.assertEqual((sample["stage_kind"], sample["stage_value"], sample["batch_label"]), ("epoch", 3, "Epoch 3 · Step 1200"))
        self.assertEqual((sample["epoch"], sample["step"]), (3, 1200))
        self.assertTrue(sample["comparable"])
        legacy = legacy_sample_metadata("demo_e000003_00_20261114090000_42.png", "sample/demo_e000003_00_20261114090000_42.png")
        self.assertEqual((legacy["stage_kind"], legacy["batch_label"]), ("epoch", "Epoch 3"))
        self.assertFalse(legacy["comparable"])

    def test_step_sampling_shows_observed_epoch_without_changing_stage(self):
        self.write(batch={**self.batch, "current_epoch": 3})
        sample = self.read()[self.relative]
        self.assertEqual((sample["stage_kind"], sample["stage_value"]), ("step", 200))
        self.assertEqual((sample["epoch"], sample["step"], sample["batch_label"]), (3, 200, "Epoch 3 · Step 200"))
        self.assertTrue(sample["comparable"])

    def test_initial_or_resumed_first_sample_never_claims_epoch_zero(self):
        for step in (0, 600):
            with self.subTest(step=step):
                self.write(batch={**self.batch, "epoch": 0, "step": step, "current_epoch": 3})
                sample = self.read()[self.relative]
                self.assertEqual((sample["stage_kind"], sample["stage_value"]), ("step", step))
                self.assertIsNone(sample["epoch"])
                self.assertEqual(sample["batch_label"], f"Step {step}")

    def test_conflicting_rank_epochs_fall_back_to_unknown_without_discarding_sample(self):
        self.write(batch={**self.batch, "current_epoch": 3}, rank=0, processes=2)
        self.write(batch={**self.batch, "current_epoch": 4}, rank=1, processes=2)
        sample = self.read()[self.relative]
        self.assertIsNone(sample["epoch"])
        self.assertEqual(sample["batch_label"], "Step 200")
        self.assertEqual(sample["batch_status"], "complete")
        self.assertTrue(sample["comparable"])

    def test_uint64_seeds_remain_exact_for_browser_dimensions(self):
        first_seed = 2 ** 63 + 10
        self.write(params={**self.params, "seed": first_seed})
        first = self.read()[self.relative]
        self.write(params={**self.params, "seed": first_seed + 1})
        second = self.read()[self.relative]
        self.assertEqual(first["seed"], str(first_seed))
        self.assertEqual(first["params"]["seed"], str(first_seed))
        self.assertNotEqual(first["seed"], second["seed"])
        self.assertNotEqual(first["pair_key"], second["pair_key"])
        self.assertEqual(first["condition_key"], second["condition_key"])
        weights = {"path": "model.safetensors", "mtime_ns": 1790000000000000001}
        self.write(params={**self.params, "base_model": weights, "loras": [weights], "model_variant": {"base": weights}})
        recorded = self.read()[self.relative]
        self.assertEqual(recorded["params"]["loras"][0]["mtime_ns"], str(weights["mtime_ns"]))
        self.assertEqual(recorded["params"]["model_variant"]["base"]["mtime_ns"], str(weights["mtime_ns"]))

    def test_metadata_only_completion_invalidates_preview_cache(self):
        self.write(batch={**self.batch, "status": "running"})
        initial = newest_previews(str(self.root), run_dir="output/sample-metadata-test")
        version = initial[0]["version"]
        self.write()
        complete = newest_previews(str(self.root), run_dir="output/sample-metadata-test")
        self.assertEqual(complete[0]["version"], version)
        self.assertEqual(complete[0]["sample"]["batch_status"], "complete")
        self.assertNotEqual(initial[0]["sample"]["metadata_version"], complete[0]["sample"]["metadata_version"])

    def test_cached_manifest_signature_does_not_stat_each_batch(self):
        for index in range(3):
            self.write(batch={**self.batch, "id": f"batch-{index}"})
        first = sample_metadata.sample_manifest_version(self.root)
        original_stat = Path.stat
        records = []

        def stat(path, *args, **kwargs):
            if path.suffix == ".json":
                records.append(path)
            return original_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat):
            self.assertEqual(sample_metadata.sample_manifest_version(self.root), first)
            self.assertEqual(records, [])
            self.assertEqual(sample_metadata.sample_manifest_version(self.root, force_refresh=True), first)
            self.assertEqual(len(records), 3)

    def test_in_place_manifest_changes_refresh_on_ttl_or_force(self):
        path = self.write(batch={**self.batch, "status": "running"})
        with patch.object(sample_metadata.time, "monotonic", return_value=0):
            first = newest_previews(str(self.root), force_refresh=True)
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["batch"]["status"] = "complete"
        path.write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(sample_metadata.time, "monotonic", return_value=1):
            self.assertIs(newest_previews(str(self.root)), first)
        with patch.object(sample_metadata.time, "monotonic", return_value=6):
            complete = newest_previews(str(self.root))
        self.assertEqual(complete[0]["sample"]["batch_status"], "complete")
        payload["batch"]["status"] = "failed"
        path.write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(sample_metadata.time, "monotonic", return_value=7):
            forced = newest_previews(str(self.root), force_refresh=True)
        self.assertEqual(forced[0]["sample"]["batch_status"], "failed")

    def test_replaced_image_rejects_stale_record_and_legacy_stays_unpaired(self):
        self.write()
        Image.new("RGB", (80, 64), "red").save(self.image)
        self.assertEqual(self.read(), {})
        sample = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertEqual(sample["metadata_source"], "filename")
        self.assertFalse(sample["comparable"])
        self.assertEqual(sample["seed"], 42)

    def test_invalid_manifest_path_does_not_discard_valid_samples(self):
        path = self.write()
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["items"]["sample/\x00.png"] = {"file_version": "1-1", "params": {}}
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.assertEqual(set(self.read()), {self.relative})

    def test_unchanged_poll_reuses_records_without_json_or_normalization(self):
        self.write()
        legacy = self.image.with_name("legacy_000400_00_20261114090100_42.png")
        Image.new("RGB", (8, 8)).save(legacy)
        initial = newest_previews(str(self.root), force_refresh=True)
        with (patch.object(sample_metadata.json, "loads", side_effect=AssertionError("unchanged manifest")),
              patch.object(sample_metadata, "_normalize", side_effect=AssertionError("unchanged record")),
              patch.object(artifacts, "_PREVIEWS_CACHE_TTL", 0)):
            refreshed = newest_previews(str(self.root))
        self.assertEqual(initial, refreshed)
        self.assertIsNot(initial[0]["sample"], refreshed[0]["sample"])
        self.assertIsNot(initial[1]["sample"], refreshed[1]["sample"])

    def test_force_refresh_recovers_transient_manifest_read_failures(self):
        rank_zero = self.write(rank=0, processes=2)
        self.write(rank=1, processes=2)
        original = Path.read_text

        def unreadable(path, *args, **kwargs):
            if path == rank_zero:
                raise PermissionError("temporarily locked")
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", unreadable):
            partial = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertEqual((partial["metadata_source"], partial["batch_status"]), ("recorded", "running"))
        self.assertEqual(newest_previews(str(self.root), force_refresh=True)[0]["sample"]["batch_status"], "complete")

        with patch.object(Path, "read_text", side_effect=PermissionError("temporarily locked")):
            fallback = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertEqual(fallback["metadata_source"], "filename")
        self.assertEqual(newest_previews(str(self.root), force_refresh=True)[0]["sample"]["metadata_source"], "recorded")

    def test_unchanged_manifest_checks_only_new_or_replaced_images(self):
        second = self.image.with_name("demo_000400_00_20261114090100_42.png")
        Image.new("RGB", (8, 8)).save(second)
        relative = second.relative_to(self.root).as_posix()
        self.write()
        write_sample_batch(self.root, {**self.batch, "id": "batch-400", "order": 400},
                           {relative: {"params": self.params, "prompt_index": 0}})
        hidden = second.with_suffix(".hidden")
        second.rename(hidden)
        newest_previews(str(self.root), force_refresh=True)
        hidden.rename(second)
        with (patch.object(artifacts, "read_sample_records", wraps=read_sample_records) as read,
              patch.object(artifacts, "_PREVIEWS_CACHE_TTL", 0)):
            refreshed = newest_previews(str(self.root))
        self.assertEqual(set(read.call_args.args[1]), {relative})
        self.assertEqual({item["sample"]["metadata_source"] for item in refreshed}, {"recorded"})
        Image.new("RGB", (80, 64), "red").save(self.image)
        with (patch.object(artifacts, "read_sample_records", wraps=read_sample_records) as read,
              patch.object(artifacts, "_PREVIEWS_CACHE_TTL", 0)):
            replaced = newest_previews(str(self.root))
        self.assertEqual(set(read.call_args.args[1]), {self.relative})
        self.assertEqual(replaced[0]["sample"]["metadata_source"], "filename")
        second.unlink()
        self.assertEqual(len(newest_previews(str(self.root), force_refresh=True)), 1)

    def test_preview_cache_replaces_each_runs_metadata_and_stays_bounded(self):
        with patch.object(artifacts, "_previews_cache", OrderedDict()):
            for status in ("running", "complete", "failed"):
                self.write(batch={**self.batch, "status": status})
                newest_previews(str(self.root), force_refresh=True)
            self.assertEqual(len(artifacts._previews_cache), 1)
            for index in range(artifacts._PREVIEWS_CACHE_MAX_RUNS):
                newest_previews(str(self.root / str(index)), force_refresh=True)
            self.assertEqual(len(artifacts._previews_cache), artifacts._PREVIEWS_CACHE_MAX_RUNS)
            self.assertNotIn(f"|{self.root}", artifacts._previews_cache)

    def test_rank_merge_rejects_conflicts_and_large_counts_are_bounded(self):
        batch = {**self.batch, "expected": 1}
        self.write(batch=batch, rank=0, processes=2)
        self.assertEqual(self.read()[self.relative]["batch_status"], "running")
        self.write(batch=batch, rank=1, processes=2)
        self.assertEqual(self.read()[self.relative]["batch_status"], "complete")
        self.write(batch=batch, params={**self.params, "cfg_scale": 7}, rank=1, processes=2)
        self.assertEqual(self.read(), {})
        self.write(batch={**batch, "step": 201}, rank=1, processes=2)
        self.assertEqual(self.read(), {})
        path = self.write(batch=batch, rank=0, processes=2)
        data = json.loads(path.read_text(encoding="utf-8"))
        data["num_processes"] = 10 ** 30
        data["batch"].update(id="huge-process-count", order=1000)
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.read()[self.relative]["batch_status"], "running")

    def test_finished_with_missing_generation_is_failed(self):
        self.write(batch={**self.batch, "expected": 2})
        self.assertEqual(self.read()[self.relative]["batch_status"], "failed")
