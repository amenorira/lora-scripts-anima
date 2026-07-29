import asyncio
import builtins
import re
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.server import api
from backend.server.routes import environment
from backend.server.routes import training as training_routes
from backend.tagger.interrogators import base


REPO_ROOT = Path(__file__).resolve().parents[1]


class TrainingCoreStatusTests(unittest.TestCase):
    def test_runtime_probe_runs_outside_the_event_loop_thread(self):
        event_loop_thread = threading.get_ident()
        probe_threads = []

        def fake_profile_payload():
            probe_threads.append(threading.get_ident())
            return {"engines": [], "profiles": [], "adapters": []}

        with patch.object(training_routes, "profile_payload", side_effect=fake_profile_payload):
            asyncio.run(training_routes.training_cores())

        self.assertEqual(len(probe_threads), 1)
        self.assertNotEqual(probe_threads[0], event_loop_thread)


class ApiRouterContractTests(unittest.TestCase):
    """The aggregate router exposes commands and static status endpoints only."""

    expected_routes = {
        ("/health", ("GET",)),
        ("/version", ("GET",)),
        ("/fields", ("GET",)),
        ("/pick_file", ("GET",)),
        ("/get_files", ("GET",)),
        ("/tasks/terminate/{task_id}", ("GET",)),
        ("/graphic_cards", ("GET",)),
        ("/sd-scripts/status", ("GET",)),
        ("/interrogate", ("POST",)),
        ("/interrogate/stop", ("POST",)),
        ("/tagger/models", ("GET",)),
        ("/tagger/source/scan", ("POST",)),
        ("/tagger/uploads", ("POST",)),
        ("/tagger/thumbnails/{source_token}/{index}", ("GET",)),
        ("/tagger/source/{source_token}/items", ("GET",)),
        ("/tagger/source/{source_token}/{index}", ("GET",)),
        ("/tagger/captions/save", ("POST",)),
        ("/tagger/tasks", ("POST",)),
        ("/tagger/tasks/{task_id}/status", ("GET",)),
        ("/tagger/tasks/{task_id}/cancel", ("POST",)),
        ("/tagger/tasks/{task_id}/retry", ("POST",)),
        ("/tagger/tasks/{task_id}/items", ("GET",)),
        ("/tagger/tasks/active", ("GET",)),
        ("/tagger/single", ("POST",)),
        ("/anima-model/status", ("GET",)),
        ("/anima-model/download", ("POST",)),
        ("/docs", ("GET",)),
        ("/docs/assets/{asset_path:path}", ("GET",)),
        ("/docs/{slug}", ("GET",)),
        ("/flash-attention/status", ("GET",)),
        ("/flash-attention/install", ("POST",)),
        ("/xformers/status", ("GET",)),
        ("/xformers/install", ("POST",)),
        ("/triton/status", ("GET",)),
        ("/triton/install", ("POST",)),
    }

    def test_aggregate_router_keeps_route_paths_and_methods(self):
        actual_routes = {
            (route.path, tuple(sorted(route.methods)))
            for route in api.router.routes
        }
        self.assertEqual(actual_routes, self.expected_routes)


class EnvironmentJobCleanupTests(unittest.TestCase):
    def test_triton_version_range_tracks_pytorch_minor(self):
        self.assertEqual(environment._matching_triton_spec("2.9.1+cu128"), ">=3.5,<3.6")
        self.assertEqual(environment._matching_triton_spec("2.10.0+cu130"), ">=3.6,<3.7")
        self.assertEqual(environment._matching_triton_spec("2.12.0"), ">=3.7,<3.8")

    def test_prune_finished_jobs_keeps_active_and_unexpired_jobs(self):
        jobs = {
            "active": {"done": False, "start": 0},
            "at_ttl_boundary": {"done": True, "start": 1001},
            "expired": {"done": True, "start": 1000},
        }
        removed = []

        environment._prune_finished_jobs(
            jobs,
            threading.Lock(),
            lambda job: removed.append(job),
            now=1601,
        )

        self.assertEqual(set(jobs), {"active", "at_ttl_boundary"})
        self.assertEqual(removed, [{"done": True, "start": 1000}])

    def test_install_job_cleanup_callback_removes_log_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as file:
            log_path = Path(file.name)

        jobs = {
            "expired": {
                "done": True,
                "start": 0,
                "log_path": str(log_path),
            }
        }
        try:
            environment._prune_finished_jobs(
                jobs,
                threading.Lock(),
                environment._remove_install_job,
                now=environment._JOB_TTL_SECONDS + 1,
            )
            self.assertEqual(jobs, {})
            self.assertFalse(log_path.exists())
        finally:
            log_path.unlink(missing_ok=True)


