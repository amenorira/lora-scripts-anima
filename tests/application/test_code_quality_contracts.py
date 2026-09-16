import asyncio
import builtins
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.server.routes import environment
from backend.server.routes import training as training_routes
from backend.tagger.interrogators import base


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


if __name__ == "__main__":
    unittest.main()
