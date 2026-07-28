import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image

from backend.tagger import interrogator, workspace
from backend.tagger.registry import MODEL_SPECS, recommended_llm_id


REPO_ROOT = Path(__file__).resolve().parents[1]


class TaggerRegistryTests(unittest.TestCase):
    def test_install_snapshot_exposes_download_metrics_and_live_progress(self):
        from backend.server.routes import tagger as tagger_routes

        job_id = "download-metrics-test"
        job = {
            "status": "running",
            "done": False,
            "progress": {
                "phase": "downloading",
                "downloaded": 104857600,
                "total": 524288000,
                "speed": 20.0,
                "filename": "model.gguf",
                "file_index": 1,
                "file_total": 2,
            },
            "logs": [],
            "progress_line": "[12:00:00] model.gguf [####................] 20% 100M/500M 20.0MB/s",
            "error_detail": None,
            "lock": threading.RLock(),
        }
        with tagger_routes._install_jobs_lock:
            tagger_routes._install_jobs[job_id] = job
        try:
            snapshot = tagger_routes._install_snapshot(job_id)
        finally:
            with tagger_routes._install_jobs_lock:
                tagger_routes._install_jobs.pop(job_id, None)

        self.assertEqual(snapshot["downloaded"], 104857600)
        self.assertEqual(snapshot["file_index"], 1)
        self.assertEqual(snapshot["file_total"], 2)
        self.assertAlmostEqual(snapshot["eta_seconds"], 20.0)
        self.assertIn("20.0MB/s", snapshot["logs"][-1])

    def test_qwen_registry_exposes_qwen35_dynamic_q4_models(self):
        qwen = [spec for spec in MODEL_SPECS if spec.engine == "llama"]
        self.assertEqual([spec.id for spec in qwen], ["qwen3.5-4b-ud-q4", "qwen3.5-9b-ud-q4"])
        self.assertTrue(all("UD-Q4_K_XL" in spec.name for spec in qwen))
        self.assertTrue(all(spec.repo_id.startswith("unsloth/Qwen3.5-") for spec in qwen))
        self.assertTrue(all(spec.projector_file == "mmproj-F16.gguf" for spec in qwen))
        self.assertFalse(any("Q5" in spec.name for spec in qwen))
        self.assertEqual(recommended_llm_id(8), "qwen3.5-4b-ud-q4")
        self.assertEqual(recommended_llm_id(10), "qwen3.5-9b-ud-q4")

    def test_qwen_prompt_presets_share_full_image_coverage(self):
        from backend.tagger.prompt_presets import TAGGER_PROMPT_PRESETS, resolve_tagger_prompt

        self.assertEqual(set(TAGGER_PROMPT_PRESETS), {"danbooru", "enhanced"})
        for prompt in TAGGER_PROMPT_PRESETS.values():
            for concept in ("subjects and count", "clothing", "action", "composition", "background", "lighting"):
                self.assertIn(concept.split()[-1], prompt.lower())
            self.assertIn("{{max_tags}}", prompt)
            self.assertIn("left and right", prompt)
            self.assertIn("all distinct salient facts", prompt)
            self.assertIn("fabric ornaments", prompt)
            self.assertIn("comma-separated line", prompt)
        self.assertIn("Do not invent compound tags", TAGGER_PROMPT_PRESETS["danbooru"])
        self.assertIn("small minority of short concrete English phrases", TAGGER_PROMPT_PRESETS["enhanced"])
        self.assertIn("same complete set", TAGGER_PROMPT_PRESETS["enhanced"])
        self.assertIn("four out of every five", TAGGER_PROMPT_PRESETS["enhanced"])
        self.assertIn("72 is a hard ceiling", resolve_tagger_prompt({"preset": "enhanced"}, 72))
        self.assertEqual(resolve_tagger_prompt({"prompt": "Return {{max_tags}} items."}, 36), "Return 36 items.")

    def test_llama_runtime_distribution_uses_hugging_face_assets(self):
        from backend.tagger import llama_runtime, runtime_spec

        self.assertIsNotNone(llama_runtime.httpx)
        self.assertEqual(runtime_spec.RUNTIME_REPO, "ame-la/anima-llama-runtime")
        manifest = runtime_spec.embedded_runtime_manifest()
        self.assertEqual(manifest["runtime_api_version"], 1)
        self.assertEqual(manifest["channel"], "stable")
        self.assertEqual({asset["platform"] for asset in manifest["assets"]}, {"windows-x86_64", "linux-x86_64"})
        for asset in manifest["assets"]:
            self.assertGreater(asset["size_bytes"], 250_000_000)
            self.assertEqual(len(asset["sha256"]), 64)

    def test_runtime_channel_rejects_incompatible_or_unsafe_manifests(self):
        from backend.tagger import runtime_spec

        incompatible = dict(runtime_spec.EMBEDDED_RUNTIME_MANIFEST, runtime_api_version=2)
        with self.assertRaisesRegex(ValueError, "Incompatible runtime API"):
            runtime_spec.validate_runtime_manifest(incompatible)

        unsafe = dict(runtime_spec.EMBEDDED_RUNTIME_MANIFEST)
        unsafe["assets"] = [dict(item) for item in unsafe["assets"]]
        unsafe["assets"][0]["path"] = "../llama-runtime.zip"
        with self.assertRaisesRegex(ValueError, "unsafe asset path"):
            runtime_spec.validate_runtime_manifest(unsafe)

    def test_runtime_channel_falls_back_to_embedded_manifest_offline(self):
        from backend.tagger import runtime_spec

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            runtime_spec, "_CACHE_PATH", Path(temporary) / "stable-v1.json"
        ), patch.object(runtime_spec, "_download_channel_manifest", side_effect=OSError("offline")):
            manifest, source = runtime_spec.resolve_runtime_manifest(refresh=True)

        self.assertEqual(source, "embedded")
        self.assertEqual(manifest["runtime_ref"], "b10142")

    def test_runtime_channel_refreshes_only_after_cache_expiry(self):
        from backend.tagger import runtime_spec

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            runtime_spec, "_CACHE_PATH", Path(temporary) / "stable-v1.json"
        ):
            cached = runtime_spec.embedded_runtime_manifest()
            runtime_spec._write_cached_manifest(cached)
            with patch.object(runtime_spec, "_download_channel_manifest") as download:
                manifest, source = runtime_spec.resolve_runtime_manifest()
                download.assert_not_called()
            self.assertEqual(source, "cache")
            self.assertEqual(manifest["runtime_ref"], "b10142")

            remote = dict(cached, runtime_ref="b10143")
            expired_at = runtime_spec._CACHE_PATH.stat().st_mtime + runtime_spec.RUNTIME_MANIFEST_TTL_SECONDS + 1
            with patch.object(runtime_spec.time, "time", return_value=expired_at), patch.object(
                runtime_spec, "_download_channel_manifest", return_value=remote
            ) as download:
                manifest, source = runtime_spec.resolve_runtime_manifest()
                download.assert_called_once_with()
            self.assertEqual(source, "remote")
            self.assertEqual(manifest["runtime_ref"], "b10143")

    def test_installed_llama_runtime_ref_comes_from_packaged_metadata(self):
        from backend.tagger import runtime_spec

        with tempfile.TemporaryDirectory() as temporary:
            runtime_dir = Path(temporary)
            with patch.object(runtime_spec, "TAGGER_RUNTIME_DIR", runtime_dir):
                self.assertIsNone(runtime_spec.installed_runtime_ref())
                (runtime_dir / "runtime.json").write_text(
                    '{"llama_cpp_ref":"b10142","cuda_version":"13.0.2"}',
                    encoding="utf-8",
                )
                self.assertEqual(runtime_spec.installed_runtime_ref(), "b10142")
                self.assertEqual(runtime_spec.installed_runtime_metadata()["cuda_version"], "13.0.2")

    def test_runtime_package_revision_forces_rebuilt_binary_update(self):
        from backend.tagger import runtime_spec

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            runtime_spec, "TAGGER_RUNTIME_DIR", Path(temporary)
        ):
            metadata = Path(temporary) / "runtime.json"
            metadata.write_text(
                '{"llama_cpp_ref":"b10142","package_revision":1}',
                encoding="utf-8",
            )
            manifest = dict(runtime_spec.embedded_runtime_manifest(), package_revision=2)
            self.assertFalse(runtime_spec.installed_runtime_matches(manifest))
            metadata.write_text(
                '{"llama_cpp_ref":"b10142","package_revision":2}',
                encoding="utf-8",
            )
            self.assertTrue(runtime_spec.installed_runtime_matches(manifest))

    def test_llama_response_parser_reports_token_limit_and_accepts_fenced_json(self):
        from backend.tagger.llama_runtime import LlamaResponseError, _parse_tag_response

        tags = _parse_tag_response({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": '```json\n{"tags":["1girl","blue_hair"]}\n```'},
            }],
        }, 1)
        self.assertEqual(tags, ["1girl"])

        tags = _parse_tag_response({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": '{"tags":"1girl, lower_body, white_background"}'},
            }],
        }, 2)
        self.assertEqual(tags, ["1girl", "lower_body"])

        tags = _parse_tag_response({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": '{"tags":["1girl","upper_body","<END>","ignored"]}'},
            }],
        }, 80)
        self.assertEqual(tags, ["1girl", "upper_body"])

        tags = _parse_tag_response({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": (
                    '{"subjects":"1girl, solo","composition":"upper_body",'
                    '"appearance":"long_hair","clothing_accessories":"white_dress",'
                    '"expression_gaze_pose":"smile","background_objects":"white_background"}'
                )},
            }],
        }, 5)
        self.assertEqual(tags, ["1girl", "solo", "upper_body", "long_hair", "white_dress"])

        tags = _parse_tag_response({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": "1girl, lower_body, white_background"},
            }],
        }, 2)
        self.assertEqual(tags, ["1girl", "lower_body"])

        with self.assertRaisesRegex(LlamaResponseError, "token limit"):
            _parse_tag_response({
                "choices": [{
                    "finish_reason": "length",
                    "message": {"content": '{"tags":["1girl",'},
                }],
            }, 80)

    def test_stale_llama_runtime_is_not_treated_as_current(self):
        from backend.tagger import llama_runtime

        with tempfile.TemporaryDirectory() as temporary:
            server = Path(temporary) / "llama-server.exe"
            server.write_bytes(b"MZ")
            with patch.object(llama_runtime, "llama_server_path", return_value=server), patch.object(
                llama_runtime, "installed_runtime_ref", return_value="b10000"
            ), patch.object(
                llama_runtime, "installed_runtime_matches", return_value=False
            ), patch.object(llama_runtime, "installed_runtime_metadata", return_value={"llama_cpp_ref": "b10000"}), patch.object(
                llama_runtime, "_directory_size", return_value=2
            ):
                status = llama_runtime.llama_runtime.runtime_status()

        self.assertTrue(status["installed"])
        self.assertFalse(status["ready"])
        self.assertTrue(status["update_available"])
        self.assertEqual(status["installed_ref"], "b10000")


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

    def test_llm_tag_cleanup_removes_filler_and_redundant_parents(self):
        cleaned = workspace._clean_llm_tags([
            "1girl", "anime_style", "white", "skirt", "white_skirt", "dress", "patterned_dress",
            "hair ornament", "hair clip", "pink hair clip", "bow", "pink_bow",
            "shoe", "white_shoes", "no_story",
        ])
        self.assertEqual(cleaned, [
            "1girl", "white_skirt", "patterned_dress", "pink hair clip", "pink_bow", "white_shoes",
        ])
        self.assertEqual(
            workspace._clean_llm_tags(["1 female", "looking at viewer", "white dress with cat print"], strict=True),
            ["1girl", "looking at viewer"],
        )

    def test_scan_thumbnail_task_results_and_atomic_caption_save(self):
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
                workspace, "_onnx_tags", return_value=(["1girl", "blue eyes"], {"general": {"tags": [["1girl", 0.99]]}})
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

            saved = workspace.save_caption(source["source_token"], 0, "1girl, red dress, 1girl")
            self.assertEqual(saved["text"], "1girl, red dress")
            self.assertEqual(image_path.with_suffix(".txt").read_text(encoding="utf-8"), "1girl, red dress")

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

    def test_qwen_startup_failure_stops_the_batch_after_first_image(self):
        from backend.tagger.llama_runtime import LlamaRuntimeStartupError

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "first.png")
            self._image(root / "second.png")
            source = workspace.scan_source(str(root), True)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "gpu_info", return_value={"name": "NVIDIA test GPU"}
            ), patch.object(
                workspace, "_llm_tags", side_effect=LlamaRuntimeStartupError("llama-server exited during startup")
            ) as infer:
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "qwen3.5-9b-ud-q4",
                    "write_captions": False,
                })
                result = self._wait(task_id)

            self.assertEqual(result["status"], "error")
            self.assertEqual(result["failed"], 1)
            self.assertEqual(infer.call_count, 1)
            self.assertIn("remaining images were not processed", result["error_detail"])

    def test_qwen_response_failure_does_not_abort_remaining_images(self):
        from backend.tagger.llama_runtime import LlamaResponseError

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "first.png")
            self._image(root / "second.png")
            source = workspace.scan_source(str(root), True)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "gpu_info", return_value={"name": "NVIDIA test GPU"}
            ), patch.object(
                workspace,
                "_llm_tags",
                side_effect=[LlamaResponseError("invalid JSON"), (["1girl", "solo"], {})],
            ) as infer:
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "qwen3.5-4b-ud-q4",
                    "write_captions": False,
                })
                result = self._wait(task_id)

            self.assertEqual(result["status"], "done")
            self.assertEqual(result["failed"], 1)
            self.assertEqual(result["success"], 1)
            self.assertEqual(infer.call_count, 2)

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

    def test_llm_output_applies_shared_tag_formatting_after_filtering(self):
        from backend.tagger.llama_runtime import llama_runtime

        raw = ["Looking_At_Viewer", "smile_(expression)", "pose_(dynamic)", "blue_hair", "blue hair"]
        with patch.object(llama_runtime, "infer_tags", return_value=raw):
            tags, categories = workspace._llm_tags(
                "qwen3.5-4b-ud-q4",
                Image.new("RGB", (16, 16)),
                {
                    "additional_tags": "best_quality, looking_at_viewer",
                    "exclude_tags": "smile_(expression)",
                    "replace_underscore": True,
                    "escape_tag": True,
                },
            )

        self.assertEqual(tags, ["best quality", "looking at viewer", "pose \\(dynamic\\)", "blue hair"])
        self.assertEqual(categories, {})

    def test_llm_output_preserves_raw_tag_syntax_when_formatting_is_disabled(self):
        from backend.tagger.llama_runtime import llama_runtime

        with patch.object(
            llama_runtime,
            "infer_tags",
            return_value=["looking_at_viewer", "smile_(expression)"],
        ):
            tags, _ = workspace._llm_tags(
                "qwen3.5-4b-ud-q4",
                Image.new("RGB", (16, 16)),
                {"replace_underscore": False, "escape_tag": False},
            )

        self.assertEqual(tags, ["looking_at_viewer", "smile_(expression)"])

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


