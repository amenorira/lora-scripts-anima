import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image

from backend.tagger import interrogator, workspace
from backend.tagger.registry import MODEL_SPECS, model_payload

class TaggerRegistryTests(unittest.TestCase):
    def test_registry_contains_only_supported_onnx_taggers(self):
        self.assertEqual(
            [spec.id for spec in MODEL_SPECS],
            [
                "wd-eva02-large-tagger-v3",
                "wd-vit-large-tagger-v3",
                "cl_tagger_1_02",
                "camie-tagger-v2",
            ],
        )
        self.assertTrue(all(spec.engine == "onnx" for spec in MODEL_SPECS))
        self.assertTrue(all(spec.family == "tagger" for spec in MODEL_SPECS))
        with patch("backend.tagger.registry.gpu_info", return_value={}):
            payload = model_payload()
        self.assertNotIn("recommended_llm", payload["hardware"])
        self.assertNotIn("runtime_installed", payload["models"][0])
        self.assertNotIn("files_installed", payload["models"][0])
        self.assertTrue(payload["models"][0]["supports_character_toggle"])
        self.assertEqual(payload["models"][0]["threshold_categories"], ())
        self.assertEqual(payload["models"][2]["threshold_categories"][-2:], ("quality", "rating"))
        self.assertTrue(payload["models"][2]["supports_model_tag"])
        self.assertFalse(payload["models"][0]["supports_model_tag"])
