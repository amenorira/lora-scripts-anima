"""Generation recovery, cancellation, and output preservation regressions."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

from backend.regularization import planning, service, storage, worker
from backend.tasks import TaskManager


class FakeRunner:
    def __init__(self, settings, report, check):
        self.check = check

    def generate(self, item):
        self.check()
        return Image.new("RGB", (item["width"], item["height"]), "red")


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "chara"
        subset = self.source / "2_face"
        subset.mkdir(parents=True)
        Image.new("RGB", (64, 96), "white").save(subset / "a.png")
        self.caption_path = subset / "a.txt"
        self.caption_path.write_text("trigger, Blue_Hair, 多词 标签, masterpiece\nignored line", encoding="utf-8")
        models = {}
        for key in ("dit", "text_encoder", "vae"):
            path = self.root / f"{key}.safetensors"
            path.write_bytes(b"model")
            models[key] = str(path)
        self.settings = dict(source_dir=str(self.source), **models, size_mode="fixed", width=64, height=64)
        for module, key, value in [(storage, "OUTPUT_ROOT", self.root / "output"), (service, "tm", TaskManager()),
                                   (service, "_plans", {}), (service, "_tasks", {}), (service, "_recovery_started", False)]:
            mocked = patch.object(module, key, value)
            mocked.start(); self.addCleanup(mocked.stop)

    def stored_run(self, status="completed", quantity=1, source_names=False):
        settings = planning.Settings(**self.settings, seed=19, per_image=quantity)
        source, sources = planning.scan(settings)
        config, fingerprint = planning.identity(settings, source, sources)
        root = storage.run_path("reg_chara")
        root.mkdir(parents=True)
        items = planning.make_items(sources, 19)
        for item in items:
            item["status"] = status
            if not source_names:
                item.pop("filename")  # Existing manifests used sequential names.
        manifest = dict(task_id="old", run_key=root.name, fingerprint=fingerprint, settings=config, sources=sources,
                        items=items, master_seed=19, status="finished", updated_at=1)
        if status == "completed":
            (root / "1_reg").mkdir()
            for item in items:
                Image.new("RGB", (64, 64), "white").save(storage.item_path(root, item))
                storage.atomic_write(storage.item_path(root, item, ".txt"), item["caption"].encode())
        storage.save_manifest(root, manifest)
        return root, manifest

    def test_multicandidate_requires_selection_and_preserves_full_selected_text(self):
        original = "---===--- # original\ntrigger, blue hair\n---===--- # long\nFirst line.\nSecond line, detail.\n---===--- # short\nShort description.\n"
        self.caption_path.write_text(original, encoding="utf-8")
        settings = planning.Settings(**self.settings)
        _, sources = planning.scan(settings)
        self.assertEqual(sources[0]["reason_code"], "regularization_candidate_required")
        self.assertTrue(sources[0]["multi_candidate"])
        for choice, expected in (("original", "trigger, blue hair"), ("long", "First line. Second line, detail."), ("short", "Short description.")):
            _, selected = planning.scan(planning.Settings(**self.settings, caption_candidate=choice))
            self.assertEqual(selected[0]["original_caption"], expected)
            self.assertEqual(selected[0]["caption"], expected)
            self.assertFalse(selected[0]["reason"])
        _, missing = planning.scan(planning.Settings(**self.settings, caption_candidate="medium"))
        self.assertEqual(missing[0]["reason_code"], "regularization_candidate_missing")
        _, not_plain = planning.scan(planning.Settings(**self.settings, caption_candidate="first_line"))
        self.assertEqual(not_plain[0]["reason_code"], "regularization_candidate_not_plain")
        self.assertEqual(self.caption_path.read_text(encoding="utf-8"), original)

    def test_custom_separator_empty_candidate_and_ordinary_first_line(self):
        custom = "CUSTOM-CAPTION # long\nline one\nline two\nCUSTOM-CAPTION # short\n\n"
        self.caption_path.write_text(custom, encoding="utf-8")
        _, sources = planning.scan(planning.Settings(**self.settings, caption_candidate="long"))
        self.assertEqual(sources[0]["caption"], "line one line two")
        _, empty = planning.scan(planning.Settings(**self.settings, caption_candidate="short"))
        self.assertEqual(empty[0]["reason_code"], "regularization_candidate_missing")
        self.caption_path.write_text("ordinary tags, detailed\nsecond line", encoding="utf-8")
        _, ordinary = planning.scan(planning.Settings(**self.settings))
        self.assertEqual(ordinary[0]["caption"], "ordinary tags, detailed")
        self.assertNotIn("multi_candidate", ordinary[0])

    def test_ambiguous_header_needs_explicit_choice_and_malformed_fails(self):
        self.caption_path.write_text("ordinary text # long\nnot a named candidate", encoding="utf-8")
        _, sources = planning.scan(planning.Settings(**self.settings))
        self.assertEqual(sources[0]["reason_code"], "regularization_candidate_required")
        _, chosen = planning.scan(planning.Settings(**self.settings, caption_candidate="first_line"))
        self.assertEqual(chosen[0]["caption"], "ordinary text # long")
        self.caption_path.write_text("---===--- # long\ntext\n---===--- # long\nsecond", encoding="utf-8")
        _, malformed = planning.scan(planning.Settings(**self.settings, caption_candidate="long"))
        self.assertEqual(malformed[0]["reason_code"], "regularization_candidate_invalid")

    def test_unselected_candidate_blocks_start_even_with_other_valid_images(self):
        self.caption_path.write_text("---===--- # long\nA description", encoding="utf-8")
        other = self.caption_path.with_name("b.png")
        Image.new("RGB", (64, 64)).save(other)
        other.with_suffix(".txt").write_text("ordinary", encoding="utf-8")
        plan = service.preview({"settings": self.settings})
        self.assertEqual(plan["candidate_selection_required"], 1)
        self.assertEqual(plan["total"], 1)
        with self.assertRaises(planning.CaptionSelectionError):
            service.start(plan["token"])

    def test_source_error_codes_do_not_change_legacy_plan_identity(self):
        self.caption_path.unlink()
        settings = planning.Settings(**self.settings)
        root, sources = planning.scan(settings)
        self.assertEqual(sources[0]["reason_code"], "regularization_missing_caption")
        config, fingerprint = planning.identity(settings, root, sources)
        self.assertNotIn("caption_candidate", config)
        legacy_sources = [{key: value for key, value in source.items() if key != "reason_code"} for source in sources]
        model_stamps = [planning.source_stamp(Path(config[key])) for key in ("dit", "text_encoder", "vae")]
        self.assertEqual(fingerprint, planning.digest({"settings": config, "sources": legacy_sources, "models": model_stamps}))


    def test_added_sources_extend_existing_run_without_touching_completed_pairs(self):
        root, old = self.stored_run(source_names=True)
        original = (root / "1_reg/a.png").read_bytes()
        # A new, earlier-sorting source with the same stem must not rename a.png.
        subset = self.source / "1_new"
        subset.mkdir()
        Image.new("RGB", (64, 64)).save(subset / "a.jpg")
        (subset / "a.txt").write_text("new caption")
        body = {"settings": old["settings"]}
        plan = service.preview(body)
        self.assertEqual((plan["run_key"], plan["completed"], plan["pending"]), (root.name, 1, 1))
        def launch(task, output, manifest):
            storage.save_manifest(output, manifest)
            service.tm.release_reserved(task)
            return manifest
        with patch.object(service, "_launch", launch):
            manifest = service.start(plan["token"])
        self.assertEqual(manifest["items"][0], old["items"][0])
        self.assertEqual(manifest["items"][1]["filename"], "a_001.png")
        worker.run(root, FakeRunner)
        self.assertEqual((root / "1_reg/a.png").read_bytes(), original)
        self.assertEqual(service.preview(body)["pending"], 0)
        self.assertNotEqual(service.preview(dict(body, new_round=True))["run_key"], root.name)

    def test_candidate_affects_only_the_sources_that_use_it(self):
        root, old = self.stored_run(source_names=True)
        settings = dict(old["settings"], caption_candidate="long")
        plain = service.preview({"settings": settings})
        self.assertEqual((plain["run_key"], plain["fingerprint"]), (root.name, old["fingerprint"]))
        added = self.caption_path.with_name("b.png")
        Image.new("RGB", (64, 64)).save(added)
        added.with_suffix(".txt").write_text("---===--- # long\ndetailed\n---===--- # short\nbrief")
        plan = service.preview({"settings": settings})
        self.assertEqual((plan["run_key"], plan["completed"], plan["pending"]), (root.name, 1, 1))
        def launch(task, output, manifest):
            storage.save_manifest(output, manifest)
            service.tm.release_reserved(task)
            return manifest
        with patch.object(service, "_launch", launch):
            manifest = service.start(plan["token"])
        self.assertEqual(manifest["items"][0], old["items"][0])
        self.assertEqual(manifest["items"][1]["caption"], "detailed")
        switched = service.preview({"settings": dict(settings, caption_candidate="short")})
        self.assertNotEqual(switched["run_key"], root.name)

    def test_resume_checks_only_executed_legacy_items(self):
        root, manifest = self.stored_run(status="pending", quantity=2)
        first, second = manifest["items"]
        header = "---===--- # long"
        manifest["sources"][0].update(original_caption=header, caption=header, prompt=header)
        first.update(caption=header, prompt=header)
        second.update(status="failed", caption="edited", prompt="edited")
        storage.save_manifest(root, manifest)
        snapshot = (root / "generation.json").read_bytes()
        with self.assertRaises(planning.CaptionSelectionError) as caught:
            service.resume(root.name)
        self.assertEqual(caught.exception.code, "regularization_legacy_candidate")
        self.assertEqual((root / "generation.json").read_bytes(), snapshot)
        with patch.object(service, "_launch") as launch:
            service.resume(root.name, failed_only=True)
        self.assertEqual(launch.call_args.args[-1]["selection"], [second["index"]])

    def test_old_plan_reason_codes_are_added_only_to_the_displayed_page(self):
        root, manifest = self.stored_run()
        manifest["sources"][0]["reason"] = "Missing caption txt / 缺少标签 txt"
        storage.save_manifest(root, manifest)
        token = service.run_plan(root.name)["token"]
        self.assertEqual(service.plan_items(token)["items"][0]["reason_code"], "regularization_missing_caption")
        self.assertNotIn("reason_code", storage.read_manifest(root, readonly=True)["sources"][0])

    def test_regenerate_rejects_a_saved_header_before_moving_any_outputs(self):
        root, manifest = self.stored_run()
        item = manifest["items"][0]
        header = "---===--- # unknown"
        manifest["sources"][0].update(original_caption=header, caption=header, prompt=header)
        item.update(caption=header, prompt=header)
        label = storage.item_path(root, item, ".txt")
        label.write_text(header)
        storage.save_manifest(root, manifest)
        watched = [storage.item_path(root, item), label, root / "generation.json"]
        before = [p.read_bytes() for p in watched]
        with self.assertRaises(planning.CaptionSelectionError):
            service.mutate(root.name, item["index"], "regenerate")
        self.assertEqual([p.read_bytes() for p in watched], before)
        # A user-corrected output caption is the actual prompt for regeneration.
        label.write_text("edited")
        with patch.object(service, "_launch") as launch:
            service.mutate(root.name, item["index"], "regenerate")
        self.assertEqual(launch.call_args.args[-1]["items"][-1]["prompt"], "edited")


    def test_ordinary_failure_continues_and_oom_preserves_completed(self):
        root, manifest = self.stored_run("pending", 3)
        class Failing(FakeRunner):
            def generate(self, item):
                if item["index"] == 2:
                    raise RuntimeError("ordinary")
                return super().generate(item)
        worker.run(root, Failing)
        self.assertEqual([i["status"] for i in storage.read_manifest(root)["items"]], ["completed", "failed", "completed"])
        manifest["items"][0]["status"] = "completed"
        storage.save_manifest(root, manifest)
        class OOM(FakeRunner):
            def generate(self, item):
                raise torch.cuda.OutOfMemoryError("OOM")
        self.assertEqual(worker.run(root, OOM), 1)
        result = storage.read_manifest(root)
        self.assertEqual(result["status"], "failed")
        self.assertEqual([i["status"] for i in result["items"]], ["completed", "pending", "pending"])


if __name__ == "__main__":
    unittest.main()
