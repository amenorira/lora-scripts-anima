"""Regression checks for the diagnostics journal and versioned API."""
import json
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.monitor import dataset_diagnostics as diagnostics, run_registry
from backend.monitor.dataset_diagnostic_index import LossIndex
from backend.monitor.routes import router
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


class DatasetDiagnosticsIndexTests(CrossDriveSandbox):
    def setUp(self):
        super().setUp()
        diagnostics.clear_dataset_diagnostics_cache()
        run = self.output / "index"
        run.mkdir()
        self._write_config(run / "config.toml", self.external / "index", "index")
        run_registry.write_run_record(run, artifact_dir=self.external / "index", extra={"profile_id": "anima-lora"})
        control = run / "log" / ".run-control"
        control.mkdir(parents=True)
        self.path = control / "loss.jsonl"
        self.record = run_registry.load_run_record(run)
        self.add({"run_id": "first"})

    def tearDown(self):
        diagnostics.clear_dataset_diagnostics_cache()
        super().tearDown()

    def add(self, *rows, mode="a"):
        with self.path.open(mode, encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    @staticmethod
    def sample(image, timestep, loss, epoch=1, step=1):
        return {"image": str(image), "timestep": timestep, "loss": loss, "step": step, "epoch": epoch,
                "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 2}

    def test_only_appended_rows_are_reindexed_and_local_images_are_checked_once(self):
        a, b, c = [self.root / f"{name}.png" for name in ("a", "b", "c")]
        initial = [self.sample(image, timestep, (i + 1) / 1000, 1 + i % 4, i)
                   for i in range(40) for image in (a, b) for timestep in (.2, .5, .8)]
        self.add(*initial)
        original_bins = LossIndex.bins
        processed = []

        def track_bins(index, values):
            processed.append(len(values))
            return original_bins(index, values)

        with patch.object(LossIndex, "bins", track_bins), patch.object(
            diagnostics, "_resolve_local_image_path", wraps=diagnostics._resolve_local_image_path,
        ) as stat_image:
            first = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
            self.assertEqual(processed, [len(initial)])
            self.assertEqual(stat_image.call_count, 2)
            same = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3, known_revision=first["revision"])
            self.assertEqual(same, {"revision": first["revision"], "unchanged": True})
            self.assertEqual(processed, [len(initial)])

            processed.clear()
            self.add(self.sample(a, .5, .4, 5, 41), self.sample(c, .5, .3, 5, 42))
            updated = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
            self.assertEqual(processed, [2])
            self.assertEqual(stat_image.call_count, 3)
            self.assertNotEqual(first["revision"], updated["revision"])

            processed.clear()
            detail = diagnostics.read_dataset_diagnostic_image(
                self.record, num_bins=3, image_id=next(image["image_id"] for image in updated["by_image"] if image["name"] == "c.png"),
            )
            self.assertEqual(processed, [1])
            self.assertEqual(detail["revision"], updated["revision"])
            self.assertEqual(detail["by_timestep"], updated["by_timestep"])

            c.touch()
            checked = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3, refresh_local=True)
            self.assertEqual(stat_image.call_count, 6)
            self.assertNotEqual(checked["revision"], updated["revision"])
            self.assertTrue(next(image["local_available"] for image in checked["by_image"] if image["name"] == "c.png"))

        self._assert_cold_parity(checked)
        self.add(self.sample(c, .98, .5), self.sample(b, .98, .4))
        rebinned = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
        self.assertEqual(rebinned["by_timestep"][-1]["timestep_to"], .98)
        self._assert_cold_parity(rebinned)

    def _assert_cold_parity(self, indexed):
        diagnostics.clear_dataset_diagnostics_cache()
        cold = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
        self.assertEqual({k: v for k, v in indexed["summary"].items() if k != "mean_loss"},
                         {k: v for k, v in cold["summary"].items() if k != "mean_loss"})
        self.assertAlmostEqual(indexed["summary"]["mean_loss"], cold["summary"]["mean_loss"])
        for warm_bin, cold_bin in zip(indexed["by_timestep"], cold["by_timestep"], strict=True):
            self.assertEqual(warm_bin["count"], cold_bin["count"])
            self.assertAlmostEqual(warm_bin["mean_loss"], cold_bin["mean_loss"])
        cold_images = {image["image_id"]: image for image in cold["by_image"]}
        for image in indexed["by_image"]:
            comparison = cold_images[image["image_id"]]
            for field in ("count", "comparable_count", "epochs", "status", "resolutions", "subsets"):
                self.assertEqual(image[field], comparison[field])
            for field in ("mean_loss", "mean_residual", "slope"):
                if image[field] is None:
                    self.assertIsNone(comparison[field])
                else:
                    self.assertAlmostEqual(image[field], comparison[field])

    def test_http_revision_and_isolation_across_selections_and_log_rewrite(self):
        self.add(self.sample("first.png", .1, 1.))
        self.add({"run_id": "second"}, self.sample("second.png", .3, 2.))
        app = FastAPI()
        app.include_router(router)
        url = "/monitor/dataset-diagnostics"
        with TestClient(app) as client:
            ref = {"run_dir": self.record["run_dir"]}
            first = client.get(url, params={**ref, "run_id": "first"}).json()["data"]
            reply = client.get(url, params={**ref, "run_id": "first", "known_revision": first["revision"]}).json()
            self.assertEqual(reply["revision"], first["revision"])
            self.assertEqual(reply["data"], {"revision": first["revision"], "unchanged": True})
            second = client.get(url, params={**ref, "known_revision": first["revision"]}).json()["data"]
            self.assertEqual(second["run_id"], "second")
            self.assertNotEqual(second["revision"], first["revision"])
            combined = client.get(url, params={**ref, "run_id": "all"}).json()["data"]
            self.assertEqual({image["name"] for image in combined["by_image"]}, {"first.png", "second.png"})
            wrong = client.get(url + "/image", params={**ref, "image_id": first["by_image"][0]["image_id"]})
            self.assertEqual(wrong.status_code, 404)
            detail = client.get(url + "/image", params={**ref, "run_id": "first", "image_id": first["by_image"][0]["image_id"]})
            self.assertEqual(detail.json()["data"]["revision"], first["revision"])

            samples = [self.sample(f"replacement{i}.png", .5, i + 1., step=i) for i in range(6)]
            self.add({"run_id": "replacement"}, *samples, mode="w")
            rewritten = client.get(url, params={**ref, "known_revision": second["revision"]}).json()["data"]
            self.assertEqual(rewritten["available_runs"], ["replacement"])
            self.assertEqual(rewritten["summary"]["samples"], 6)
            self.assertEqual({image["name"] for image in rewritten["by_image"]}, {f"replacement{i}.png" for i in range(6)})

    def test_cache_eviction_preserves_revisions_and_file_isolation(self):
        self.add(self.sample("common.png", .25, 1.0))
        other_run = self.output / "other-index"
        control = other_run / "log" / ".run-control"
        control.mkdir(parents=True)
        loss = control / "loss.jsonl"
        loss.write_text(json.dumps({"run_id": "first"}) + "\n" + json.dumps(self.sample("common.png", .25, 2.0)) + "\n",
                        encoding="utf-8")
        other_record = {**self.record, "run_dir": "output/other-index", "run_path": other_run}
        with patch.object(diagnostics, "_MAX_CACHED_FILES", 1):
            first = diagnostics.analyze_dataset_diagnostics(self.record)
            other = diagnostics.analyze_dataset_diagnostics(other_record)
            self.assertEqual(other["by_image"][0]["mean_loss"], 2.0)
            self.assertNotEqual(first["revision"], other["revision"])
            self.assertEqual(diagnostics.analyze_dataset_diagnostics(self.record, known_revision=first["revision"]),
                             {"revision": first["revision"], "unchanged": True})
            detail = diagnostics.read_dataset_diagnostic_image(self.record, image_id=first["by_image"][0]["image_id"])
            self.assertEqual(detail["revision"], first["revision"])
            self.assertEqual(detail["image"]["mean_loss"], 1.0)