class TaggerWorkspaceTests(unittest.TestCase):
    def _image(self, path: Path, color=(120, 80, 160)) -> None:
        Image.new("RGB", (48, 32), color).save(path)

    def _wait(self, task_id: str) -> dict:
        deadline = time.time() + 5
        while time.time() < deadline:
            result = workspace.task_snapshot(task_id)
            if result.get("status") in {"done", "error", "cancelled"}:
                return result
            time.sleep(0.02)
        self.fail("Tagger task did not finish")


    def test_scan_thumbnail_task_results_and_atomic_caption_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "sample.png"
            self._image(image_path)
            source = workspace.scan_source(str(root), True)
            self.assertEqual(source["total"], 1)
            self.assertEqual(source["with_caption"], 0)
            page = workspace.source_items(source["source_token"], 0, 1)
            self.assertEqual(page["total"], 1)
            self.assertEqual(page["items"][0]["index"], 0)

            with patch.object(workspace, "TAGGER_CACHE_DIR", root / "cache"):
                thumb = workspace.thumbnail_path(source["source_token"], 0)
                self.assertTrue(thumb.is_file())
                with Image.open(thumb) as generated:
                    self.assertLessEqual(max(generated.size), 160)

            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_onnx_tags", return_value=(
                    ["1girl", "blue eyes"],
                    {"general": {"tags": [["1girl", 0.99]]}},
                )
            ):
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "camie-tagger-v2",
                    "conflict": "copy",
                    "write_captions": True,
                })
                result = self._wait(task_id)

            self.assertEqual(result["status"], "done")
            self.assertEqual(result["source_root"], str(root.resolve()))
            self.assertEqual(image_path.with_suffix(".txt").read_text(encoding="utf-8"), "1girl, blue eyes")
            items = workspace.task_items(task_id)["items"]
            self.assertEqual(items[0]["result"]["text"], "1girl, blue eyes")
            self.assertFalse(list(root.glob(".*.tmp")))

    def test_read_only_single_task_does_not_skip_existing_caption(self):
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "single.png"
            self._image(image_path)
            caption_path = image_path.with_suffix(".txt")
            caption_path.write_text("old model tag", encoding="utf-8")
            source = workspace.scan_source(str(image_path), False)

            categories = {"general": {"tags": [["new_model_tag", 0.98]], "total": 1}}
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace,
                "_onnx_tags",
                return_value=(["new model tag"], categories),
            ) as infer:
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "wd-eva02-large-tagger-v3",
                    "conflict": "ignore",
                    "write_captions": False,
                })
                result = self._wait(task_id)

            self.assertEqual(result["status"], "done")
            infer.assert_called_once()
            item_result = workspace.task_items(task_id)["items"][0]["result"]
            self.assertEqual(item_result["text"], "new model tag")
            self.assertEqual(item_result["categories"], categories)
            self.assertEqual(caption_path.read_text(encoding="utf-8"), "old model tag")

    def test_skip_existing_caption_does_not_run_inference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "existing.png"
            self._image(image_path)
            image_path.with_suffix(".txt").write_text("existing tag", encoding="utf-8")
            source = workspace.scan_source(str(root), True)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_onnx_tags", side_effect=AssertionError("inference should be skipped")
            ):
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "camie-tagger-v2",
                    "conflict": "ignore",
                    "write_captions": True,
                })
                result = self._wait(task_id)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(workspace.task_items(task_id)["items"][0]["result"]["text"], "existing tag")




    def test_onnx_result_keeps_all_raw_categories_and_passes_category_thresholds(self):
        raw = {
            "general": [("1girl", 0.99)],
            "character": [("alice", 0.88)],
            "rating": [("safe", 0.97)],
            "model": [("anime", 0.91)],
        }
        fake = MagicMock()
        fake.interrogate.return_value = raw
        thresholds = {"general": 0.4, "character": 0.7, "rating": 1.01, "model": 1.01}
        with patch.dict(workspace.available_interrogators, {"camie-tagger-v2": fake}), patch.object(
            interrogator.Interrogator,
            "postprocess_tags",
            return_value={"1girl": 0.99, "alice": 0.88},
        ) as postprocess:
            tags, categories = workspace._onnx_tags(
                "camie-tagger-v2",
                Image.new("RGB", (16, 16)),
                {"category_thresholds": thresholds},
            )

        self.assertEqual(tags, ["1girl", "alice"])
        self.assertEqual(set(categories), {"general", "character", "rating", "model"})
        self.assertEqual(categories["character"]["tags"], [["alice", 0.88]])
        self.assertEqual(categories["character"]["total"], 1)
        self.assertFalse(categories["character"]["truncated"])
        self.assertEqual(postprocess.call_args.args[3], thresholds)
        self.assertEqual(set(raw), {"general", "character", "rating", "model"})

    def test_onnx_result_can_disable_character_tags_without_hiding_raw_category(self):
        fake = MagicMock()
        fake.interrogate.return_value = {
            "general": [("1girl", 0.99)],
            "character": [("alice", 0.88)],
        }
        with patch.dict(workspace.available_interrogators, {"wd-eva02-large-tagger-v3": fake}):
            tags, categories = workspace._onnx_tags(
                "wd-eva02-large-tagger-v3",
                Image.new("RGB", (16, 16)),
                {"category_enabled": {"character": False}},
            )

        self.assertEqual(tags, ["1girl"])
        self.assertIn("character", categories)

    def test_category_models_use_category_switch_for_rating_and_model_capability(self):
        fake = MagicMock()
        fake.interrogate.return_value = {
            "general": [("1girl", 0.99)],
            "rating": [("safe", 0.97)],
            "model": [("nai", 0.91)],
        }
        with patch.dict(workspace.available_interrogators, {"cl_tagger_1_02": fake}), patch.object(
            interrogator.Interrogator,
            "postprocess_tags",
            return_value={"1girl": 0.99},
        ) as postprocess:
            workspace._onnx_tags(
                "cl_tagger_1_02",
                Image.new("RGB", (16, 16)),
                {
                    "add_rating_tag": False,
                    "add_model_tag": False,
                    "category_enabled": {"rating": True},
                },
            )

        self.assertTrue(postprocess.call_args.args[4])
        self.assertFalse(postprocess.call_args.args[5])




    def test_append_caption_respects_remove_duplicated_option(self):
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "sample.png"
            caption_path = image_path.with_suffix(".txt")
            caption_path.write_text("1girl, blue eyes", encoding="utf-8")

            workspace._write_caption(image_path, ["blue eyes", "smile"], "prepend", False)
            self.assertEqual(caption_path.read_text(encoding="utf-8"), "1girl, blue eyes, blue eyes, smile")

            caption_path.write_text("1girl, blue eyes", encoding="utf-8")
            workspace._write_caption(image_path, ["blue eyes", "smile"], "prepend", True)
            self.assertEqual(caption_path.read_text(encoding="utf-8"), "1girl, blue eyes, smile")

    def test_legacy_cancel_returns_without_reacquiring_progress_lock(self):
        task_id = "cancel-lock-test"
        with interrogator._tagger_progress_lock:
            interrogator._tagger_progress[task_id] = {"status": "running", "logs": []}
        thread = threading.Thread(target=interrogator.cancel_tagger_task, args=(task_id,))
        thread.start()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(interrogator.get_tagger_task_snapshot(task_id)["status"], "cancelled")
        with interrogator._tagger_progress_lock:
            interrogator._tagger_progress.pop(task_id, None)



if __name__ == "__main__":
    unittest.main()