class OnnxSessionFactoryTests(unittest.TestCase):
    def test_session_factory_lazily_loads_dependencies_with_cuda_defaults(self):
        calls = []
        imports = []

        class FakeSessionOptions:
            def __init__(self):
                self.log_severity_level = None

        class FakeInferenceSession:
            def __init__(self, model_path, *, providers, sess_options):
                calls.append({
                    "model_path": model_path,
                    "providers": providers,
                    "sess_options": sess_options,
                })

        fake_torch = types.ModuleType("torch")
        fake_onnxruntime = types.ModuleType("onnxruntime")
        fake_onnxruntime.InferenceSession = FakeInferenceSession
        fake_onnxruntime.SessionOptions = FakeSessionOptions
        real_import = builtins.__import__

        def trace_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name in {"torch", "onnxruntime"}:
                imports.append((name, tuple(fromlist or ())))
            return real_import(name, globals, locals, fromlist, level)

        with patch.dict(sys.modules, {"torch": fake_torch, "onnxruntime": fake_onnxruntime}), patch(
            "builtins.__import__", side_effect=trace_import
        ):
            session = base.create_onnx_session(Path("tagger.onnx"))

        self.assertIsInstance(session, FakeInferenceSession)
        self.assertIn(("torch", ()), imports)
        self.assertIn(("onnxruntime", ("InferenceSession",)), imports)
        self.assertIn(("onnxruntime", ("SessionOptions",)), imports)
        self.assertEqual(calls[0]["model_path"], "tagger.onnx")
        self.assertEqual(
            calls[0]["providers"],
            ["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.assertIsInstance(calls[0]["sess_options"], FakeSessionOptions)
        self.assertEqual(calls[0]["sess_options"].log_severity_level, 3)


class FrontendMixinCleanupContractTests(unittest.TestCase):
    def test_training_preview_toggle_is_scoped_to_training_routes(self):
        app_source = (REPO_ROOT / "frontend/js/app.js").read_text(encoding="utf-8")
        index_source = (REPO_ROOT / "frontend/index.html").read_text(encoding="utf-8")
        css_source = (REPO_ROOT / "frontend/css/app.css").read_text(encoding="utf-8")

        show_panel_body = app_source.split("showRightPanel() {", 1)[1].split("\n    },", 1)[0]
        self.assertIn("r.startsWith('train-')", show_panel_body)
        self.assertNotIn("r === 'tools'", show_panel_body)
        self.assertIn('class="panel-backdrop" x-show="showRightPanel()"', index_source)
        self.assertNotIn(".panel-toggle-btn {\n    display: flex !important;", css_source)

    def test_effective_show_if_handler_is_defined_once_with_current_semantics(self):
        training_core = (REPO_ROOT / "frontend/js/training-core.js").read_text(encoding="utf-8")
        training_toml = (REPO_ROOT / "frontend/js/training-toml.js").read_text(encoding="utf-8")

        definition = r"^\s*_evalShowIfCond\(c\)\s*\{"
        self.assertEqual(len(re.findall(definition, training_core, re.MULTILINE)), 1)
        self.assertEqual(len(re.findall(definition, training_toml, re.MULTILINE)), 0)

        handler_body = training_core.split("_evalShowIfCond(c) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("pv !== ''", handler_body)
        self.assertNotIn("String(pv) !== ''", handler_body)

    def test_removed_mixin_members_have_no_remaining_source_references(self):
        frontend_sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (REPO_ROOT / "frontend/js").glob("*.js")
        )
        monitor_core = (REPO_ROOT / "frontend/js/monitor-core.js").read_text(encoding="utf-8")
        training_toml = (REPO_ROOT / "frontend/js/training-toml.js").read_text(encoding="utf-8")

        self.assertNotIn("_teResetModifiedCount", frontend_sources)
        self.assertNotIn("_taggerPresetInitialized", frontend_sources)
        self.assertEqual(
            len(re.findall(r"^\s*async stopTraining\(\)\s*\{", monitor_core, re.MULTILINE)),
            0,
        )
        self.assertEqual(
            len(re.findall(r"^\s*async stopTraining\(\)\s*\{", training_toml, re.MULTILINE)),
            1,
        )


if __name__ == "__main__":
    unittest.main()
