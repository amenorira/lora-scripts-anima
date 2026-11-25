import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend.monitor import dataset_diagnostics, run_registry
from backend.monitor.routes import router as monitor_router
from backend.server.routes.image_preview import router as image_preview_router
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


def _load_upstream_analyzer():
    path = Path(__file__).resolve().parents[2] / "vendor" / "sd-scripts" / "tools" / "analyze_run_loss.py"
    spec = importlib.util.spec_from_file_location("upstream_analyze_run_loss", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class DatasetDiagnosticsTests(CrossDriveSandbox):
    def setUp(self):
        super().setUp()
        dataset_diagnostics.clear_dataset_diagnostics_cache()

    def tearDown(self):
        dataset_diagnostics.clear_dataset_diagnostics_cache()
        super().tearDown()

    def _create_run(
        self,
        name: str = "demo",
        *,
        profile: str = "anima-lora",
        manifest: dict | None = None,
        loss_lines: list[str] | None = None,
    ) -> Path:
        run = self.output / name
        run.mkdir(parents=True, exist_ok=True)
        self._write_config(run / "config.toml", self.external / name, name)
        with (run / "config.toml").open("a", encoding="utf-8") as stream:
            stream.write('caption_extension = ".txt"\n')
        run_registry.write_run_record(
            run,
            artifact_dir=self.external / name,
            task_id=f"{name}-task",
            extra={"profile_id": profile},
        )
        ctrl = run / "log" / ".run-control"
        ctrl.mkdir(parents=True, exist_ok=True)
        if manifest is not None:
            (ctrl / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        if loss_lines is not None:
            (ctrl / "loss.jsonl").write_text("\n".join(loss_lines) + ("\n" if loss_lines else ""), encoding="utf-8")
        return run

    def test_residual_matches_upstream_analyzer_and_tracks_nonfinite(self):
        upstream = _load_upstream_analyzer()
        dataset_dir = self.root / "dataset"
        (dataset_dir / "char").mkdir(parents=True)
        (dataset_dir / "reg").mkdir(parents=True)

        img_hard = dataset_dir / "char" / "hard.png"
        img_learn = dataset_dir / "char" / "improving.png"
        img_easy = dataset_dir / "char" / "easy.png"
        img_reg = dataset_dir / "reg" / "reg1.png"
        for p in (img_hard, img_learn, img_easy, img_reg):
            Image.new("RGB", (64, 64), (120, 80, 200)).save(p)
        (img_hard.with_suffix(".txt")).write_text("1girl, solo, blue hair", encoding="utf-8")

        rows_raw = []
        step = 0
        for epoch in range(1, 5):
            for t, base in ((0.15, 0.10), (0.85, 0.50)):
                step += 1
                rows_raw.append({"step": step, "epoch": epoch, "image": str(img_hard), "dataset": 0, "subset": 0,
                                 "timestep": t, "loss": base * 1.5, "width": 768, "height": 512, "batch_size": 2, "loss_weight": 1.0})
                rows_raw.append({"step": step, "epoch": epoch, "image": str(img_learn), "dataset": 0, "subset": 0,
                                 "timestep": t, "loss": base * (2.0 - 0.2 * epoch), "width": 768, "height": 512, "batch_size": 2, "loss_weight": 1.0})
                rows_raw.append({"step": step, "epoch": epoch, "image": str(img_easy), "dataset": 0, "subset": 0,
                                 "timestep": t, "loss": base * 0.65, "width": 512, "height": 512, "batch_size": 2, "loss_weight": 1.0})
                rows_raw.append({"step": step, "epoch": epoch, "image": str(img_reg), "dataset": 0, "subset": 1,
                                 "timestep": t, "loss": base * 0.95, "width": 512, "height": 512, "batch_size": 2, "loss_weight": 0.5})

        nan_row = {"step": step + 1, "epoch": 4, "image": str(img_easy), "dataset": 0, "subset": 0,
                   "timestep": 0.5, "loss": None, "width": 512, "height": 512, "batch_size": 2, "loss_weight": 1.0}

        lines = [json.dumps({"run_id": "run1", "ts": 100.0}), json.dumps(rows_raw[0]), json.dumps({"run_id": "run2", "ts": 200.0})]
        lines.extend(json.dumps(r) for r in rows_raw)
        lines.append(json.dumps(nan_row))

        manifest = {
            "training": {"num_processes": 1},
            "metadata": {
                "ss_datasets": [
                    {
                        "subsets": [
                            {"image_dir": "10_char", "is_reg": False, "num_repeats": 10},
                            {"image_dir": "1_reg", "is_reg": True, "num_repeats": 1},
                        ]
                    }
                ]
            },
        }
        run = self._create_run("parity", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)

        result = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=3, num_bins=10)
        up_rows = [dict(r) for r in rows_raw]
        up_result = upstream.analyze(up_rows, num_bins=10)

        self.assertTrue(result["available"])
        self.assertEqual(result["run_id"], "run2")
        self.assertEqual(result["available_runs"], ["run1", "run2"])
        self.assertEqual(result["timestep_scale"], "unit")
        self.assertEqual(result["summary"]["samples"], len(rows_raw))
        self.assertEqual(result["summary"]["non_finite_total"], 1)
        self.assertTrue(result["summary"]["has_reg_images"])

        by_name = {item["name"]: item for item in result["by_image"]}
        up_by_name = {Path(item["image"]).name: item for item in up_result["by_image"]}

        for fname in ("hard.png", "improving.png", "easy.png", "reg1.png"):
            self.assertAlmostEqual(by_name[fname]["mean_residual"], up_by_name[fname]["mean_residual"], places=6)

        self.assertEqual(by_name["hard.png"]["status"], "attention")
        self.assertEqual(by_name["improving.png"]["status"], "learning")
        self.assertEqual(by_name["easy.png"]["status"], "non_finite")
        self.assertEqual(by_name["easy.png"]["non_finite_count"], 1)
        self.assertTrue(by_name["reg1.png"]["is_reg"])
        self.assertEqual(by_name["reg1.png"]["subset_label"], "1_reg")

        # Noise zones summary (timesteps 0.15 -> low, 0.85 -> high, mid == 0)
        zones = result["noise_zones"]
        self.assertEqual(zones["high"]["count"], len(rows_raw) // 2)
        self.assertEqual(zones["mid"]["count"], 0)
        self.assertEqual(zones["low"]["count"], len(rows_raw) // 2)
        self.assertAlmostEqual(zones["high"]["share"] + zones["low"]["share"], 1.0, places=6)
        self.assertIsNotNone(by_name["hard.png"]["noise_zones"]["high"])
        self.assertIsNotNone(by_name["hard.png"]["noise_zones"]["high"]["mean_loss"])
        self.assertGreater(by_name["hard.png"]["noise_zones"]["high"]["mean_loss"], 0.0)
        self.assertIsNone(by_name["hard.png"]["noise_zones"]["mid"])
        self.assertIsNotNone(by_name["hard.png"]["noise_zones"]["low"])

        # Merging all recorded run segments
        merged = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=3, num_bins=10, run_id="all")
        self.assertEqual(merged["run_id"], "all")
        self.assertEqual(merged["summary"]["samples"], len(rows_raw) + 1)

        # Detail API + caption + preview URL + per-image noise zones
        hard_id = by_name["hard.png"]["image_id"]
        detail = dataset_diagnostics.read_dataset_diagnostic_image(record, image_id=hard_id, min_count=3, num_bins=10)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["caption"]["exists"], True)
        self.assertEqual(detail["caption"]["text"], "1girl, solo, blue hair")
        self.assertEqual(detail["file_info"]["width"], 64)
        self.assertEqual(len(detail["epoch_series"]), 4)
        self.assertEqual(detail["image"]["noise_zones"], by_name["hard.png"]["noise_zones"])

    def test_incremental_read_handles_incomplete_line_and_reset(self):
        manifest = {"training": {"num_processes": 2}}
        run = self._create_run("inc", profile="sdxl-lora", manifest=manifest, loss_lines=[json.dumps({"run_id": "r1", "ts": 1.0})])
        loss_path = run / "log" / ".run-control" / "loss.jsonl"
        row1 = json.dumps({"step": 1, "epoch": 1, "image": "a.png", "timestep": 500.0, "loss": 0.25, "width": 512, "height": 512})
        row2 = json.dumps({"step": 2, "epoch": 2, "image": "a.png", "timestep": 500.0, "loss": 0.20, "width": 512, "height": 512})
        # Append complete row1 + incomplete trailing line
        with loss_path.open("ab") as f:
            f.write((row1 + "\n" + row2[:20]).encode("utf-8"))

        record = run_registry.load_run_record(run)
        first = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertEqual(first["summary"]["samples"], 1)
        self.assertTrue(first["summary"]["multi_gpu_partial"])
        self.assertEqual(first["timestep_scale"], "thousand")
        self.assertFalse(first["summary"]["has_slope"])

        # Complete the second line
        with loss_path.open("ab") as f:
            f.write((row2[20:] + "\n").encode("utf-8"))
        second = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertEqual(second["summary"]["samples"], 2)

        # Truncate and rewrite with fewer bytes
        loss_path.write_text(json.dumps({"run_id": "r2", "ts": 2.0}) + "\n" + row1 + "\n", encoding="utf-8")
        third = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertEqual(third["run_id"], "r2")
        self.assertEqual(third["summary"]["samples"], 1)

    def test_http_routes_and_image_preview_security(self):
        img = self.root / "sample_pic.png"
        Image.new("RGB", (32, 32), (20, 180, 90)).save(img)
        img.with_suffix(".txt").write_text("cat, grass", encoding="utf-8")

        run_ok = self._create_run(
            "api_ok",
            loss_lines=[
                json.dumps({"run_id": "r1", "ts": 1.0}),
                json.dumps({"step": 1, "epoch": 1, "image": str(img), "timestep": 0.5, "loss": 0.3, "width": 512, "height": 512}),
            ],
        )
        run_krea = self._create_run("api_krea", profile="krea2-lora")
        run_legacy = self._create_run("api_legacy", profile="sdxl-lora")

        test_app = FastAPI()
        test_app.include_router(monitor_router, prefix="/api")
        test_app.include_router(image_preview_router, prefix="/api")
        with TestClient(test_app) as client:
            resp = client.get("/api/monitor/dataset-diagnostics", params={"run_dir": "output/api_ok", "min_count": 1})
            self.assertEqual(resp.status_code, 200)
            payload = resp.json()["data"]
            self.assertTrue(payload["available"])
            image_id = payload["by_image"][0]["image_id"]

            detail_resp = client.get("/api/monitor/dataset-diagnostics/image", params={"run_dir": "output/api_ok", "image_id": image_id})
            self.assertEqual(detail_resp.status_code, 200)
            self.assertEqual(detail_resp.json()["data"]["caption"]["text"], "cat, grass")

            with patch("backend.image_preview.IMAGE_PREVIEW_CACHE_DIR", self.root / "preview-cache"):
                preview_resp = client.get("/api/image-preview", params={"scope": "loss_sample", "run_dir": "output/api_ok", "path": image_id, "variant": "thumb"})
                self.assertEqual(preview_resp.status_code, 200)
                self.assertEqual(preview_resp.headers["content-type"], "image/webp")

            # Reject unknown / traversal paths
            self.assertEqual(
                client.get("/api/image-preview", params={"scope": "loss_sample", "run_dir": "output/api_ok", "path": "../secret.png", "variant": "thumb"}).status_code,
                404,
            )
            self.assertEqual(
                client.get("/api/image-preview", params={"scope": "loss_sample", "run_dir": "output/api_ok", "path": "0" * 16, "variant": "thumb"}).status_code,
                404,
            )
            self.assertEqual(
                client.get("/api/monitor/dataset-diagnostics/image", params={"run_dir": "output/api_ok", "image_id": "bad"}).status_code,
                404,
            )

            # Unsupported & legacy states
            krea_data = client.get("/api/monitor/dataset-diagnostics", params={"run_dir": "output/api_krea"}).json()["data"]
            self.assertEqual((krea_data["available"], krea_data["reason"]), (False, "unsupported_engine"))

            legacy_data = client.get("/api/monitor/dataset-diagnostics", params={"run_dir": "output/api_legacy"}).json()["data"]
            self.assertEqual((legacy_data["available"], legacy_data["reason"]), (False, "not_recorded"))

    def test_group_tables_match_sd_scripts_resolution_and_subset_order(self):
        lines = [json.dumps({"run_id": "r1", "ts": 1.0})]
        specs = [
            ("img_large.png", 1024, 768, 0, 10, 10, 0.20),
            ("img_wide_a.png", 256, 192, 0, 2, 2, 0.22),
            ("img_wide_b.png", 256, 192, 0, 2, 2, 0.24),
            ("img_tall.png", 192, 256, 0, 1, 1, 0.21),
            ("img_sq.png", 224, 224, 0, 0, 1, 0.23),
            ("img_unk.png", None, None, None, None, None, 0.30),
        ]
        for idx, (name, w, h, ds, sub, bs, loss) in enumerate(specs, start=1):
            row = {
                "step": idx, "epoch": 1, "image": name,
                "timestep": 0.5, "loss": loss,
                "dataset": ds, "subset": sub,
                "width": w, "height": h, "batch_size": bs,
            }
            lines.append(json.dumps(row))
        lines.append(json.dumps({
            "step": 9, "epoch": 1, "image": "img_tall.png",
            "timestep": 0.5, "loss": 0.65,
            "dataset": 0, "subset": 10, "width": 256, "height": 192, "batch_size": 1,
        }))

        run = self._create_run("group_sort", loss_lines=lines)
        record = run_registry.load_run_record(run)
        result = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertTrue(result["available"])
        self.assertEqual(
            [row["key"] for row in result["by_resolution"]],
            ["192x256", "224x224", "256x192", "1024x768", "(unknown)"],
        )
        self.assertEqual(
            [row["key"] for row in result["by_subset"]],
            ["0-0", "0-1", "0-2", "0-10", "(unknown)"],
        )
        self.assertEqual(
            [row["key"] for row in result["by_batch_size"]],
            ["1", "2", "10", "(unknown)"],
        )

    def test_timestep_profile_and_sampling_config(self):
        lines = [json.dumps({"run_id": "r1", "ts": 1.0})]
        # Put 2 images in high-noise bin (t ~ 0.90 -> t1000=900 -> bin 16),
        # 1 image in mid-noise bin (t ~ 0.50 -> t1000=500 -> bin 9, sparse <2 images),
        # and leave bin 0..8 and 17 empty.
        rows = [
            ("img_a.png", 0, 0, 0.90, 0.40, 512, 512, 1),
            ("img_b.png", 0, 1, 0.91, 0.50, 384, 512, 1),
            ("img_a.png", 0, 0, 0.50, 0.30, 512, 512, 1),
        ]
        for step, (name, ds, sub, ts, loss, w, h, epoch) in enumerate(rows, start=1):
            lines.append(json.dumps({
                "step": step, "epoch": epoch, "image": name,
                "timestep": ts, "loss": loss,
                "dataset": ds, "subset": sub,
                "width": w, "height": h, "batch_size": 1,
            }))

        manifest = {
            "args": {
                "timestep_sampling": "sigmoid",
                "discrete_flow_shift": 3.0,
                "sigmoid_scale": 1.0,
                "weighting_scheme": "uniform",
                "min_timestep": 100,
                "max_timestep": 950,
            }
        }
        run = self._create_run("profile_cfg", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)
        result = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertTrue(result["available"])

        cfg = result["sampling_config"]
        self.assertEqual(cfg["timestep_sampling"], "sigmoid")
        self.assertEqual(cfg["discrete_flow_shift"], 3.0)
        self.assertNotIn("min_timestep", cfg)
        self.assertNotIn("max_timestep", cfg)

        # SDXL respects min_timestep/max_timestep and defaults timestep_sampling to "uniform"
        sdxl_manifest = {"args": {"min_timestep": 100, "max_timestep": 950}}
        sdxl_lines = [
            json.dumps({"run_id": "s1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a.png", "timestep": 500, "loss": 0.2, "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1}),
        ]
        sdxl_run = self._create_run("sdxl_cfg", profile="sdxl-lora", manifest=sdxl_manifest, loss_lines=sdxl_lines)
        sdxl_res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(sdxl_run), min_count=1)
        self.assertEqual(sdxl_res["sampling_config"]["timestep_sampling"], "uniform")
        self.assertEqual(sdxl_res["sampling_config"]["min_timestep"], 100)
        self.assertEqual(sdxl_res["sampling_config"]["max_timestep"], 950)

        tp = result["timestep_profile"]
        self.assertEqual(tp["num_bins"], 18)
        self.assertEqual(len(tp["bins"]), 18)
        self.assertAlmostEqual(tp["bins"][6]["t_from"], 1000 / 3, places=4)
        self.assertAlmostEqual(tp["bins"][12]["t_from"], 2000 / 3, places=4)
        self.assertEqual(tp["bins"][0]["count"], 0)
        self.assertIsNone(tp["bins"][0]["mean_loss"])
        # bin 9: only img_a -> images=1 -> comparable=False
        self.assertEqual(tp["bins"][9]["count"], 1)
        self.assertEqual(tp["bins"][9]["images"], 1)
        self.assertFalse(tp["bins"][9]["comparable"])
        # bin 16 (888.9..944.4): both img_a and img_b -> comparable=True
        self.assertEqual(tp["bins"][16]["count"], 2)
        self.assertEqual(tp["bins"][16]["images"], 2)
        self.assertTrue(tp["bins"][16]["comparable"])
        self.assertAlmostEqual(tp["bins"][16]["mean_loss"], 0.45)

        subset_0_0 = tp["by_group"]["subset"]["0-0"]
        self.assertEqual(sum(subset_0_0["counts"]), 2)
        self.assertAlmostEqual(subset_0_0["mean_loss"][16], 0.40)
        self.assertAlmostEqual(subset_0_0["mean_loss"][9], 0.30)
        status_counts_sum = sum(sum(series["counts"]) for series in tp["by_status"].values())
        self.assertEqual(status_counts_sum, 3)

        img_id = result["by_image"][0]["image_id"]
        detail = dataset_diagnostics.read_dataset_diagnostic_image(record, image_id=img_id, min_count=1)
        self.assertEqual(detail["sampling_config"], cfg)
        self.assertEqual(detail["timestep_profile"]["num_bins"], 18)
        self.assertEqual(len(detail["timestep_profile"]["bins"]), 18)

        # Fallback to config.toml when manifest.json has no args, and ignore inverted min >= max
        (run / "log" / ".run-control" / "manifest.json").unlink()
        with (run / "config.toml").open("a", encoding="utf-8") as stream:
            stream.write('timestep_sampling = "shift"\ndiscrete_flow_shift = 2.5\nmin_timestep = 800\nmax_timestep = 400\n')
        dataset_diagnostics.clear_dataset_diagnostics_cache()
        fallback = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertEqual(fallback["sampling_config"]["timestep_sampling"], "shift")
        self.assertEqual(fallback["sampling_config"]["discrete_flow_shift"], 2.5)
        self.assertNotIn("min_timestep", fallback["sampling_config"])
        self.assertNotIn("max_timestep", fallback["sampling_config"])

    def test_historical_manifest_isolation_and_expected_coverage(self):
        lines = [
            json.dumps({"run_id": "r1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "old/a.png", "timestep": 0.4, "loss": 0.25, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
            json.dumps({"step": 2, "epoch": 1, "image": "old/b.png", "timestep": 0.6, "loss": 0.30, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
            json.dumps({"run_id": "r2", "ts": 2.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "reg/c.png", "timestep": 0.4, "loss": 0.20, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
        ]
        manifest = {
            "run_id": "r2",
            "args": {"timestep_sampling": "sigmoid", "min_timestep": 100, "max_timestep": 900},
            "metadata": {
                "ss_datasets": [
                    {
                        "subsets": [
                            {"image_dir": "new_reg_sub", "is_reg": True, "img_count": 10, "num_repeats": 3},
                        ]
                    }
                ]
            },
        }
        run = self._create_run("multi_run_iso", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)

        latest = dataset_diagnostics.analyze_dataset_diagnostics(record, run_id="r2", min_count=1)
        self.assertEqual(latest["summary"]["images_total"], 1)
        self.assertEqual(latest["summary"]["images_expected"], 10)
        self.assertEqual(latest["by_subset"][0]["label"], "new_reg_sub")
        self.assertEqual(latest["by_subset"][0]["is_reg"], True)
        self.assertEqual(latest["by_subset"][0]["expected_images"], 10)
        self.assertEqual(latest["by_subset"][0]["num_repeats"], 3)
        self.assertEqual(latest["sampling_config"]["timestep_sampling"], "sigmoid")

        # Viewing older segment r1 or merged "all" must not inherit r2 manifest labels, is_reg, config, or expected count
        for sel in ("r1", "all"):
            hist = dataset_diagnostics.analyze_dataset_diagnostics(record, run_id=sel, min_count=1)
            self.assertIsNone(hist["summary"]["images_expected"])
            self.assertEqual(hist["sampling_config"], {})
            self.assertEqual(hist["by_subset"][0]["label"], "0-0")
            self.assertIsNone(hist["by_subset"][0]["is_reg"])
            self.assertNotIn("expected_images", hist["by_subset"][0])

    def test_long_log_preserves_first_non_finite_before_truncation(self):
        lines = [json.dumps({"run_id": "long1", "ts": 1.0})]
        for step in range(1, 506):
            is_nan = step in (1, 505)
            lines.append(json.dumps({
                "step": step, "epoch": 1 + (step - 1) // 100, "image": "hero.png",
                "timestep": 0.5, "loss": (None if is_nan else 0.25),
                "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1,
            }))
        run = self._create_run("long_nan", loss_lines=lines)
        record = run_registry.load_run_record(run)
        ov = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        img_id = ov["by_image"][0]["image_id"]
        detail = dataset_diagnostics.read_dataset_diagnostic_image(record, image_id=img_id, min_count=1)
        self.assertTrue(detail["samples_truncated"])
        self.assertEqual(len(detail["samples"]), 500)
        self.assertEqual(detail["first_non_finite"]["step"], 1)
        self.assertEqual(detail["first_non_finite"]["epoch"], 1)
        self.assertTrue(detail["first_non_finite"]["non_finite"])
        self.assertEqual(detail["thresholds"]["high_residual"], 0.20)
        # Early NaN sample at step 1 must be preserved in plotted samples even after 500-item truncation
        self.assertEqual(detail["samples"][0]["step"], 1)
        self.assertTrue(detail["samples"][0]["non_finite"])
        self.assertEqual(detail["samples"][-1]["step"], 505)

    def test_detail_returns_thresholds_subset_meta_and_pure_nan_epoch(self):
        lines = [
            json.dumps({"run_id": "r_meta", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a.png", "timestep": 0.5, "loss": 0.30, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
            json.dumps({"step": 2, "epoch": 1, "image": "b.png", "timestep": 0.5, "loss": 0.20, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
            json.dumps({"step": 3, "epoch": 2, "image": "a.png", "timestep": 0.6, "loss": None, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
            json.dumps({"step": 4, "epoch": 3, "image": "a.png", "timestep": 0.5, "loss": 0.25, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
            json.dumps({"step": 5, "epoch": 3, "image": "b.png", "timestep": 0.5, "loss": 0.20, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
        ]
        manifest = {
            "run_id": "r_meta",
            "metadata": {
                "ss_datasets": [
                    {
                        "subsets": [
                            {
                                "image_dir": "focus_sub",
                                "num_repeats": 2,
                                "flip_aug": True,
                                "custom_attributes": {"timestep_sampling": {"offset": 0.15}},
                            }
                        ]
                    }
                ]
            },
        }
        run = self._create_run("detail_meta", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)
        ov = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        a_id = next(item["image_id"] for item in ov["by_image"] if item["name"] == "a.png")
        detail = dataset_diagnostics.read_dataset_diagnostic_image(record, image_id=a_id, min_count=1)
        self.assertEqual(detail["thresholds"]["high_residual"], 0.20)
        self.assertEqual(detail["subset_meta"]["num_repeats"], 2)
        self.assertEqual(detail["subset_meta"]["aug_flags"], ["flip_aug"])
        self.assertAlmostEqual(detail["subset_meta"]["timestep_offset"], 0.15)
        self.assertAlmostEqual(detail["subset_meta"]["loss_weight"], 0.5)
        by_ep = {row["epoch"]: row for row in detail["epoch_series"]}
        self.assertEqual(sorted(by_ep), [1, 2, 3])
        self.assertIsNone(by_ep[2]["mean_residual"])
        self.assertEqual(by_ep[2]["non_finite_count"], 1)

    def test_timestep_profile_quartiles_trend_and_nan_attribution(self):
        # Single-epoch run keeps trend=None and omits p25/p75 when < 4 samples in bin
        single_lines = [json.dumps({"run_id": "ep1", "ts": 1.0})]
        for idx, (t, loss) in enumerate(((0.90, 0.40), (0.91, 0.50), (0.10, 0.20)), start=1):
            single_lines.append(json.dumps({
                "step": idx, "epoch": 1, "image": f"s{idx}.png",
                "timestep": t, "loss": loss,
                "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1,
            }))
        single_run = self._create_run("single_ep", loss_lines=single_lines)
        single_ov = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(single_run), min_count=1)
        self.assertIsNone(single_ov["noise_zones"]["high"]["trend"])
        self.assertIsNone(single_ov["timestep_profile"]["bins"][16]["trend"])
        self.assertIsNone(single_ov["timestep_profile"]["bins"][16]["p25"])

        # Multi-epoch run computes bin quartiles (>= 4 samples), epoch-halves trend, NaN attribution, and extended config
        lines = [json.dumps({"run_id": "ep4", "ts": 1.0})]
        step = 0
        # High-noise bin 16 (t ~ 0.90) drops 0.60 -> 0.30 (-50%); Low-noise bin 2 (t ~ 0.12) stays flat 0.20 -> 0.20
        for ep in (1, 2, 3, 4):
            hi_base = 0.60 if ep <= 2 else 0.30
            for img, offset in (("a.png", -0.05), ("b.png", 0.05)):
                step += 1
                lines.append(json.dumps({
                    "step": step, "epoch": ep, "image": img, "timestep": 0.90, "loss": hi_base + offset,
                    "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1,
                }))
                step += 1
                lines.append(json.dumps({
                    "step": step, "epoch": ep, "image": img, "timestep": 0.12, "loss": 0.20 + offset * 0.2,
                    "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1,
                }))
        # Two NaN rows in high-noise bin 16 and one in low-noise bin 0
        lines.append(json.dumps({"step": step + 1, "epoch": 4, "image": "a.png", "timestep": 0.91, "loss": None, "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1}))
        lines.append(json.dumps({"step": step + 2, "epoch": 4, "image": "b.png", "timestep": 0.92, "loss": None, "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1}))
        lines.append(json.dumps({"step": step + 3, "epoch": 4, "image": "a.png", "timestep": 0.02, "loss": None, "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1}))

        manifest = {
            "args": {
                "timestep_sampling": "truncated_logit_normal",
                "discrete_flow_shift": 2.0,
                "logit_mean": 0.1,
                "logit_std": 1.1,
                "timestep_cutoff": 0.95,
                "timestep_uniform_ratio": 0.05,
                "resolution": [1024, 1024],
            }
        }
        run = self._create_run("multi_ep_rich", manifest=manifest, loss_lines=lines)
        ov = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(run), min_count=1)
        cfg = ov["sampling_config"]
        self.assertEqual(cfg["logit_mean"], 0.1)
        self.assertEqual(cfg["logit_std"], 1.1)
        self.assertEqual(cfg["timestep_cutoff"], 0.95)
        self.assertEqual(cfg["timestep_uniform_ratio"], 0.05)
        self.assertEqual(cfg["resolution"], "1024,1024")

        self.assertAlmostEqual(ov["noise_zones"]["high"]["trend"], -0.5, places=4)
        self.assertAlmostEqual(ov["noise_zones"]["low"]["trend"], 0.0, places=4)
        self.assertEqual(ov["noise_zones"]["high"]["non_finite_count"], 2)
        self.assertEqual(ov["noise_zones"]["low"]["non_finite_count"], 1)

        bin_hi = ov["timestep_profile"]["bins"][16]
        self.assertEqual(bin_hi["count"], 8)
        self.assertEqual(bin_hi["non_finite_count"], 2)
        self.assertAlmostEqual(bin_hi["trend"], -0.5, places=4)
        self.assertIsNotNone(bin_hi["p25"])
        self.assertIsNotNone(bin_hi["p75"])
        self.assertGreater(bin_hi["p75"], bin_hi["p25"])
        self.assertEqual(ov["timestep_profile"]["bins"][0]["non_finite_count"], 1)

    def test_subset_timestep_offset_alignment(self):
        lines = [
            json.dumps({"run_id": "old", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "old/a.png", "timestep": 0.4, "loss": 0.25, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"run_id": "curr", "ts": 2.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "char/a.png", "timestep": 0.6, "loss": 0.30, "dataset": 0, "subset": 0, "width": 1024, "height": 1024, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "reg/b.png", "timestep": 0.5, "loss": 0.22, "dataset": 0, "subset": 1, "width": 1024, "height": 1024, "batch_size": 1, "loss_weight": 0.5}),
            json.dumps({"step": 3, "epoch": 1, "image": "plain/c.png", "timestep": 0.5, "loss": 0.24, "dataset": 0, "subset": 2, "width": 1024, "height": 1024, "batch_size": 1}),
        ]
        manifest = {
            "run_id": "curr",
            "args": {"timestep_sampling": "sigmoid", "sigmoid_scale": 1.0},
            "metadata": {
                "ss_datasets": [
                    {
                        "subsets": [
                            {"image_dir": "10_char", "is_reg": False, "img_count": 5, "num_repeats": 2},
                            {"image_dir": "1_reg", "is_reg": True, "img_count": 5, "num_repeats": 1},
                            {"image_dir": "5_plain", "is_reg": False, "img_count": 5, "num_repeats": 1},
                        ]
                    }
                ]
            },
        }
        run = self._create_run("subset_offset", manifest=manifest, loss_lines=lines)
        # First config subset (empty_skipped) is skipped at runtime, shifting surviving subset indices by +1.
        dataset_toml = "\n".join([
            "[[datasets]]",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/empty_skipped"',
            "num_repeats = 1",
            "[datasets.subsets.custom_attributes.timestep_sampling]",
            "offset = -1.5",
            "",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/10_char"',
            "num_repeats = 2",
            "[datasets.subsets.custom_attributes.timestep_sampling]",
            "offset = 0.85",
            "",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/1_reg"',
            "is_reg = true",
            "num_repeats = 1",
            "[datasets.subsets.custom_attributes.timestep_sampling]",
            "offset = -0.7",
            "",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/5_plain"',
            "num_repeats = 1",
            "",
        ])
        (run / "dataset.toml").write_text(dataset_toml, encoding="utf-8")
        record = run_registry.load_run_record(run)
        curr = dataset_diagnostics.analyze_dataset_diagnostics(record, run_id="curr", min_count=1)
        self.assertEqual([item["key"] for item in curr["by_subset"]], ["0-0", "0-2", "0-1"])
        by_sub = {item["key"]: item for item in curr["by_subset"]}
        self.assertAlmostEqual(by_sub["0-0"]["timestep_offset"], 0.85)
        self.assertAlmostEqual(by_sub["0-1"]["timestep_offset"], -0.7)
        self.assertNotIn("timestep_offset", by_sub["0-2"])

        # Inherit custom_attributes.timestep_sampling.offset from [[datasets]] and [general]
        inherited_toml = "\n".join([
            "[general.custom_attributes.timestep_sampling]",
            "offset = 0.25",
            "",
            "[[datasets]]",
            "[datasets.custom_attributes.timestep_sampling]",
            "offset = 0.45",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/10_char"',
            "num_repeats = 2",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/1_reg"',
            "is_reg = true",
            "num_repeats = 1",
            "[[datasets.subsets]]",
            'image_dir = "D:/ds/5_plain"',
            "num_repeats = 1",
            "[datasets.subsets.custom_attributes.timestep_sampling]",
            "offset = -0.3",
        ])
        (run / "dataset.toml").write_text(inherited_toml, encoding="utf-8")
        dataset_diagnostics.clear_dataset_diagnostics_cache()
        inherited = dataset_diagnostics.analyze_dataset_diagnostics(record, run_id="curr", min_count=1)
        inh_sub = {item["key"]: item for item in inherited["by_subset"]}
        self.assertAlmostEqual(inh_sub["0-0"]["timestep_offset"], 0.45)
        self.assertAlmostEqual(inh_sub["0-1"]["timestep_offset"], 0.45)
        self.assertAlmostEqual(inh_sub["0-2"]["timestep_offset"], -0.3)

        for hist_id in ("old", "all"):
            hist = dataset_diagnostics.analyze_dataset_diagnostics(record, run_id=hist_id, min_count=1)
            for item in hist["by_subset"]:
                self.assertNotIn("timestep_offset", item)

    def test_group_enrichment_anomalies_weights_aug_ar_and_dir_fallback(self):
        # 1. ss_datasets mode: attention/non_finite counts, loss_weight, aug_flags, bucket_ar_error
        lines = [json.dumps({"run_id": "rich", "ts": 1.0})]
        rows = [
            ("sub_a/bad.png", 0, 0, 0.5, 0.90, 512, 512, 1.0),
            ("sub_a/bad.png", 0, 0, 0.5, None, 512, 512, 1.0),
            ("sub_b/ok.png", 0, 1, 0.5, 0.20, 512, 512, 0.5),
            ("sub_b/hard.png", 0, 1, 0.5, 0.60, 768, 512, 0.5),
            ("sub_b/ok2.png", 0, 1, 0.5, 0.20, 768, 512, 0.5),
        ]
        for step, (img, ds, sub, ts, loss, w, h, lw) in enumerate(rows, start=1):
            lines.append(json.dumps({
                "step": step, "epoch": 1, "image": img, "dataset": ds, "subset": sub,
                "timestep": ts, "loss": loss, "width": w, "height": h, "batch_size": 1, "loss_weight": lw,
            }))
        manifest = {
            "run_id": "rich",
            "metadata": {
                "ss_datasets": [
                    {
                        "num_train_images": 10,
                        "bucket_info": {"mean_img_ar_error": 0.062},
                        "subsets": [
                            {"image_dir": "sub_a", "is_reg": False, "img_count": 2, "num_repeats": 3, "flip_aug": True, "shuffle_caption": True},
                            {"image_dir": "sub_b", "is_reg": True, "img_count": 4, "num_repeats": 1, "color_aug": False},
                        ],
                    }
                ]
            },
        }
        run = self._create_run("rich_groups", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)
        res = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1)
        self.assertAlmostEqual(res["summary"]["bucket_ar_error"], 0.062)
        by_sub = {s["key"]: s for s in res["by_subset"]}
        self.assertEqual(by_sub["0-0"]["non_finite_count"], 1)
        self.assertEqual(by_sub["0-0"]["aug_flags"], ["flip_aug", "shuffle_caption"])
        self.assertNotIn("loss_weight", by_sub["0-0"])
        self.assertEqual(by_sub["0-1"]["attention_count"], 1)
        self.assertEqual(by_sub["0-1"]["non_finite_count"], 0)
        self.assertAlmostEqual(by_sub["0-1"]["loss_weight"], 0.5)
        self.assertNotIn("aug_flags", by_sub["0-1"])

        # 2. --train_data_dir fallback mode (no ss_datasets): reads ss_dataset_dirs / ss_reg_dataset_dirs / ss_bucket_info
        dir_lines = [
            json.dumps({"run_id": "dir_run", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "train/10_cat/a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
            json.dumps({"step": 2, "epoch": 1, "image": "reg/1_other/b.png", "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
        ]
        dir_manifest = {
            "run_id": "dir_run",
            "metadata": {
                "ss_dataset_dirs": {"10_cat": {"n_repeats": 10, "img_count": 5}},
                "ss_reg_dataset_dirs": {"1_other": {"n_repeats": 1, "img_count": 8}},
                "ss_bucket_info": {"mean_img_ar_error": 0.045},
            },
        }
        dir_run = self._create_run("dir_fallback", manifest=dir_manifest, loss_lines=dir_lines)
        dir_record = run_registry.load_run_record(dir_run)
        dir_res = dataset_diagnostics.analyze_dataset_diagnostics(dir_record, min_count=1)
        self.assertEqual(dir_res["summary"]["images_expected"], 13)
        self.assertAlmostEqual(dir_res["summary"]["bucket_ar_error"], 0.045)
        dir_subs = {s["label"]: s for s in dir_res["by_subset"]}
        self.assertEqual(dir_subs["10_cat"]["expected_images"], 5)
        self.assertEqual(dir_subs["10_cat"]["num_repeats"], 10)
        self.assertEqual(dir_subs["10_cat"]["is_reg"], False)
        self.assertEqual(dir_subs["1_other"]["expected_images"], 8)
        self.assertEqual(dir_subs["1_other"]["is_reg"], True)

    def test_image_detail_builds_cumulative_trajectory(self):
        lines = [json.dumps({"run_id": "traj", "ts": 1.0})]
        step = 1
        for epoch, target_loss, peer_loss in [
            (1, 0.28, 0.20),
            (2, 0.30, 0.20),
            (3, 0.32, 0.20),
            (4, 0.24, 0.20),
            (5, 0.16, 0.20),
        ]:
            lines.append(json.dumps({
                "step": step, "epoch": epoch, "image": "char/focus.png",
                "dataset": 0, "subset": 0, "timestep": 0.5, "loss": target_loss,
                "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0,
            }))
            step += 1
            for peer_idx in range(3):
                lines.append(json.dumps({
                    "step": step, "epoch": epoch, "image": f"char/peer_{peer_idx}.png",
                    "dataset": 0, "subset": 0, "timestep": 0.5, "loss": peer_loss,
                    "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0,
                }))
                step += 1

        run = self._create_run("traj_run", loss_lines=lines)
        record = run_registry.load_run_record(run)
        overview = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=3)
        focus_img = next(img for img in overview["by_image"] if img["image"] == "char/focus.png")
        detail = dataset_diagnostics.read_dataset_diagnostic_image(
            record, image_id=focus_img["image_id"], min_count=3
        )

        traj = detail.get("trajectory") or []
        self.assertEqual([pt["epoch"] for pt in traj], [3, 4, 5])
        self.assertEqual(traj[0]["status"], "attention")
        self.assertEqual(traj[-1]["status"], focus_img["status"])
        self.assertAlmostEqual(traj[-1]["mean_residual"], focus_img["mean_residual"], places=5)
        self.assertAlmostEqual(traj[-1]["slope"], focus_img["slope"], places=5)
        self.assertLess(traj[-1]["slope"], traj[0]["slope"])

    def test_trajectory_has_no_future_leakage_for_converging_identical_images(self):
        # P0-1: 3 identical images converging 1.0 -> 0.2 synchronously must stay at 0.0 / normal every epoch
        lines = [json.dumps({"run_id": "conv", "ts": 1.0})]
        step = 0
        for ep, loss_val in ((1, 1.0), (2, 0.8), (3, 0.6), (4, 0.4), (5, 0.2)):
            for name in ("a.png", "b.png", "c.png"):
                step += 1
                lines.append(json.dumps({
                    "step": step, "epoch": ep, "image": name,
                    "dataset": 0, "subset": 0, "timestep": 0.5, "loss": loss_val,
                    "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0,
                }))
        run = self._create_run("conv_no_leak", loss_lines=lines)
        record = run_registry.load_run_record(run)
        ov = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=3)
        a_img = next(item for item in ov["by_image"] if item["name"] == "a.png")
        detail = dataset_diagnostics.read_dataset_diagnostic_image(record, image_id=a_img["image_id"], min_count=3)
        traj = detail["trajectory"]
        self.assertEqual([pt["epoch"] for pt in traj], [3, 4, 5])
        for pt in traj:
            self.assertAlmostEqual(pt["mean_residual"], 0.0, places=6)
            self.assertAlmostEqual(pt["slope"], 0.0, places=6)
            self.assertEqual(pt["status"], "normal")

    def test_reg_mode_isolates_baseline_supports_fallback_and_detail_flags(self):
        # P0-2 & Contract #1/#2/#3: exclude low-loss reg images from train baseline, pure-reg fallback, lightweight flags
        lines = [json.dumps({"run_id": "reg_iso", "ts": 1.0})]
        step = 0
        for ep in (1, 2, 3):
            for name in ("train_a.png", "train_b.png"):
                step += 1
                lines.append(json.dumps({
                    "step": step, "epoch": ep, "image": f"train/{name}",
                    "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.50,
                    "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0,
                }))
            for name in ("reg_a.png", "reg_b.png"):
                step += 1
                lines.append(json.dumps({
                    "step": step, "epoch": ep, "image": f"reg/{name}",
                    "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.10,
                    "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5,
                }))
        manifest = {
            "run_id": "reg_iso",
            "metadata": {
                "ss_datasets": [{
                    "subsets": [
                        {"image_dir": "10_train", "is_reg": False, "img_count": 2, "num_repeats": 1},
                        {"image_dir": "1_reg", "is_reg": True, "img_count": 2, "num_repeats": 1},
                    ]
                }]
            },
        }
        run = self._create_run("reg_iso_run", manifest=manifest, loss_lines=lines)
        record = run_registry.load_run_record(run)

        all_res = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1, reg_mode="all")
        excl_res = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1, reg_mode="exclude")
        only_res = dataset_diagnostics.analyze_dataset_diagnostics(record, min_count=1, reg_mode="only")

        self.assertEqual(all_res["reg_mode"], "all")
        self.assertEqual(excl_res["reg_mode"], "exclude")
        self.assertEqual(only_res["reg_mode"], "only")
        for res in (all_res, excl_res, only_res):
            self.assertTrue(res["summary"]["has_reg_images"])
            self.assertEqual(res["summary"]["train_images_total"], 2)
            self.assertEqual(res["summary"]["reg_images_total"], 2)

        # In "all", low-loss reg images pull training image residual above +0.20 (attention); in "exclude", train images are 0.0 (normal)
        all_train = next(img for img in all_res["by_image"] if img["name"] == "train_a.png")
        excl_train = next(img for img in excl_res["by_image"] if img["name"] == "train_a.png")
        self.assertGreater(all_train["mean_residual"], 0.20)
        self.assertAlmostEqual(excl_train["mean_residual"], 0.0, places=6)
        self.assertEqual(excl_train["status"], "normal")
        self.assertEqual(excl_res["summary"]["images_total"], 2)
        self.assertEqual(excl_res["summary"]["images_expected"], 2)
        self.assertEqual(only_res["summary"]["images_total"], 2)
        self.assertEqual({img["is_reg"] for img in only_res["by_image"]}, {True})

        # HTTP detail endpoint with reg_mode & lightweight flags (include_local=false, include_profile=false)
        app = FastAPI()
        app.include_router(monitor_router, prefix="/api")
        with TestClient(app) as client:
            light = client.get(
                "/api/monitor/dataset-diagnostics/image",
                params={
                    "run_dir": record["run_dir"],
                    "image_id": excl_train["image_id"],
                    "min_count": 1,
                    "reg_mode": "exclude",
                    "include_local": "false",
                    "include_profile": "false",
                },
            ).json()["data"]
            self.assertEqual(light["reg_mode"], "exclude")
            self.assertAlmostEqual(light["image"]["mean_residual"], 0.0, places=6)
            self.assertNotIn("caption", light)
            self.assertNotIn("file_info", light)
            self.assertNotIn("by_timestep", light)
            self.assertNotIn("timestep_profile", light)

            # Reg image excluded when reg_mode=exclude -> 404
            reg_id = only_res["by_image"][0]["image_id"]
            self.assertEqual(
                client.get(
                    "/api/monitor/dataset-diagnostics/image",
                    params={"run_dir": record["run_dir"], "image_id": reg_id, "reg_mode": "exclude"},
                ).status_code,
                404,
            )

        # Pure-reg run with reg_mode="exclude" auto-falls back to "all"
        pure_reg_lines = [
            json.dumps({"run_id": "pure_reg", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "reg/only.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.2, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 0.5}),
        ]
        pure_reg_manifest = {"run_id": "pure_reg", "metadata": {"ss_datasets": [{"subsets": [{"image_dir": "1_reg", "is_reg": True, "img_count": 1}]}]}}
        pure_reg_run = self._create_run("pure_reg_run", manifest=pure_reg_manifest, loss_lines=pure_reg_lines)
        pure_res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(pure_reg_run), min_count=1, reg_mode="exclude")
        self.assertEqual(pure_res["reg_mode"], "all")
        self.assertEqual(pure_res["summary"]["images_total"], 1)

    def test_pure_and_mixed_nan_groups_remain_visible_with_consistent_counts(self):
        # P0-3: pure-NaN group and mixed-NaN group remain in by_subset / by_resolution / by_directory
        lines = [
            json.dumps({"run_id": "nan_groups", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "ok/a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "ok/b_nan.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": None, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 3, "epoch": 1, "image": "bad/c_nan.png", "dataset": 0, "subset": 1, "timestep": 0.6, "loss": None, "width": 768, "height": 512, "batch_size": 1}),
            json.dumps({"step": 4, "epoch": 1, "image": "bad/d_nan.png", "dataset": 0, "subset": 1, "timestep": 0.6, "loss": None, "width": 768, "height": 512, "batch_size": 1}),
        ]
        manifest = {
            "run_id": "nan_groups",
            "metadata": {"ss_datasets": [{"subsets": [{"image_dir": "ok_sub", "is_reg": False}, {"image_dir": "bad_sub", "is_reg": False}]}]},
        }
        run = self._create_run("nan_groups_run", manifest=manifest, loss_lines=lines)
        res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(run), min_count=1)
        by_sub = {item["key"]: item for item in res["by_subset"]}
        by_reso = {item["key"]: item for item in res["by_resolution"]}
        self.assertEqual(by_sub["0-0"]["images"], 2)
        self.assertEqual(by_sub["0-0"]["non_finite_count"], 1)
        self.assertEqual(by_sub["0-1"]["images"], 2)
        self.assertEqual(by_sub["0-1"]["non_finite_count"], 2)
        self.assertEqual(by_sub["0-1"]["label"], "bad_sub")
        self.assertEqual(by_reso["768x512"]["images"], 2)
        self.assertEqual(by_reso["768x512"]["non_finite_count"], 2)
        for dim in ("by_subset", "by_resolution", "by_directory"):
            for item in res[dim]:
                self.assertLessEqual(item["non_finite_count"], item["images"])

    def test_deweight_sigma_sqrt_and_cosmap_and_dir_lookup_and_windows_paths(self):
        # P1-4: sigma_sqrt deweighting on Anima including small positive sigma < 1e-4 without clamp distortion
        from backend.monitor.dataset_diagnostic_index import deweight_losses
        import numpy as np

        zero_out = deweight_losses(
            np.asarray([0.25, 0.25], dtype=np.float64),
            np.asarray([0.0, 1e-5], dtype=np.float64),
            "unit",
            "sigma_sqrt",
        )
        self.assertAlmostEqual(float(zero_out[0]), 0.25, places=8)
        self.assertAlmostEqual(float(zero_out[1]), 0.25 * (1e-5 ** 2), places=14)

        sigma_lines = [
            json.dumps({"run_id": "dw", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25 * (0.5 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "b.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25 * (0.5 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 3, "epoch": 1, "image": "a.png", "dataset": 0, "subset": 0, "timestep": 0.09, "loss": 0.25 * (0.09 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 4, "epoch": 1, "image": "b.png", "dataset": 0, "subset": 0, "timestep": 0.09, "loss": 0.25 * (0.09 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 5, "epoch": 1, "image": "c.png", "dataset": 0, "subset": 0, "timestep": 1e-5, "loss": 0.25 * (1e-5 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 6, "epoch": 1, "image": "d.png", "dataset": 0, "subset": 0, "timestep": 5e-5, "loss": 0.25 * (5e-5 ** -2.0), "width": 512, "height": 512, "batch_size": 1}),
        ]
        sigma_run = self._create_run("sigma_dw", profile="anima-lora", manifest={"run_id": "dw", "args": {"weighting_scheme": "sigma_sqrt"}}, loss_lines=sigma_lines)
        sigma_rec = run_registry.load_run_record(sigma_run)
        sigma_res = dataset_diagnostics.analyze_dataset_diagnostics(sigma_rec, min_count=1)
        self.assertTrue(sigma_res["summary"]["loss_deweighted"])
        self.assertAlmostEqual(sigma_res["summary"]["mean_loss"], 0.25, places=4)
        for img in sigma_res["by_image"]:
            self.assertAlmostEqual(img["mean_residual"], 0.0, places=4)

        a_id = next(img["image_id"] for img in sigma_res["by_image"] if img["name"] == "a.png")
        a_detail = dataset_diagnostics.read_dataset_diagnostic_image(sigma_rec, image_id=a_id, min_count=1)
        self.assertTrue(a_detail["loss_deweighted"])
        first_sample = next(s for s in a_detail["samples"] if s["step"] == 1)
        self.assertAlmostEqual(first_sample["loss"], 0.25, places=6)
        self.assertAlmostEqual(first_sample["raw_loss"], 1.0, places=6)
        self.assertAlmostEqual(first_sample["residual"], 0.0, places=6)

        # P1-4: cosmap on MOSS-Image (scale=thousand)
        import math
        sig = 0.5
        w_cos = 2.0 / (math.pi * (1.0 - 2.0 * sig + 2.0 * sig * sig))
        cos_lines = [
            json.dumps({"run_id": "cos", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a.png", "dataset": 0, "subset": 0, "timestep": 500.0, "loss": 0.30 * w_cos, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "b.png", "dataset": 0, "subset": 0, "timestep": 500.0, "loss": 0.30 * w_cos, "width": 512, "height": 512, "batch_size": 1}),
        ]
        cos_run = self._create_run("cos_dw", profile="moss-image-lora", manifest={"run_id": "cos", "args": {"weighting_scheme": "cosmap"}}, loss_lines=cos_lines)
        cos_res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(cos_run), min_count=1)
        self.assertTrue(cos_res["summary"]["loss_deweighted"])
        self.assertAlmostEqual(cos_res["summary"]["mean_loss"], 0.30, places=5)

        # P1-5: _row_is_reg checks dir_lookup even when loss_weight == 1.0; images_expected deduplicates reused dirs
        dir_lines = [
            json.dumps({"run_id": "d1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "train/10_cat/a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
            json.dumps({"step": 2, "epoch": 1, "image": "reg/1_other/b.png", "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.20, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
        ]
        dir_manifest = {
            "run_id": "d1",
            "metadata": {
                "ss_dataset_dirs": {"10_cat": {"n_repeats": 10, "img_count": 5}},
                "ss_reg_dataset_dirs": {"1_other": {"n_repeats": 1, "img_count": 8}},
            },
        }
        dir_run = self._create_run("dir_reg_lw1", manifest=dir_manifest, loss_lines=dir_lines)
        dir_res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(dir_run), min_count=1)
        self.assertTrue(dir_res["summary"]["has_reg_images"])
        by_name = {img["name"]: img for img in dir_res["by_image"]}
        self.assertTrue(by_name["b.png"]["is_reg"])
        self.assertFalse(by_name["a.png"]["is_reg"])

        # Reused directory in ss_datasets deduplicates images_expected & excludes reg in reg_mode="exclude"
        reused_manifest = {
            "run_id": "reused",
            "script": "anima_train_network.py",
            "metadata": {
                "ss_datasets": [
                    {"subsets": [{"image_dir": "10_char", "is_reg": False, "img_count": 6}, {"image_dir": "1_reg", "is_reg": True, "img_count": 6}]},
                    {"subsets": [{"image_dir": "10_char", "is_reg": False, "img_count": 6}]},
                ]
            },
        }
        reused_lines = [
            json.dumps({"run_id": "reused", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": r"d:\ds\10_char\x.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.3, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "D:/ds/10_char/x.png", "dataset": 1, "subset": 0, "timestep": 0.5, "loss": 0.3, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 3, "epoch": 1, "image": "D:/ds/1_reg/r.png", "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.2, "width": 512, "height": 512, "batch_size": 1}),
        ]
        # Also verify _detect_profile fallback via manifest.json["script"] when profile_id/model_train_type are absent
        reused_run = self._create_run("win_dedup", profile="", manifest=reused_manifest, loss_lines=reused_lines)
        (reused_run / "config.toml").write_text('output_name = "win_dedup"\n', encoding="utf-8")
        reused_rec = run_registry.load_run_record(reused_run)
        reused_all = dataset_diagnostics.analyze_dataset_diagnostics(reused_rec, min_count=1, reg_mode="all")
        self.assertEqual(reused_all["profile"], "anima-lora")
        self.assertEqual(reused_all["timestep_scale"], "unit")
        self.assertEqual(reused_all["summary"]["images_total"], 2)  # d:\ds\10_char\x.png & D:/ds/10_char/x.png merged
        self.assertEqual(reused_all["summary"]["images_expected"], 12)  # 6 + 6 (not 18)
        reused_excl = dataset_diagnostics.analyze_dataset_diagnostics(reused_rec, min_count=1, reg_mode="exclude")
        self.assertEqual(reused_excl["summary"]["images_expected"], 6)

    def test_monitor_routes_return_consistent_error_codes(self):
        # P1-6: monitor_outputs, download_outputs, download_single_output, get_config_from_run error codes
        run = self._create_run("err_codes")
        (run / "config.toml").unlink()
        app = FastAPI()
        app.include_router(monitor_router, prefix="/api")
        with TestClient(app) as client:
            r_missing_out = client.get("/api/monitor/outputs", params={"run_dir": "output/missing_run"}).json()
            self.assertEqual(r_missing_out["error_code"], "monitorRunNotFound")

            r_unavail_out = client.get("/api/monitor/outputs", params={"run_dir": "output/err_codes"}).json()
            self.assertEqual(r_unavail_out["error_code"], "monitorArtifactUnavailable")

            r_dl_missing = client.get("/api/monitor/outputs/download", params={"run_dir": "output/missing_run"}).json()
            self.assertEqual(r_dl_missing["error_code"], "monitorRunNotFound")

            r_dl_unavail = client.get("/api/monitor/outputs/download", params={"run_dir": "output/err_codes"}).json()
            self.assertEqual(r_dl_unavail["error_code"], "monitorArtifactUnavailable")

            r_dl_single_empty = client.get("/api/monitor/outputs/download-file").json()
            self.assertEqual(r_dl_single_empty["error_code"], "monitorInvalidDownloadRequest")

            r_dl_single_bad = client.get("/api/monitor/outputs/download-file", params={"run_dir": "output/err_codes", "path": "../secret"}).json()
            self.assertEqual(r_dl_single_bad["error_code"], "monitorInvalidPath")

            r_cfg_missing = client.get("/api/monitor/config-from-run", params={"run_dir": "output/err_codes"}).json()
            self.assertEqual(r_cfg_missing["error_code"], "monitorConfigNotFound")

    def test_no_reg_mode_normalization(self):
        lines = [
            json.dumps({"run_id": "r1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a.png", "dataset": 0, "subset": 0, "timestep": 0.4, "loss": 0.3, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "b.png", "dataset": 0, "subset": 0, "timestep": 0.6, "loss": 0.2, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("noreg_norm", manifest={"run_id": "r1"}, loss_lines=lines)
        rec = run_registry.load_run_record(run)

        ov_only = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="only")
        ov_excl = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="exclude")
        ov_all = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="all")
        self.assertEqual(ov_only["reg_mode"], "all")
        self.assertEqual(ov_excl["reg_mode"], "all")
        self.assertEqual(ov_only["summary"]["images_total"], 2)
        self.assertEqual(ov_only["revision"], ov_all["revision"])
        self.assertEqual(ov_excl["revision"], ov_all["revision"])

        detail = dataset_diagnostics.read_dataset_diagnostic_image(
            rec, image_id=ov_all["by_image"][0]["image_id"], min_count=1, reg_mode="all",
        )
        self.assertEqual(detail["revision"], ov_excl["revision"])

    def test_traditional_dir_mode_same_named_train_and_reg_subdirs(self):
        train_img = self.root / "train_root" / "1_person" / "a.png"
        reg_img = self.root / "reg_root" / "1_person" / "b.png"
        train_img.parent.mkdir(parents=True)
        reg_img.parent.mkdir(parents=True)
        train_img.touch()
        reg_img.touch()
        manifest = {
            "run_id": "trad",
            "args": {
                "train_data_dir": str(self.root / "train_root"),
                "reg_data_dir": str(self.root / "reg_root"),
            },
            "metadata": {
                "ss_dataset_dirs": {"1_person": {"n_repeats": 3, "img_count": 5}},
                "ss_reg_dataset_dirs": {"1_person": {"n_repeats": 1, "img_count": 7}},
            },
        }
        lines = [
            json.dumps({"run_id": "trad", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": str(train_img), "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.4, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
            json.dumps({"step": 2, "epoch": 1, "image": str(reg_img), "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.2, "width": 512, "height": 512, "batch_size": 1, "loss_weight": 1.0}),
        ]
        run = self._create_run("trad_same_dir", manifest=manifest, loss_lines=lines)
        rec = run_registry.load_run_record(run)

        excl = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="exclude")
        self.assertTrue(excl["summary"]["has_reg_images"])
        self.assertEqual(excl["summary"]["train_images_total"], 1)
        self.assertEqual(excl["summary"]["reg_images_total"], 1)
        self.assertEqual(excl["summary"]["images_total"], 1)
        self.assertEqual(excl["by_image"][0]["name"], "a.png")
        self.assertFalse(excl["by_image"][0]["is_reg"])
        self.assertEqual(excl["summary"]["images_expected"], 5)
        self.assertEqual(excl["by_subset"][0]["num_repeats"], 3)

        only = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="only")
        self.assertEqual(only["summary"]["images_total"], 1)
        self.assertEqual(only["by_image"][0]["name"], "b.png")
        self.assertTrue(only["by_image"][0]["is_reg"])
        self.assertEqual(only["summary"]["images_expected"], 7)
        self.assertEqual(only["by_subset"][0]["num_repeats"], 1)

    def test_windows_metadata_json_and_jsonl_caption_lookup(self):
        img_a = self.root / "data" / "sub" / "a.png"
        img_b = self.root / "data" / "sub" / "b.png"
        img_a.parent.mkdir(parents=True)
        Image.new("RGB", (8, 8)).save(img_a)
        Image.new("RGB", (8, 8)).save(img_b)

        meta_json = self.root / "meta.json"
        meta_json.write_text(json.dumps({
            str(img_a).replace("/", "\\"): {"caption": "json_cap_a", "tags": "tag_a"},
        }), encoding="utf-8")
        meta_jsonl = self.root / "meta.jsonl"
        meta_jsonl.write_text(
            json.dumps({"image_path": str(img_b).replace("/", "\\"), "caption": "jsonl_cap_b", "tags": ""}) + "\n",
            encoding="utf-8",
        )
        ds_toml = (
            "[[datasets]]\n"
            "[[datasets.subsets]]\n"
            f'metadata_file = "{meta_json.as_posix()}"\n'
            "[[datasets.subsets]]\n"
            f'metadata_file = "{meta_jsonl.as_posix()}"\n'
        )
        manifest = {
            "run_id": "meta_win",
            "metadata": {
                "ss_datasets": [{
                    "subsets": [
                        {"metadata_file": "meta.json", "is_reg": False, "img_count": 1},
                        {"metadata_file": "meta.jsonl", "is_reg": False, "img_count": 1},
                    ]
                }]
            },
        }
        lines = [
            json.dumps({"run_id": "meta_win", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": str(img_a).replace("/", "\\"), "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": str(img_b).replace("/", "\\"), "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("win_meta", manifest=manifest, loss_lines=lines)
        (run / "dataset.toml").write_text(ds_toml, encoding="utf-8")
        rec = run_registry.load_run_record(run)

        ov = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1)
        by_name = {img["name"]: img["image_id"] for img in ov["by_image"]}
        det_a = dataset_diagnostics.read_dataset_diagnostic_image(rec, image_id=by_name["a.png"], min_count=1)
        det_b = dataset_diagnostics.read_dataset_diagnostic_image(rec, image_id=by_name["b.png"], min_count=1)
        self.assertTrue(det_a["caption"]["exists"])
        self.assertEqual(det_a["caption"]["text"], "json_cap_a,tag_a")
        self.assertTrue(det_b["caption"]["exists"])
        self.assertEqual(det_b["caption"]["text"], "jsonl_cap_b")

    def test_bucket_ar_error_unique_img_count_and_flux_shift_resolution_offsets(self):
        manifest = {
            "run_id": "ar_flux",
            "args": {"timestep_sampling": "flux_shift"},
            "metadata": {
                "ss_datasets": [
                    {
                        "num_train_images": 200,
                        "bucket_info": {"mean_img_ar_error": 0.15},
                        "subsets": [{"image_dir": "s0", "is_reg": False, "img_count": 10, "num_repeats": 20, "custom_attributes": {"timestep_sampling": {"offset": -1.5}}}],
                    },
                    {
                        "num_train_images": 100,
                        "bucket_info": {"mean_img_ar_error": 0.01},
                        "subsets": [{"image_dir": "s1", "is_reg": False, "img_count": 100, "num_repeats": 1, "custom_attributes": {"timestep_sampling": {"offset": 1.5}}}],
                    },
                ]
            },
        }
        lines = [
            json.dumps({"run_id": "ar_flux", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "s0/a.png", "dataset": 0, "subset": 0, "timestep": 0.4, "loss": 0.3, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "s1/b.png", "dataset": 1, "subset": 0, "timestep": 0.6, "loss": 0.2, "width": 1536, "height": 1536, "batch_size": 1}),
        ]
        run = self._create_run("ar_flux_run", manifest=manifest, loss_lines=lines)
        res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(run), min_count=1)
        expected_ar = (10 * 0.15 + 100 * 0.01) / 110.0
        self.assertAlmostEqual(res["summary"]["bucket_ar_error"], expected_ar, places=6)
        self.assertEqual(
            res["timestep_profile"]["resolution_offsets"],
            [
                {"resolution": "512,512", "offset": -1.5, "count": 1},
                {"resolution": "1536,1536", "offset": 1.5, "count": 1},
            ],
        )

    def test_online_trajectory_slope_matches_ols_across_skipped_epochs(self):
        import numpy as np

        ep_nums = np.asarray([1, 3, 7, 10], dtype=np.int64)
        peer_comp = np.asarray([2, 2, 2, 2], dtype=np.int64)
        peer_res = np.asarray([0.8, 0.2, -0.4, -0.8], dtype=np.float64)
        totals = [
            peer_comp,
            np.zeros_like(peer_res),
            peer_comp,
            peer_res,
            peer_comp,
            peer_res,
        ]
        cum_by_ep = {1: (2, 2, 0.8), 3: (4, 4, 1.0), 7: (6, 6, 0.6), 10: (8, 8, -0.2)}
        traj = dataset_diagnostics._build_image_trajectory([], ep_nums, totals, 1, cum_by_ep)
        self.assertEqual([pt["epoch"] for pt in traj], [7, 10])
        xs = np.asarray([1.0, 3.0, 7.0, 10.0])
        ys = peer_res / peer_comp
        expected_slope = float(np.polyfit(xs, ys, 1)[0])
        self.assertAlmostEqual(traj[-1]["slope"], round(expected_slope, 6), places=6)

    def test_same_image_dual_train_and_reg_roles_filter_independently(self):
        manifest = {
            "run_id": "dual",
            "metadata": {
                "ss_datasets": [
                    {"subsets": [{"image_dir": "1_train", "is_reg": False, "img_count": 1}]},
                    {"subsets": [{"image_dir": "1_reg", "is_reg": True, "img_count": 1}]},
                ]
            },
        }
        lines = [
            json.dumps({"run_id": "dual", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "shared/a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 1.0, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "shared/a.png", "dataset": 1, "subset": 0, "timestep": 0.5, "loss": 10.0, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("dual_role", manifest=manifest, loss_lines=lines)
        rec = run_registry.load_run_record(run)

        all_res = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="all")
        excl_res = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="exclude")
        only_res = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="only")

        self.assertTrue(all_res["summary"]["has_reg_images"])
        self.assertEqual(all_res["reg_mode"], "all")
        self.assertEqual(all_res["summary"]["samples"], 2)
        self.assertAlmostEqual(all_res["summary"]["mean_loss"], 5.5, places=6)

        self.assertEqual(excl_res["reg_mode"], "exclude")
        self.assertEqual(excl_res["summary"]["samples"], 1)
        self.assertAlmostEqual(excl_res["summary"]["mean_loss"], 1.0, places=6)

        self.assertEqual(only_res["reg_mode"], "only")
        self.assertEqual(only_res["summary"]["samples"], 1)
        self.assertAlmostEqual(only_res["summary"]["mean_loss"], 10.0, places=6)

    def test_group_noise_zones_match_10_bin_analysis_residual(self):
        # 18-bin plotting buckets put t=400 (bin 7) and t=445 (bin 8) in separate bins,
        # while 10-bin analysis puts both in [400, 500) so the 512x512 group is comparable (+50%).
        lines = [
            json.dumps({"run_id": "gz", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "a_512.png", "dataset": 0, "subset": 0, "timestep": 0.400, "loss": 0.30, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": "b_1024.png", "dataset": 0, "subset": 1, "timestep": 0.445, "loss": 0.20, "width": 1024, "height": 1024, "batch_size": 1}),
            json.dumps({"step": 3, "epoch": 1, "image": "c_1024.png", "dataset": 0, "subset": 1, "timestep": 0.900, "loss": 0.20, "width": 1024, "height": 1024, "batch_size": 1}),
        ]
        run = self._create_run("group_zones", loss_lines=lines)
        res = dataset_diagnostics.analyze_dataset_diagnostics(run_registry.load_run_record(run), min_count=1, num_bins=10)
        nz_512 = res["timestep_profile"]["by_group"]["resolution"]["512x512"]["noise_zones"]["mid"]
        self.assertEqual(nz_512["count"], 1)
        self.assertEqual(nz_512["comparable_count"], 1)
        self.assertAlmostEqual(nz_512["mean_residual"], 0.20, places=4)
        by_reso = {item["key"]: item for item in res["by_resolution"]}
        self.assertAlmostEqual(nz_512["mean_residual"], by_reso["512x512"]["mean_residual"], places=6)

    def test_windows_jsonl_last_write_wins_with_mixed_case_aliases(self):
        img = self.root / "data" / "sub" / "A.png"
        img.parent.mkdir(parents=True)
        Image.new("RGB", (8, 8)).save(img)

        raw_upper = str(img).replace("/", "\\")
        raw_lower = str(img.parent / "a.png").replace("/", "\\")
        meta_jsonl = self.root / "meta.jsonl"
        meta_jsonl.write_text(
            "\n".join([
                json.dumps({"image_path": raw_upper, "caption": "v1_old", "tags": ""}),
                json.dumps({"image_path": raw_lower, "caption": "v2_mid", "tags": ""}),
                json.dumps({"image_path": raw_upper, "caption": "v3_latest", "tags": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        ds_toml = f'[[datasets]]\n[[datasets.subsets]]\nmetadata_file = "{meta_jsonl.as_posix()}"\n'
        manifest = {
            "run_id": "jsonl_lww",
            "metadata": {"ss_datasets": [{"subsets": [{"metadata_file": "meta.jsonl", "is_reg": False, "img_count": 1}]}]},
        }
        lines = [
            json.dumps({"run_id": "jsonl_lww", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": raw_upper, "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("jsonl_lww_run", manifest=manifest, loss_lines=lines)
        (run / "dataset.toml").write_text(ds_toml, encoding="utf-8")
        rec = run_registry.load_run_record(run)

        ov = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1)
        det = dataset_diagnostics.read_dataset_diagnostic_image(rec, image_id=ov["by_image"][0]["image_id"], min_count=1)
        self.assertTrue(det["caption"]["exists"])
        self.assertEqual(det["caption"]["text"], "v3_latest")

    def test_skip_image_resolution_finetuning_bucket_ar_error_weighting(self):
        manifest = {
            "run_id": "skip_res",
            "metadata": {
                "ss_datasets": [
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": True,
                        "num_train_images": 100,
                        "bucket_info": {"mean_img_ar_error": 0.2, "buckets": {"0": {"count": 1}}},
                        "subsets": [{"metadata_file": "a.json", "is_reg": False, "img_count": 100, "num_repeats": 1}],
                    },
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": False,
                        "num_train_images": 1,
                        "bucket_info": {"mean_img_ar_error": 0.0, "buckets": {"0": {"count": 1}}},
                        "subsets": [{"metadata_file": "b.json", "is_reg": False, "img_count": 1, "num_repeats": 1}],
                    },
                ]
            },
        }
        self.assertAlmostEqual(dataset_diagnostics._extract_bucket_ar_error(manifest), 0.1, places=6)

        # Mixed repeats + skip_image_resolution filtering makes unique image weight indeterminate -> None for multi-dataset, exact for single dataset
        mixed_filtered = {
            "run_id": "skip_mixed",
            "metadata": {
                "ss_datasets": [
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": True,
                        "num_train_images": 110,
                        "bucket_info": {"mean_img_ar_error": 0.2, "buckets": {"0": {"count": 11}}},
                        "subsets": [
                            {"metadata_file": "a1.json", "is_reg": False, "img_count": 100, "num_repeats": 1},
                            {"metadata_file": "a2.json", "is_reg": False, "img_count": 1, "num_repeats": 10},
                        ],
                    },
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": False,
                        "num_train_images": 5,
                        "bucket_info": {"mean_img_ar_error": 0.0, "buckets": {"0": {"count": 5}}},
                        "subsets": [{"metadata_file": "b.json", "is_reg": False, "img_count": 5, "num_repeats": 1}],
                    },
                ]
            },
        }
        self.assertIsNone(dataset_diagnostics._extract_bucket_ar_error(mixed_filtered))
        single_mixed = {"metadata": {"ss_datasets": [mixed_filtered["metadata"]["ss_datasets"][0]]}}
        self.assertAlmostEqual(dataset_diagnostics._extract_bucket_ar_error(single_mixed), 0.2, places=6)

    def test_external_dataset_config_edit_invalidates_metadata_revision(self):
        ext_json = self.root / "external_dataset.json"
        ext_json.write_text(json.dumps({
            "datasets": [{
                "subsets": [
                    {"image_dir": str(self.root / "sub0"), "is_reg": False},
                    {"image_dir": str(self.root / "sub1"), "is_reg": True},
                ]
            }]
        }), encoding="utf-8")
        lines = [
            json.dumps({"run_id": "ext1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": str(self.root / "sub0" / "a.png"), "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 1.0, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": str(self.root / "sub1" / "b.png"), "dataset": 0, "subset": 1, "timestep": 0.5, "loss": 2.0, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("ext_cfg_run", loss_lines=lines)
        (run / "config.toml").write_text(f'dataset_config = "{ext_json.as_posix()}"\n', encoding="utf-8")
        rec = run_registry.load_run_record(run)

        res1 = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="only")
        self.assertAlmostEqual(res1["summary"]["mean_loss"], 2.0, places=6)

        # Swap is_reg in the external JSON file (ensuring size or mtime changes)
        ext_json.write_text(json.dumps({
            "datasets": [{
                "subsets": [
                    {"image_dir": str(self.root / "sub0"), "is_reg": True},
                    {"image_dir": str(self.root / "sub1"), "is_reg": False},
                ]
            }]
        }, indent=2), encoding="utf-8")
        res2 = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1, reg_mode="only", refresh_local=True)
        self.assertNotEqual(res2["revision"], res1["revision"])
        self.assertAlmostEqual(res2["summary"]["mean_loss"], 1.0, places=6)

    def test_finetuning_duplicate_image_keys_bucket_ar_error_without_skip_res(self):
        manifest = {
            "run_id": "dup_ft",
            "metadata": {
                "ss_datasets": [
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": False,
                        "num_train_images": 200,
                        "bucket_info": {"mean_img_ar_error": 0.1, "buckets": {"0": {"count": 100}}},
                        "subsets": [
                            {"metadata_file": "a.json", "is_reg": False, "img_count": 100, "num_repeats": 1},
                            {"metadata_file": "b.json", "is_reg": False, "img_count": 100, "num_repeats": 1},
                        ],
                    },
                    {
                        "is_dreambooth": False,
                        "skip_image_resolution": False,
                        "num_train_images": 100,
                        "bucket_info": {"mean_img_ar_error": 0.0, "buckets": {"0": {"count": 100}}},
                        "subsets": [{"metadata_file": "c.json", "is_reg": False, "img_count": 100, "num_repeats": 1}],
                    },
                ]
            },
        }
        self.assertAlmostEqual(dataset_diagnostics._extract_bucket_ar_error(manifest), 0.05, places=6)

    def test_older_run_detail_does_not_leak_latest_run_caption(self):
        img = self.root / "shared" / "sample.png"
        img.parent.mkdir(parents=True)
        Image.new("RGB", (8, 8)).save(img)
        img.with_suffix(".txt").write_text("latest_run_caption", encoding="utf-8")

        manifest = {
            "run_id": "r2",
            "metadata": {"ss_datasets": [{"subsets": [{"image_dir": str(img.parent), "is_reg": False, "img_count": 1}]}]},
        }
        lines = [
            json.dumps({"run_id": "r1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": str(img), "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.3, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"run_id": "r2", "ts": 2.0}),
            json.dumps({"step": 1, "epoch": 1, "image": str(img), "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.2, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("two_runs_cap", manifest=manifest, loss_lines=lines)
        (run / "config.toml").write_text('caption_extension = ".txt"\n', encoding="utf-8")
        rec = run_registry.load_run_record(run)

        ov1 = dataset_diagnostics.analyze_dataset_diagnostics(rec, run_id="r1", min_count=1)
        det1 = dataset_diagnostics.read_dataset_diagnostic_image(
            rec, image_id=ov1["by_image"][0]["image_id"], run_id="r1", min_count=1,
        )
        self.assertFalse(det1["caption"]["exists"])
        self.assertEqual(det1["caption"]["source"], "unknown")

        det2 = dataset_diagnostics.read_dataset_diagnostic_image(
            rec, image_id=ov1["by_image"][0]["image_id"], run_id="r2", min_count=1,
        )
        self.assertTrue(det2["caption"]["exists"])
        self.assertEqual(det2["caption"]["text"], "latest_run_caption")

    def test_imported_run_relative_dataset_config_uses_manifest_cwd(self):
        ext_cwd = self.root / "imported_workdir"
        ext_cwd.mkdir(parents=True)
        (ext_cwd / "ds_rel.toml").write_text(
            '[[datasets]]\n'
            '[[datasets.subsets]]\n'
            'image_dir = "train/1_sub"\n'
            'is_reg = false\n'
            '[datasets.subsets.custom_attributes.timestep_sampling]\n'
            'offset = 1.25\n',
            encoding="utf-8",
        )
        manifest = {
            "run_id": "imp1",
            "cwd": str(ext_cwd),
            "args": {"timestep_sampling": "flux_shift"},
            "metadata": {
                "ss_datasets": [{
                    "subsets": [{"image_dir": "1_sub", "is_reg": False, "img_count": 1}]
                }]
            },
        }
        lines = [
            json.dumps({"run_id": "imp1", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": "train/1_sub/a.png", "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
        ]
        run = self._create_run("imp_cwd_run", manifest=manifest, loss_lines=lines)
        (run / "config.toml").write_text('dataset_config = "ds_rel.toml"\n', encoding="utf-8")
        rec = run_registry.load_run_record(run)

        ov = dataset_diagnostics.analyze_dataset_diagnostics(rec, min_count=1)
        self.assertAlmostEqual(ov["by_subset"][0]["timestep_offset"], 1.25, places=6)
        self.assertEqual(ov["timestep_profile"]["resolution_offsets"], [{"resolution": "512,512", "offset": 1.25, "count": 1}])

    def test_metadata_source_key_resolves_relative_path_with_manifest_cwd(self):
        ext_cwd = self.root / "ext_cwd_meta"
        other_dir = self.root / "other_dir_meta"
        ext_cwd.mkdir(parents=True)
        other_dir.mkdir(parents=True)
        img_key = "C:/imgs/shared.png"
        meta_ext = ext_cwd / "meta.json"
        meta_ext.write_text(json.dumps({img_key: {"caption": "from_ext_cwd", "tags": ""}}), encoding="utf-8")
        meta_other = other_dir / "meta.json"
        meta_other.write_text(json.dumps({img_key: {"caption": "from_other_dir", "tags": ""}}), encoding="utf-8")

        manifest = {
            "run_id": "src_key",
            "cwd": str(ext_cwd),
            "metadata": {
                "ss_datasets": [
                    {"subsets": [{"metadata_file": "meta.json", "is_reg": False, "img_count": 1}]},
                    {"subsets": [{"metadata_file": "meta.json", "is_reg": False, "img_count": 1}]},
                ]
            },
        }
        lines = [
            json.dumps({"run_id": "src_key", "ts": 1.0}),
            json.dumps({"step": 1, "epoch": 1, "image": img_key, "dataset": 0, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
            json.dumps({"step": 2, "epoch": 1, "image": img_key, "dataset": 1, "subset": 0, "timestep": 0.5, "loss": 0.25, "width": 512, "height": 512, "batch_size": 1}),
        ]
        # Case 1: relative path + absolute path pointing to the same file -> NOT ambiguous, reads caption
        run_same = self._create_run("src_key_same", manifest=manifest, loss_lines=lines)
        (run_same / "config.toml").write_text('dataset_config = "ds.toml"\n', encoding="utf-8")
        (ext_cwd / "ds.toml").write_text(
            '[[datasets]]\n[[datasets.subsets]]\nmetadata_file = "meta.json"\n'
            f'[[datasets]]\n[[datasets.subsets]]\nmetadata_file = "{meta_ext.as_posix()}"\n',
            encoding="utf-8",
        )
        rec_same = run_registry.load_run_record(run_same)
        ov_same = dataset_diagnostics.analyze_dataset_diagnostics(rec_same, min_count=1)
        det_same = dataset_diagnostics.read_dataset_diagnostic_image(
            rec_same, image_id=ov_same["by_image"][0]["image_id"], min_count=1,
        )
        self.assertTrue(det_same["caption"]["exists"])
        self.assertEqual(det_same["caption"]["text"], "from_ext_cwd")

        # Case 2: same basename in two distinct directories -> reported as ambiguous
        run_diff = self._create_run("src_key_diff", manifest=manifest, loss_lines=lines)
        (run_diff / "config.toml").write_text('dataset_config = "ds_diff.toml"\n', encoding="utf-8")
        (ext_cwd / "ds_diff.toml").write_text(
            '[[datasets]]\n[[datasets.subsets]]\nmetadata_file = "meta.json"\n'
            f'[[datasets]]\n[[datasets.subsets]]\nmetadata_file = "{meta_other.as_posix()}"\n',
            encoding="utf-8",
        )
        rec_diff = run_registry.load_run_record(run_diff)
        ov_diff = dataset_diagnostics.analyze_dataset_diagnostics(rec_diff, min_count=1)
        det_diff = dataset_diagnostics.read_dataset_diagnostic_image(
            rec_diff, image_id=ov_diff["by_image"][0]["image_id"], min_count=1,
        )
        self.assertFalse(det_diff["caption"]["exists"])
        self.assertEqual(det_diff["caption"]["source"], "ambiguous")