class TaggerFrontendContractTests(unittest.TestCase):
    def test_workspace_uses_training_style_desktop_structure(self):
        template = (REPO_ROOT / "frontend" / "tagger-workspace.html").read_text(encoding="utf-8")
        css = (REPO_ROOT / "frontend" / "css" / "tagger.css").read_text(encoding="utf-8")
        tagger_js = (REPO_ROOT / "frontend" / "js" / "tagger.js").read_text(encoding="utf-8")
        self.assertIn("tagger-page-header", template)
        self.assertIn('class="page-header tagger-page-header"', template)
        self.assertIn('class="page-title"', template)
        self.assertIn('class="monitor-page-heading"', template)
        self.assertIn('id="taggerResbar"', template)
        self.assertIn("monitor-resbar tagger-page-resbar", template)
        self.assertIn("_renderResourceBar('taggerResbar'", tagger_js)
        self.assertIn("tagger-mode-tabs", template)
        self.assertIn("tagger-batch-layout", template)
        self.assertIn("tagger-form-card", template)
        self.assertIn("tagger-field-info", template)
        self.assertIn("tagger-action-panel", template)
        self.assertIn("tagger-single-layout", template)
        self.assertIn("tagger-single-preview", template)
        self.assertIn("tagger-category-settings", template)
        self.assertIn("tagger-category-browser", template)
        self.assertNotIn("anima-select-compact", template)
        self.assertIn("stepper tagger-field-stepper", template)
        self.assertIn("tagger-conflict-select", template)
        self.assertIn("taggerConflictSelectConfig", tagger_js)
        self.assertNotIn("tagger-choice-group", template)
        self.assertNotIn("<select", template)
        self.assertEqual(template.count('x-effect="value = taggerSelectedModel"'), 2)
        self.assertIn("localStorage.getItem('anima-tagger-model')", tagger_js)
        self.assertIn("this.taggerModels[0] ? this.taggerModels[0].id : ''", tagger_js)
        self.assertIn("localStorage.setItem('anima-tagger-model'", tagger_js)
        self.assertIn("taggerSourceMode === 'folder'", template)
        self.assertIn("taggerSourceMode === 'single'", template)
        self.assertIn("taggerIsLlm()", template)
        self.assertIn("taggerUsesCategoryThresholds()", template)
        self.assertIn("tagger-category-customize", template)
        self.assertNotIn("tagger-category-table-head", template)
        self.assertIn("tagger-category-field", template)
        self.assertIn("tagger-category-controls", template)
        self.assertIn("tagger-category-enable", template)
        self.assertIn("adjustTaggerCategoryThreshold", tagger_js)
        self.assertIn("taggerUsesCategoryThresholds() && taggerThresholdsOpen", template)
        self.assertIn("tagger-action-log", template)
        self.assertIn("tagger-log-stream", template)
        self.assertIn("taggerVisibleLogs", tagger_js)
        self.assertIn("taggerLogLines", tagger_js)
        self.assertIn("taggerRuntime?.logs", tagger_js)
        llama_runtime = (REPO_ROOT / "backend" / "tagger" / "llama_runtime.py").read_text(encoding="utf-8")
        self.assertIn('"chat_template_kwargs": {"enable_thinking": False}', llama_runtime)
        self.assertIn('"reasoning_effort": "none"', llama_runtime)
        self.assertIn("taggerLogTone", tagger_js)
        self.assertIn("taggerLogTime", tagger_js)
        self.assertIn("tagger.logsEmpty", template)
        self.assertIn('@input="scheduleTaggerSourceScan()"', template)
        self.assertIn("scheduleTaggerSourceScan", tagger_js)
        self.assertIn("_taggerSourceScanVersion", tagger_js)
        self.assertIn("taggerTaskProgressText", template)
        self.assertIn("formatTaggerDownloadSpeed", template)
        self.assertIn("taggerTask?.filename", template)
        self.assertIn("taggerPresetDescription", tagger_js)
        self.assertLess(
            tagger_js.index("if (this.taggerIsLlm())", tagger_js.index("taggerPresetDescription(preset)")),
            tagger_js.index("if (preset === 'custom')", tagger_js.index("taggerPresetDescription(preset)")),
        )
        self.assertIn("modelVramFact", tagger_js)
        self.assertIn("modelDownloadFact", tagger_js)
        self.assertIn("toggleTaggerResultCategory(key)", template)
        self.assertIn("updateTaggerResultCategory(key)", template)
        self.assertIn("taggerSettings.lowVram", template)
        self.assertIn("taggerSettings.maxTags", template)
        self.assertIn('x-model="taggerSettings.prompt"', template)
        self.assertIn("markTaggerPromptCustom", tagger_js)
        self.assertIn("taggerPromptPresets", tagger_js)
        self.assertIn("tagger-runtime-row", template)
        self.assertIn("preloadTaggerRuntime", tagger_js)
        self.assertIn("releaseTaggerRuntime", tagger_js)
        self.assertIn("x-model=\"taggerResultText\" readonly", template)
        self.assertNotIn("['concise'", tagger_js)
        self.assertIn("taggerSettings.replaceUnderscore", template)
        self.assertIn("taggerSettings.escapeTag", template)
        self.assertNotIn('label x-show="!taggerIsLlm()"><span><b x-text="t(\'tagger.replaceUnderscore\')', template)
        self.assertNotIn('label x-show="!taggerIsLlm()"><span><b x-text="t(\'tagger.escapeTag\')', template)
        self.assertIn("taggerSettings.removeDuplicated", template)
        self.assertIn("taggerSettings.addRatingTag", template)
        self.assertIn("taggerSettings.addModelTag", template)
        self.assertIn("category_thresholds", tagger_js)
        self.assertIn("add_model_tag", tagger_js)
        self.assertIn("TAGGER_CAMIE_CATEGORIES", tagger_js)
        self.assertIn("TAGGER_CL_CATEGORIES", tagger_js)
        self.assertNotIn("tagger-commandbar", template)
        self.assertNotIn("tagger-filmstrip", template)
        self.assertNotIn("tagger-inline-disclosure", template)
        self.assertNotIn("tagger-log-card", template)
        self.assertNotIn("linear-gradient", css)
        self.assertNotIn("border-radius: 8", css)
        self.assertNotIn("Q5", template)
        self.assertIn("grid-template-columns: minmax(0, 1fr) clamp(540px, 36vw, 680px)", css)
        self.assertIn(".tagger-field-control > .anima-select { width: 200px", css)
        self.assertIn(".tagger-option-grid > label { display: flex", css)
        self.assertIn("margin: 0; padding: 9px 10px; overflow: hidden", css)
        self.assertIn(".tagger-form-card { border: 0", css)
        self.assertIn("background: transparent", css)
        self.assertIn(".tagger-single-layout", css)


if __name__ == "__main__":
    unittest.main()
