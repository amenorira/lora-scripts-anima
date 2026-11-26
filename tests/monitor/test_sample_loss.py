import tempfile
import unittest
import asyncio
import json
import math
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image
from tensorboard.compat.proto.event_pb2 import Event
from tensorboard.compat.proto.summary_pb2 import Summary
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from backend.monitor import training
from backend.monitor import artifacts, routes, run_registry, sample_loss, legacy_sample_steps
from backend.monitor.sample_metadata import write_sample_batch
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


class SampleEpochLossTests(unittest.TestCase):
    def test_full_step_snapshot_covers_more_than_fifty_thousand_events(self):
        from tensorboard.backend.event_processing.event_accumulator import ScalarEvent

        events = [ScalarEvent(0, step, 1 / step) for step in range(1, 60001)]
        accumulator = Mock()
        accumulator.Tags.return_value = {"scalars": ["loss/average", "lr/unet"]}
        accumulator.Scalars.return_value = events
        with tempfile.TemporaryDirectory() as directory, patch.object(training, "_get_cached_accumulator", return_value=accumulator):
            (Path(directory) / "log").mkdir()
            snapshot = training.read_tensorboard_loss(run_dir=directory, downsample_to=500)
        self.assertEqual(len(snapshot), 2)
        for series in snapshot:
            self.assertEqual(len(series["points"]), 500)
            self.assertEqual((series["points"][0]["step"], series["points"][-1]["step"]), (1, 60000))
            tail_length = 160 if series["tag"] == "loss/average" else 40
            self.assertEqual([p["step"] for p in series["diagnostic_points"]], list(range(60001 - tail_length, 60001)))

    def test_nonfinite_loss_values_do_not_reach_history_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            writer = EventFileWriter(str(run / "log"))
            try:
                for step, value in enumerate([.5, .125, .25, .5, math.inf, .75, math.nan], start=1):
                    writer.add_event(Event(step=step, summary=Summary(value=[
                        Summary.Value(tag="loss/average", simple_value=math.nan if step == 1 else value),
                        Summary.Value(tag="loss/current", simple_value=-math.inf if step == 1 else value),
                        Summary.Value(tag="lr/unet", simple_value=value),
                        Summary.Value(tag="loss/epoch", simple_value=-math.inf),
                    ])))
                writer.flush()
                snapshot = training.read_tensorboard_loss(run_dir=str(run), limit=5)
                json.dumps(snapshot, allow_nan=False)
                by_tag = {series["tag"]: series for series in snapshot}
                self.assertEqual(set(by_tag), {"loss/average", "loss/current", "lr/unet"})
                for tag, series in by_tag.items():
                    self.assertEqual([p["step"] for p in series["points"]], [3, 4, 6])
                    self.assertEqual(series["diagnostic_points"], series["points"])
                    self.assertEqual(series["latest"], .75)
                    self.assertEqual(series["max"], .75)
                    expected_min = (.25, 3) if tag == "lr/unet" else (.125, 2)
                    self.assertEqual((series["min"], series["min_step"]), expected_min)
            finally:
                writer.close()
                training._tb_cache.pop(str(run / "log"), None)

    def test_full_loss_minimum_survives_display_window_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            writer = EventFileWriter(str(run / "log"))
            try:
                for step in range(1, 9):
                    writer.add_event(Event(step=step, summary=Summary(value=[
                        Summary.Value(tag="loss/average", simple_value=step / 10),
                    ])))
                writer.flush()
                series, = training.read_tensorboard_loss(run_dir=str(run), limit=4, downsample_to=3)
                self.assertEqual([point["step"] for point in series["diagnostic_points"]], [5, 6, 7, 8])
                self.assertEqual(len(series["points"]), 3)
                self.assertEqual(series["min_step"], 1)
                self.assertAlmostEqual(series["min"], .1)
            finally:
                writer.close()
                training._tb_cache.pop(str(run / "log"), None)

    def test_epoch_partitions_survive_downsampling_and_incremental_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            writer = EventFileWriter(str(run / "log"))
            tags = ("loss/epoch", "loss/timestep/epoch/low", "loss/timestep/epoch/mid", "loss/timestep/epoch/high")

            def record(epoch):
                writer.add_event(Event(wall_time=epoch, step=epoch, summary=Summary(value=[
                    Summary.Value(tag=tag, simple_value=.1 / epoch) for tag in tags
                ])))
                writer.flush()

            try:
                for epoch in range(1, 8):
                    record(epoch)
                snapshot = training.read_tensorboard_loss(run_dir=str(run), downsample_to=3)
                self.assertEqual({series["tag"] for series in snapshot}, set(tags))
                for series in snapshot:
                    self.assertEqual([point["step"] for point in series["points"]], list(range(1, 8)))
                initial = training.read_tensorboard_incremental(run_dir=str(run))
                self.assertEqual(set(initial), set(tags))
                record(8)
                incremental = training.read_tensorboard_incremental(run_dir=str(run))
                for tag in tags:
                    self.assertEqual([point["step"] for point in incremental[tag]], [8])
                self.assertEqual(training.read_tensorboard_incremental(run_dir=str(run)), {})
            finally:
                writer.close()
                training._tb_cache.pop(str(run / "log"), None)
                training._tb_live_cache.pop(str(run / "log"), None)


