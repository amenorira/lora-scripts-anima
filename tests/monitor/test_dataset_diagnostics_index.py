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
            diagnostics, "_scan_local_image_dir", wraps=diagnostics._scan_local_image_dir,
        ) as scan_dir, patch.object(
            diagnostics, "_resolve_local_image_with_stat", wraps=diagnostics._resolve_local_image_with_stat,
        ) as stat_single:
            first = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
            self.assertEqual(processed, [len(initial)])
            self.assertEqual(scan_dir.call_count, 0)
            self.assertEqual(stat_single.call_count, 2)
            same = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3, known_revision=first["revision"])
            self.assertEqual(same, {"revision": first["revision"], "unchanged": True})
            self.assertEqual(processed, [len(initial)])
            self.assertEqual(scan_dir.call_count, 0)
            self.assertEqual(stat_single.call_count, 2)

            processed.clear()
            self.add(self.sample(a, .5, .4, 5, 41), self.sample(c, .5, .3, 5, 42))
            updated = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3)
            self.assertEqual(processed, [2])
            self.assertEqual(scan_dir.call_count, 0)
            self.assertEqual(stat_single.call_count, 3)
            self.assertNotEqual(first["revision"], updated["revision"])

            processed.clear()
            detail = diagnostics.read_dataset_diagnostic_image(
                self.record, num_bins=3, image_id=next(image["image_id"] for image in updated["by_image"] if image["name"] == "c.png"),
            )
            self.assertEqual(processed, [1])
            self.assertEqual(scan_dir.call_count, 0)
            self.assertEqual(stat_single.call_count, 3)
            self.assertEqual(detail["revision"], updated["revision"])
            self.assertEqual(detail["by_timestep"], updated["by_timestep"])

            c.touch()
            checked = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3, refresh_local=True)
            self.assertEqual(scan_dir.call_count, 0)
            self.assertEqual(stat_single.call_count, 6)
            self.assertNotEqual(checked["revision"], updated["revision"])
            c_img = next(image for image in checked["by_image"] if image["name"] == "c.png")
            self.assertTrue(bool(c_img["thumb_url"]))
            self.assertNotIn("local_available", c_img)
            self.assertNotIn("comparable_epochs", c_img)
            self.assertNotIn("first_epoch_residual", c_img)
            self.assertNotIn("last_epoch_residual", c_img)

            # Detail refresh_local=True also bumps local_generation so overview revision/urls stay fresh
            c.write_bytes(b"updated-image-bytes")
            detail_refreshed = diagnostics.read_dataset_diagnostic_image(
                self.record, num_bins=3, image_id=c_img["image_id"], refresh_local=True,
            )
            self.assertEqual(stat_single.call_count, 7)
            self.assertNotEqual(detail_refreshed["revision"], checked["revision"])
            self.assertNotEqual(detail_refreshed["image"]["thumb_url"], c_img["thumb_url"])

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

    def test_slope_distinguishes_a_constant_gap_from_catching_up(self):
        for segment, peer_losses, expected_series, status in (
            ("fixed", (2, 1.5, 1), [1, 1, 1], "attention"),
            ("closing", (1, 1.5, 2), [3, 1, 0], "learning"),
        ):
            with self.subTest(segment=segment):
                self.add({"run_id": segment})
                for epoch, (a, b) in enumerate(zip((4, 3, 2), peer_losses), start=1):
                    self.add(self.sample("a.png", .5, a, epoch), self.sample("b.png", .5, b, epoch))
                image_id = diagnostics._image_id_for_key("a.png")
                detail = diagnostics.read_dataset_diagnostic_image(self.record, image_id=image_id)
                overview = diagnostics.analyze_dataset_diagnostics(self.record)
                image = overview["by_image"][0]
                self.assertEqual(image, detail["image"])
                self.assertEqual(image["image_id"], image_id)
                self.assertAlmostEqual(image["mean_residual"], 1 / 3)
                self.assertEqual([row["mean_residual"] for row in detail["epoch_series"]], expected_series)
                self.assertEqual(sum(1 for row in detail["epoch_series"] if row["mean_residual"] is not None), 3)
                self.assertAlmostEqual(image["slope"], (expected_series[-1] - expected_series[0]) / 2)
                self.assertEqual(image["status"], status)

    def test_missing_epoch_peers_keep_high_residual_in_review_until_peer_arrives(self):
        for epoch in (1, 2, 3):
            self.add(self.sample("a.png", .5, 4, epoch))
        for epoch in (1, 2):
            self.add(self.sample("b.png", .5, 1, epoch))
        self.add(self.sample("a.png", .5, 4, 3), self.sample("b.png", .9, 1, 3),
                 self.sample("b.png", .5, 0, 3))

        image = diagnostics.analyze_dataset_diagnostics(self.record)["by_image"][0]
        self.assertEqual((image["epochs"], image["status"]), (3, "attention"))
        self.assertIsNone(image["slope"])
        detail = diagnostics.read_dataset_diagnostic_image(self.record, image_id=image["image_id"])
        self.assertEqual(sum(1 for row in detail["epoch_series"] if row["mean_residual"] is not None), 2)
        self.assertIsNone(detail["epoch_series"][-1]["mean_residual"])
        self.assertEqual(detail["epoch_series"][-1]["comparable_count"], 0)

        self.add(self.sample("b.png", .5, 4, 3))
        updated = diagnostics.analyze_dataset_diagnostics(self.record)["by_image"][0]
        updated_detail = diagnostics.read_dataset_diagnostic_image(self.record, image_id=updated["image_id"])
        self.assertEqual(updated["status"], "learning")
        self.assertEqual(sum(1 for row in updated_detail["epoch_series"] if row["mean_residual"] is not None), 3)
        self.assertAlmostEqual(updated_detail["epoch_series"][-1]["mean_residual"], 1)
        self.assertAlmostEqual(updated["slope"], -1)

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

    def test_group_slopes_compute_across_epochs_and_require_three_epochs(self):
        # Two resolutions across 2 epochs -> group slope must remain None
        for ep in (1, 2):
            self.add(
                {"image": "a.png", "timestep": 0.5, "loss": 0.4, "step": ep, "epoch": ep, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1},
                {"image": "b.png", "timestep": 0.5, "loss": 0.2, "step": ep, "epoch": ep, "dataset": 0, "subset": 1, "width": 768, "height": 512, "batch_size": 1},
            )
        early = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        for item in early["by_resolution"]:
            self.assertIsNone(item["slope"])

        # Add epoch 3 with shrinking loss on 512x512; group_slopes uses same-epoch all-sample mean (including self)
        diagnostics.clear_dataset_diagnostics_cache()
        self.add({"run_id": "slope3"}, mode="w")
        # Ep 1: 512=0.6 vs 768=0.2 (mean=0.4 -> +0.5/-0.5); Ep 2: 512=0.4 vs 768=0.2 (mean=0.3 -> +1/3/-1/3); Ep 3: 0.2 vs 0.2 (0.0/0.0)
        for ep, l_a, l_b in ((1, 0.6, 0.2), (2, 0.4, 0.2), (3, 0.2, 0.2)):
            self.add(
                {"image": "a.png", "timestep": 0.5, "loss": l_a, "step": ep, "epoch": ep, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1},
                {"image": "b.png", "timestep": 0.5, "loss": l_b, "step": ep, "epoch": ep, "dataset": 0, "subset": 1, "width": 768, "height": 512, "batch_size": 1},
            )
        res = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        by_reso = {r["key"]: r for r in res["by_resolution"]}
        self.assertAlmostEqual(by_reso["512x512"]["slope"], -0.25)
        self.assertAlmostEqual(by_reso["768x512"]["slope"], 0.25)
        by_sub = {s["key"]: s for s in res["by_subset"]}
        self.assertAlmostEqual(by_sub["0-0"]["slope"], -0.25)

        # Unbalanced 9:1 groups: majority group slope stays bounded near its mean_residual scale instead of exploding
        diagnostics.clear_dataset_diagnostics_cache()
        self.add({"run_id": "unbalanced"}, mode="w")
        for ep, l_main, l_small in ((1, 0.6, 0.2), (2, 0.4, 0.2), (3, 0.2, 0.2)):
            for i in range(9):
                self.add({"image": f"m{i}.png", "timestep": 0.5, "loss": l_main, "step": ep * 10 + i, "epoch": ep, "dataset": 0, "subset": 0, "width": 512, "height": 512, "batch_size": 1})
            self.add({"image": "s0.png", "timestep": 0.5, "loss": l_small, "step": ep * 10 + 9, "epoch": ep, "dataset": 0, "subset": 1, "width": 768, "height": 512, "batch_size": 1})
        unbal = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        unbal_reso = {r["key"]: r for r in unbal["by_resolution"]}
        self.assertGreater(unbal_reso["512x512"]["slope"], -0.1)
        self.assertLess(unbal_reso["512x512"]["slope"], 0.0)

    def test_partial_trailing_epoch_with_single_peer_does_not_hijack_slope(self):
        diagnostics.clear_dataset_diagnostics_cache()
        self.add({"run_id": "partial_ep"}, mode="w")
        step = 0
        # 3 complete epochs with 4 images at constant parity (slope == 0)
        for ep in (1, 2, 3):
            for name in ("a.png", "b.png", "c.png", "d.png"):
                step += 1
                self.add(self.sample(name, 0.5, 0.2, ep, step))
        # Incomplete 4th epoch: only 1 peer (b.png) with huge outlier loss before training stopped
        self.add(self.sample("a.png", 0.5, 0.2, 4, step + 1), self.sample("b.png", 0.5, 0.02, 4, step + 2))
        res = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        a_item = next(img for img in res["by_image"] if img["name"] == "a.png")
        self.assertAlmostEqual(a_item["slope"], 0.0)

    def test_refresh_local_bounds_stat_cache_to_single_generation_and_reuses_summary_lru(self):
        imgs = []
        for idx in range(5):
            p = self.root / f"img_{idx}.png"
            p.write_bytes(f"img-{idx}".encode())
            imgs.append(p)
            self.add(self.sample(p, 0.5, 0.2 + idx * 0.01, epoch=1, step=idx + 1))

        with patch.object(diagnostics, "_render_overview", wraps=diagnostics._render_overview) as render_spy:
            first = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
            self.assertEqual(render_spy.call_count, 1)
            prev_rev = first["revision"]
            for _ in range(50):
                cur = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1, refresh_local=True)
                self.assertNotEqual(cur["revision"], prev_rev)
                prev_rev = cur["revision"]
            # refresh_local=True must reuse summary_lru when log/config data did not change
            self.assertEqual(render_spy.call_count, 1)

        self.assertEqual(len(diagnostics._local_stat_cache), 1)
        bucket_epoch, bucket_items = next(iter(diagnostics._local_stat_cache.values()))
        self.assertEqual(len(bucket_items), 5)
        for resolved_str, _ in bucket_items.values():
            self.assertIsInstance(resolved_str, str)

        # Stale concurrent write from an older generation must not overwrite newer bucket
        stale_epoch = (bucket_epoch[0], bucket_epoch[1] - 1)
        diagnostics._store_local_stat_entries(str(self.path), stale_epoch, {"stale.png": ("stale", "1-1")})
        self.assertNotIn("stale.png", diagnostics._local_stat_cache[str(self.path)][1])

        # Modifying a local file + refresh_local updates version param in thumb_url
        imgs[0].write_bytes(b"updated-longer-payload")
        refreshed = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1, refresh_local=True)
        old_url = next(i["thumb_url"] for i in first["by_image"] if i["name"] == "img_0.png")
        new_url = next(i["thumb_url"] for i in refreshed["by_image"] if i["name"] == "img_0.png")
        self.assertNotEqual(old_url, new_url)

        # Evicting the run from _file_cache also drops its _local_stat_cache bucket
        other_run = self.output / "other-stat-evict"
        other_ctrl = other_run / "log" / ".run-control"
        other_ctrl.mkdir(parents=True)
        (other_ctrl / "loss.jsonl").write_text(
            json.dumps({"run_id": "r2"}) + "\n" + json.dumps(self.sample("other.png", 0.5, 0.2)) + "\n",
            encoding="utf-8",
        )
        other_rec = {**self.record, "run_dir": "output/other-stat-evict", "run_path": other_run}
        with patch.object(diagnostics, "_MAX_CACHED_FILES", 1):
            diagnostics.analyze_dataset_diagnostics(other_rec, min_count=1)
        self.assertNotIn(str(self.path), diagnostics._local_stat_cache)

    def test_batch_scandir_matches_single_stat_including_symlinks_and_missing(self):
        import os

        folder = self.root / "batch_dir"
        folder.mkdir()
        img1 = folder / "one.png"
        img2 = folder / "two.JPG"
        strasse = folder / "Straße.png"
        img1.write_bytes(b"pngdata")
        img2.write_bytes(b"jpgdata-longer")
        strasse.write_bytes(b"strasse-data")
        missing = folder / "missing.png"
        bad_ext = folder / "notes.txt"
        bad_ext.write_text("not-image", encoding="utf-8")
        dir_as_png = folder / "subdir.png"
        dir_as_png.mkdir()
        sym_valid = folder / "link_ok.png"
        sym_bad_target = folder / "link_txt.png"
        has_symlinks = False
        try:
            os.symlink(img1, sym_valid)
            os.symlink(bad_ext, sym_bad_target)
            has_symlinks = True
        except OSError:
            pass

        keys = [
            str(img1),
            str(img2),
            str(strasse),
            str(folder / "Strasse.png"),
            str(missing),
            str(bad_ext),
            str(dir_as_png),
        ]
        for idx in range(diagnostics._BATCH_SCANDIR_MIN_FILES):
            pad = folder / f"pad_{idx}.png"
            if idx % 2 == 0:
                pad.write_bytes(f"pad-{idx}".encode())
            keys.append(str(pad))
        if os.name == "nt":
            keys.append(str(folder / "ONE.PNG"))
        if has_symlinks:
            keys.extend([str(sym_valid), str(sym_bad_target)])

        expected = {
            k: ((str(r), v) if r is not None else (None, ""))
            for k, (r, v) in ((k, diagnostics._resolve_local_image_with_stat(k)) for k in keys)
        }
        with patch.object(diagnostics, "_scan_local_image_dir", wraps=diagnostics._scan_local_image_dir) as scan_spy:
            batch = diagnostics._stat_local_images_batch(str(self.path), keys, cache_epoch=(99, 1))
            self.assertEqual(scan_spy.call_count, 1)
        self.assertEqual(batch, expected)
        self.assertEqual(batch[str(folder / "Strasse.png")], (None, ""))
        self.assertEqual(batch[str(strasse)][0], str(strasse.resolve()))
        if os.name == "nt":
            self.assertEqual(batch[str(folder / "ONE.PNG")][0], str(img1.resolve()))
        self.assertEqual(batch[str(missing)], (None, ""))
        self.assertEqual(batch[str(bad_ext)], (None, ""))
        self.assertEqual(batch[str(dir_as_png)], (None, ""))
        if has_symlinks:
            self.assertEqual(batch[str(sym_valid)][0], str(img1.resolve()))
            self.assertEqual(batch[str(sym_bad_target)], (None, ""))

    def test_batch_scandir_threshold_uses_single_stat_below_16_and_scandir_at_16(self):
        folder = self.root / "threshold_dir"
        folder.mkdir()
        small_keys = []
        for idx in range(diagnostics._BATCH_SCANDIR_MIN_FILES - 1):
            p = folder / f"item_{idx}.png"
            if idx % 3 == 0:
                p.write_bytes(b"x")
            small_keys.append(str(p))

        with patch.object(diagnostics, "_scan_local_image_dir", wraps=diagnostics._scan_local_image_dir) as scan_spy, patch.object(
            diagnostics, "_resolve_local_image_with_stat", wraps=diagnostics._resolve_local_image_with_stat,
        ) as stat_spy:
            small_res = diagnostics._stat_local_images_batch(str(self.path), small_keys, cache_epoch=(100, 1))
            self.assertEqual(scan_spy.call_count, 0)
            self.assertEqual(stat_spy.call_count, diagnostics._BATCH_SCANDIR_MIN_FILES - 1)
            self.assertEqual(len(small_res), diagnostics._BATCH_SCANDIR_MIN_FILES - 1)

            extra = folder / f"item_{diagnostics._BATCH_SCANDIR_MIN_FILES - 1}.png"
            extra.write_bytes(b"extra")
            full_keys = small_keys + [str(extra)]
            full_res = diagnostics._stat_local_images_batch(str(self.path), full_keys, cache_epoch=(100, 2))
            self.assertEqual(scan_spy.call_count, 1)
            self.assertEqual(stat_spy.call_count, diagnostics._BATCH_SCANDIR_MIN_FILES - 1)
            self.assertEqual(full_res[str(extra)][0], str(extra.resolve()))

    def test_evicted_state_late_write_and_drop_do_not_clobber_reopened_instance(self):
        img = self.root / "reopen.png"
        img.write_bytes(b"initial")
        self.add(self.sample(img, 0.5, 0.25, epoch=1, step=1))

        # Bump old instance's local_generation to a high number
        diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        for _ in range(4):
            diagnostics.analyze_dataset_diagnostics(self.record, min_count=1, refresh_local=True)
        old_epoch, _ = diagnostics._local_stat_cache[str(self.path)]
        old_token, old_gen = old_epoch
        self.assertGreaterEqual(old_gen, 5)

        # Evict old instance from _file_cache via another run
        other_run = self.output / "evict-reopen-other"
        other_ctrl = other_run / "log" / ".run-control"
        other_ctrl.mkdir(parents=True)
        (other_ctrl / "loss.jsonl").write_text(
            json.dumps({"run_id": "r2"}) + "\n" + json.dumps(self.sample("other.png", 0.5, 0.2)) + "\n",
            encoding="utf-8",
        )
        other_rec = {**self.record, "run_dir": "output/evict-reopen-other", "run_path": other_run}
        with patch.object(diagnostics, "_MAX_CACHED_FILES", 1):
            diagnostics.analyze_dataset_diagnostics(other_rec, min_count=1)
        self.assertNotIn(str(self.path), diagnostics._local_stat_cache)

        # Reopen the original run: new _LossFileState gets higher state_token and starts at generation=1
        with patch.object(diagnostics, "_MAX_CACHED_FILES", 1):
            reopened = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        self.assertTrue(bool(reopened["by_image"][0]["thumb_url"]))
        new_epoch, new_items = diagnostics._local_stat_cache[str(self.path)]
        new_token, new_gen = new_epoch
        self.assertGreater(new_token, old_token)
        self.assertEqual(new_gen, 2)
        self.assertLess(new_gen, old_gen)

        # Late write from evicted instance with higher generation must be ignored
        diagnostics._store_local_stat_entries(str(self.path), (old_token, old_gen + 10), {"late.png": ("late", "9-9")})
        self.assertEqual(diagnostics._local_stat_cache[str(self.path)][0], new_epoch)
        self.assertNotIn("late.png", diagnostics._local_stat_cache[str(self.path)][1])
        self.assertIn(reopened["by_image"][0]["image"], new_items)

        # Late drop from evicted instance must not delete new instance's bucket
        diagnostics._drop_local_stat_bucket(str(self.path), max_token=old_token)
        self.assertIn(str(self.path), diagnostics._local_stat_cache)
        diagnostics._drop_local_stat_bucket(str(self.path), max_token=new_token)
        self.assertNotIn(str(self.path), diagnostics._local_stat_cache)

    def test_fast_preview_url_matches_build_image_preview_url(self):
        import urllib.parse
        from backend.image_preview import build_image_preview_url

        for run_dir in ("output/demo run", "output/山景+测试&v=1%20", "output/plain"):
            encoded = urllib.parse.quote_plus(run_dir)
            for version in ("1700000000000-1234", ""):
                fast = diagnostics._preview_fields_from_stat("0123456789abcdef", encoded, ("C:/img.png", version))
                expected_thumb = build_image_preview_url(
                    scope="loss_sample", variant="thumb", run_dir=run_dir, path="0123456789abcdef", version=version,
                )
                expected_preview = build_image_preview_url(
                    scope="loss_sample", variant="preview", run_dir=run_dir, path="0123456789abcdef", version=version,
                )
                self.assertEqual(fast["thumb_url"], expected_thumb)
                self.assertEqual(fast["preview_url"], expected_preview)

    def test_profile_epoch_compact_cells_and_halves_cache(self):
        diagnostics.clear_dataset_diagnostics_cache()
        self.add({"run_id": "prof_ep"}, mode="w")
        step = 0
        for ep in range(1, 7):
            for idx in range(4):
                step += 1
                loss = 0.4 - 0.03 * ep if ep > 3 else 0.4
                self.add(self.sample(f"p{idx}.png", 0.25, loss, ep, step))
                self.add(self.sample(f"p{idx}.png", 0.75, loss * 1.2, ep, step))

        orig_halves = LossIndex._profile_epoch_halves
        halves_calls = []

        def track_halves(idx_self, epoch_numbers=None):
            was_cached = idx_self._profile_epoch_halves_cache is not None
            out = orig_halves(idx_self, epoch_numbers)
            halves_calls.append(was_cached)
            return out

        with patch.object(LossIndex, "_profile_epoch_halves", track_halves):
            res = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        # profile_bins populates _profile_epoch_halves_cache; profile_zone_extras hits cache
        self.assertEqual(halves_calls, [False, True])

        state = diagnostics._get_loss_state(self.path)
        idx_obj = state.index
        self.assertIsNotNone(idx_obj)
        # 6 epochs x 2 p_bins = 12 cells (not 6 * 4 images * 2 = 48 cells)
        self.assertEqual(len(idx_obj._profile_epoch._cells), 12)
        self.assertLess(len(idx_obj._profile_epoch._cells), len(state.epochs.keys))
        # Early half (ep 1..3) loss=0.4, late half (ep 4..6) mean=(0.28+0.25+0.22)/3=0.25 -> trend = 0.25/0.4 - 1 = -0.375
        self.assertAlmostEqual(res["noise_zones"]["low"]["trend"], -0.375, places=6)
        self.assertAlmostEqual(res["noise_zones"]["high"]["trend"], -0.375, places=6)
        bins_with_data = [b for b in res["timestep_profile"]["bins"] if b["count"] > 0]
        self.assertEqual(len(bins_with_data), 2)
        for b in bins_with_data:
            self.assertAlmostEqual(b["trend"], -0.375, places=6)

        # Incremental append invalidates _profile_epoch_halves_cache and matches cold calculation
        for idx in range(4):
            step += 1
            self.add(self.sample(f"p{idx}.png", 0.25, 0.16, 7, step))
            self.add(self.sample(f"p{idx}.png", 0.75, 0.192, 7, step))
        warm_inc = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        diagnostics.clear_dataset_diagnostics_cache()
        cold_inc = diagnostics.analyze_dataset_diagnostics(self.record, min_count=1)
        self.assertEqual(warm_inc["noise_zones"], cold_inc["noise_zones"])
        self.assertEqual(warm_inc["timestep_profile"]["bins"], cold_inc["timestep_profile"]["bins"])

    def test_coexisting_unicode_casefold_parent_dirs_do_not_collide_and_short_83_falls_back(self):
        import os

        dir_sharp = self.root / "Straße"
        dir_ss = self.root / "Strasse"
        dir_sharp.mkdir()
        dir_ss.mkdir()

        keys = []
        expected_paths = {}
        # 8 unique images in each directory (16 total; if wrongly merged, one dir would overwrite the other)
        for idx in range(8):
            p_sharp = dir_sharp / f"sharp_{idx}.png"
            p_ss = dir_ss / f"ss_{idx}.png"
            p_sharp.write_bytes(f"sharp-{idx}".encode())
            p_ss.write_bytes(f"ss-{idx}-longer".encode())
            keys.extend([str(p_sharp), str(p_ss)])
            expected_paths[str(p_sharp)] = str(p_sharp.resolve())
            expected_paths[str(p_ss)] = str(p_ss.resolve())

        with patch.object(diagnostics, "_BATCH_SCANDIR_MIN_FILES", 8):
            res = diagnostics._stat_local_images_batch(str(self.path), keys, cache_epoch=(201, 1))

        for k, exp in expected_paths.items():
            self.assertEqual(res[k][0], exp)

        # Cross-directory lookups must return missing instead of resolving into the sibling directory
        cross_keys = [str(dir_ss / "sharp_0.png"), str(dir_sharp / "ss_0.png")]
        cross_res = diagnostics._stat_local_images_batch(str(self.path), cross_keys, cache_epoch=(201, 2))
        self.assertEqual(cross_res[cross_keys[0]], (None, ""))
        self.assertEqual(cross_res[cross_keys[1]], (None, ""))

        # Windows 8.3 short name (containing '~') in a batch scandir directory falls back to OS resolution
        short_dir = self.root / "short83_dir"
        short_dir.mkdir()
        long_img = short_dir / "a fairly long image name.png"
        long_img.write_bytes(b"short-83-payload")
        pad_keys = []
        for idx in range(diagnostics._BATCH_SCANDIR_MIN_FILES):
            pad = short_dir / f"pad_{idx}.png"
            pad.write_bytes(b"p")
            pad_keys.append(str(pad))
        short_alias = str(short_dir / "AFAIRL~1.PNG")
        expected_short = (long_img.resolve(), "123-16")
        orig_resolve = diagnostics._resolve_local_image_with_stat

        def fake_resolve(raw_key):
            if raw_key == short_alias:
                return expected_short
            return orig_resolve(raw_key)

        with patch.object(diagnostics.os, "name", "nt"), patch.object(
            diagnostics, "_resolve_local_image_with_stat", side_effect=fake_resolve
        ) as resolve_spy:
            out = diagnostics._stat_local_images_batch(str(self.path), pad_keys + [short_alias], cache_epoch=(202, 1))
        self.assertEqual(out[short_alias], (str(expected_short[0]), expected_short[1]))
        self.assertEqual(resolve_spy.call_args_list[-1].args[0], short_alias)

        if os.name == "nt":
            import ctypes
            buf = ctypes.create_unicode_buffer(512)
            length = ctypes.windll.kernel32.GetShortPathNameW(str(long_img), buf, len(buf))
            if length and "~" in buf.value:
                real_short = buf.value
                real_out = diagnostics._stat_local_images_batch(
                    str(self.path), pad_keys + [real_short], cache_epoch=(203, 1),
                )
                self.assertEqual(real_out[real_short][0], str(long_img.resolve()))

    def test_unicode_casefold_dirs_same_filename_stay_distinct_while_ascii_case_aliases_merge(self):
        from PIL import Image

        dir_sharp = self.root / "Straße"
        dir_ss = self.root / "Strasse"
        dir_other = self.root / "other"
        dir_sharp.mkdir()
        dir_ss.mkdir()
        dir_other.mkdir()

        p_sharp = dir_sharp / "img0.png"
        p_ss = dir_ss / "img0.png"
        p_other = dir_other / "img0.png"
        Image.new("RGB", (20, 20), (200, 30, 30)).save(p_sharp)
        Image.new("RGB", (36, 36), (30, 200, 30)).save(p_ss)
        Image.new("RGB", (24, 24), (30, 30, 200)).save(p_other)

        p_other_upper = str(dir_other / "IMG0.PNG")
        sharp_row = self.sample(p_sharp, 0.5, 0.1, epoch=1, step=1)
        ss_row = self.sample(p_ss, 0.5, 0.9, epoch=1, step=2)
        other_rows = [
            self.sample(p_other, 0.5, 0.2, epoch=1, step=3),
            self.sample(p_other_upper, 0.5, 0.4, epoch=1, step=4),
        ]

        for order_name, first_rows in (("forward", [sharp_row, ss_row]), ("reverse", [ss_row, sharp_row])):
            with self.subTest(order=order_name):
                diagnostics.clear_dataset_diagnostics_cache()
                self.add({"run_id": f"unicode-{order_name}"}, *first_rows, *other_rows, mode="w")
                result = diagnostics.analyze_dataset_diagnostics(self.record, num_bins=3, min_count=1)
                self.assertEqual(len(result["by_image"]), 3)

                by_parent = {}
                for entry in result["by_image"]:
                    norm_key = entry["image"].replace("\\", "/")
                    parent = norm_key.rsplit("/", 2)[-2]
                    by_parent[parent] = entry
                self.assertEqual(set(by_parent), {"Straße", "Strasse", "other"})

                sharp_entry = by_parent["Straße"]
                ss_entry = by_parent["Strasse"]
                other_entry = by_parent["other"]
                self.assertNotEqual(sharp_entry["image_id"], ss_entry["image_id"])
                self.assertEqual(sharp_entry["count"], 1)
                self.assertAlmostEqual(sharp_entry["mean_loss"], 0.1, places=6)
                self.assertEqual(ss_entry["count"], 1)
                self.assertAlmostEqual(ss_entry["mean_loss"], 0.9, places=6)
                self.assertEqual(other_entry["count"], 2)
                self.assertAlmostEqual(other_entry["mean_loss"], 0.3, places=6)

                dir_keys = [d["key"] for d in result["by_directory"]]
                self.assertEqual(len(dir_keys), 3)
                self.assertTrue(any("Straße" in key for key in dir_keys))
                self.assertTrue(any("Strasse" in key for key in dir_keys))

                sharp_detail = diagnostics.read_dataset_diagnostic_image(
                    self.record, image_id=sharp_entry["image_id"], min_count=1,
                )
                ss_detail = diagnostics.read_dataset_diagnostic_image(
                    self.record, image_id=ss_entry["image_id"], min_count=1,
                )
                self.assertEqual(sharp_detail["file_info"]["width"], 20)
                self.assertEqual(ss_detail["file_info"]["width"], 36)


