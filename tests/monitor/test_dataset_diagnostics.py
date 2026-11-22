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

    def test_residual_and_slope_match_upstream_analyzer_and_track_nonfinite(self):
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
            self.assertAlmostEqual(by_name[fname]["slope"], up_by_name[fname]["slope"], places=6)

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