class SampleSourceLossTests(CrossDriveSandbox):
    def setUp(self):
        super().setUp()
        self.writers = {}
        self.external.joinpath("sample").mkdir()
        for name, hour, overall in (("original", 9, .12), ("resumed", 11, .07)):
            run = self.output / name
            self._write_config(run / "config.toml", self.external, name)
            run_registry.write_run_record(run, artifact_dir=self.external, task_id=name + "-task",
                                          created_at=f"2026-11-17T{hour - 1:02d}:00:00")
            (run / "result.json").write_text(json.dumps({"status": "completed"}), encoding="utf-8")
            (run / "train_test.log").write_text(
                f"epoch 6/10\n2026-11-17 {hour:02d}:00:00 INFO Generating sample images at step 2400\n"
                f"2026-11-17 {hour:02d}:01:00 INFO done\n", encoding="utf-8")
            writer = EventFileWriter(str(run / "log"))
            self.writers[name] = writer
            for epoch, value in ((5, overall + .03), (6, overall)):
                self.record(name, epoch, value)
            for prompt in (0, 1):
                relative = f"sample/demo_e000006_{prompt:02d}_20261117{hour:02d}0015_42.png"
                Image.new("RGB", (8, 8)).save(self.external / relative)
                if prompt == 1:
                    write_sample_batch(self.external,
                        {"id": f"{name}-task:123:anima:6:2400:1", "epoch": 6, "step": 2400,
                         "order": hour, "expected": 1, "status": "complete"},
                        {relative: {"params": {}, "prompt_index": prompt}})

    def tearDown(self):
        for name, writer in self.writers.items():
            writer.close()
            training._tb_cache.pop(str(self.output / name / "log"), None)
            training._tb_epoch_cache.pop(str(self.output / name / "log"), None)
        super().tearDown()

    def record(self, name, epoch, value):
        self.writers[name].add_event(Event(step=epoch, summary=Summary(value=[
            Summary.Value(tag="loss/epoch", simple_value=value),
            Summary.Value(tag="loss/timestep/epoch/low", simple_value=value / 2),
            Summary.Value(tag="loss/current", simple_value=value * 2),
        ])))
        self.writers[name].flush()

    def test_original_and_resumed_views_read_each_images_own_loss_for_both_metadata_generations(self):
        for selected, foreign, expected in (("resumed", "original", .12), ("original", "resumed", .07)):
            with self.subTest(selected=selected):
                response = asyncio.run(routes.monitor_run_detail(f"output/{selected}"))
                items = response["data"]["previews"]
                self.assertEqual(len(items), 4)
                self.assertEqual(len({item["sample"]["batch_id"] for item in items}), 4)
                other = [item["sample"] for item in items if item["sample"]["loss_run_dir"] == f"output/{foreign}"]
                self.assertEqual({item["metadata_source"] for item in other}, {"filename", "recorded"})
                for sample in other:
                    self.assertAlmostEqual(sample["epoch_loss"]["values"]["overall"], expected)
                    self.assertAlmostEqual(sample["epoch_loss"]["previous"]["overall"], expected + .03)
                    self.assertAlmostEqual(sample["epoch_loss"]["values"]["low"], expected / 2)
                    self.assertEqual(sample["step"], 2400)
                self.assertTrue(all("epoch_loss" not in item["sample"] for item in items
                                    if item["sample"]["loss_run_dir"] == f"output/{selected}"))
                refreshed = asyncio.run(routes.monitor_previews(run_dir=f"output/{selected}", task_id="", refresh=1, limit=0))
                self.assertEqual(refreshed["data"], items)

    def test_preview_cache_batches_source_reads_and_refresh_picks_up_appended_loss(self):
        with (patch.object(sample_loss, "read_tensorboard_loss", wraps=training.read_tensorboard_loss) as read,
              patch.object(legacy_sample_steps, "_parse_calls", wraps=legacy_sample_steps._parse_calls) as parse,
              patch.object(Image, "open", side_effect=AssertionError("sample loss must not decode images"))):
            first = artifacts.newest_previews(str(self.external), run_dir="output/resumed", force_refresh=True)
            self.assertEqual(read.call_count, 1, "read one epoch table per foreign run, not per image")
            self.assertTrue(read.call_args.kwargs["epoch_only"])
            cached = training._tb_epoch_cache[str(self.output / "original" / "log")][-1]
            self.assertNotIn("loss/current", cached.Tags()["scalars"], "foreign caches retain only epoch scalars")
            self.assertEqual(parse.call_count, 2, "parse each source log once")
            for _ in range(3):
                self.assertIs(artifacts.newest_previews(str(self.external), run_dir="output/resumed"), first)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(parse.call_count, 2)
            self.record("original", 6, .11)
            refreshed = artifacts.newest_previews(str(self.external), run_dir="output/resumed", force_refresh=True)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(parse.call_count, 2, "unchanged sampling logs are not parsed again")
            self.assertTrue(all(abs(item["sample"]["epoch_loss"]["values"]["overall"] - .11) < 1e-6
                                for item in refreshed if item["sample"]["loss_run_dir"] == "output/original"))

    def test_filename_samples_use_run_start_times_when_old_sampling_logs_are_absent(self):
        for name in ("original", "resumed"):
            (self.output / name / "train_test.log").unlink()
        for selected, foreign, expected in (("original", "resumed", .07), ("resumed", "original", .12)):
            items = artifacts.newest_previews(str(self.external), run_dir=f"output/{selected}", force_refresh=True)
            legacy = [item["sample"] for item in items if item["sample"]["metadata_source"] == "filename"]
            self.assertEqual({sample["loss_run_dir"] for sample in legacy}, {"output/original", "output/resumed"})
            self.assertEqual(len({sample["batch_id"] for sample in legacy}), 2)
            foreign_sample = next(sample for sample in legacy if sample["loss_run_dir"] == f"output/{foreign}")
            self.assertAlmostEqual(foreign_sample["epoch_loss"]["values"]["overall"], expected)
