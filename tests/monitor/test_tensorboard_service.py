"""Integration checks against the venv's actual TensorBoard, without training."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from backend.tensorboard_service import TensorBoardService
from backend import tensorboard_service
from backend.server import proxy


class TensorBoardServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_start_preserves_matching_user_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            saved = root / "anima-tensorboard-export" / "events.backup"
            saved.parent.mkdir()
            saved.write_text("user data", encoding="utf-8")
            with patch.object(tensorboard_service, "ROOT", root):
                service = TensorBoardService()
                service.start(enabled=False)
            self.assertEqual(saved.read_text(encoding="utf-8"), "user data")
            self.assertEqual(service.status(), "disabled")

    async def test_handshake_location_and_cleanup_across_startup_outcomes(self):
        for outcome in ("ready", "failed", "cancelled"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                log_path = root / "custom-logs" / "tb.log"
                log_path.parent.mkdir()
                unrelated = log_path.parent / ".tensorboard-endpoint-unrelated.txt"
                unrelated.write_text("another instance", encoding="utf-8")
                saved = root / "anima-tensorboard-export"
                saved.mkdir()
                process = Mock()
                process.poll.return_value = 1 if outcome == "failed" else None
                published = []
                launched = asyncio.Event()

                def launch(command, **kwargs):
                    endpoint = Path(command[3])
                    published.extend((endpoint, Path(str(endpoint) + ".tmp")))
                    target = published[0] if outcome == "ready" else published[1]
                    target.write_text("http://127.0.0.1:12345/tensorboard/", encoding="utf-8")
                    launched.set()
                    return process

                client = Mock()
                client.get = AsyncMock(return_value=Mock())
                client.aclose = AsyncMock()
                service = TensorBoardService()
                # Simulate tempfile falling back to the project root. The
                # service must still use the explicitly selected log directory.
                with patch.object(tensorboard_service, "ROOT", root), \
                     patch.object(tempfile, "tempdir", str(root)), \
                     patch.object(tensorboard_service.subprocess, "Popen", side_effect=launch), \
                     patch.object(httpx, "AsyncClient", return_value=client):
                    try:
                        service.start(log_path=log_path)
                        await asyncio.wait_for(launched.wait(), 5)
                        if outcome != "cancelled":
                            await service.wait_started()
                            self.assertEqual(service.status(), outcome, service.error)
                            self.assertTrue(all(not path.exists() for path in published))
                    finally:
                        await service.stop()
                self.assertEqual(published[0].parent, log_path.parent)
                self.assertTrue(all(not path.exists() for path in published))
                self.assertEqual(unrelated.read_text(encoding="utf-8"), "another instance")
                self.assertTrue(saved.is_dir())
                self.assertFalse(list(root.glob(".tensorboard-endpoint-*")))

    async def test_interactive_count_data_uses_exact_latest_integer_bins(self):
        import numpy as np
        from torch.utils.tensorboard import SummaryWriter
        from tools.python_startup.training_metrics import TrainingMetrics

        with tempfile.TemporaryDirectory() as tmp:
            run = "counts-日本語 & test"
            state = TrainingMetrics(grad_norm=False)
            state.timestep_counts = np.zeros(1000, dtype=np.int64)
            with SummaryWriter(str(Path(tmp) / run)) as writer:
                for index, step in enumerate((3, 3, 4), 1):
                    state.timestep_counts[123] += 2
                    state.timestep_counts[999] = 2**25 + index
                    state.distribution_dirty = True
                    state.write_distribution(writer, step)
            service = TensorBoardService()
            try:
                service.start(logdir=tmp, log_path=Path(tmp) / "tb.log")
                await service.wait_started()
                self.assertEqual(service.status(), "ready", service.error)
                html = await service.client.get("/tensorboard/")
                self.assertIn('/tensorboard/data/plugin/anima_timesteps/index.js', html.text)
                script = await service.client.get("/tensorboard/data/plugin/anima_timesteps/index.js")
                self.assertEqual(script.status_code, 200)
                self.assertIn("barPath", script.text)
                plugins = await service.client.get("/tensorboard/data/plugins_listing")
                self.assertFalse(plugins.json()["anima_timesteps"]["enabled"])
                runs = await service.client.get("/tensorboard/data/plugin/anima_timesteps/runs")
                self.assertEqual(runs.json(), [run])
                response = await service.client.get("/tensorboard/data/plugin/anima_timesteps/distribution", params={"run":run})
                self.assertEqual(response.status_code, 200, response.text)
                data = response.json()
                self.assertEqual(data["step"], 4)
                self.assertEqual(data["counts"][123], 6)
                self.assertEqual(data["counts"][999], 2**25 + 3)
                self.assertEqual(data["total"], 2**25 + 9)
                self.assertEqual(len(data["counts"]), 1000)
                missing = await service.client.get("/tensorboard/data/plugin/anima_timesteps/distribution", params={"run":"missing"})
                self.assertEqual(missing.status_code, 404)
            finally:
                await service.stop()

    async def test_two_instances_proxy_assets_and_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            services = [TensorBoardService(), TensorBoardService()]
            processes = []
            try:
                for i, service in enumerate(services):
                    service.start(logdir=tmp, log_path=Path(tmp) / f"tb-{i}.log")
                await asyncio.wait_for(asyncio.gather(*(s.wait_started() for s in services)), 70)
                for service in services:
                    self.assertEqual(service.status(), "ready", service.error)
                    self.assertEqual(service.client.base_url.host, "127.0.0.1")
                    processes.append(service.process)
                self.assertNotEqual(services[0].client.base_url.port, services[1].client.base_url.port)
                app = FastAPI()
                app.include_router(proxy.router)
                app.add_middleware(GZipMiddleware, minimum_size=1024)
                with patch.object(proxy, "service", services[0]):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                 base_url="http://localhost:18888") as browser:
                        for path, content_type in [
                            ("/tensorboard/", "text/html"),
                            ("/tensorboard/index.js", "javascript"),
                            ("/tensorboard/data/environment", "application/json"),
                            ("/tensorboard/data/plugins_listing", "application/json"),
                            ("/tensorboard/data/runs", "application/json"),
                        ]:
                            response = await browser.get(path)
                            self.assertEqual(response.status_code, 200, path)
                            self.assertIn(content_type, response.headers["content-type"])
                            self.assertTrue(response.content)
                        response = await browser.get("/tensorboard/images", follow_redirects=True)
                        self.assertEqual(response.url.path, "/tensorboard/")
                        self.assertEqual(response.url.port, 18888)
                        self.assertEqual(response.status_code, 200)
                # A fixed occupied port must fail, never attach to the other instance.
                conflict = TensorBoardService()
                try:
                    conflict.start(port=services[0].client.base_url.port, logdir=tmp,
                                   log_path=Path(tmp) / "conflict.log")
                    await asyncio.wait_for(conflict._task, 70)
                    self.assertEqual(conflict.status(), "failed")
                    self.assertIsNone(conflict.client)
                    self.assertIsNone(conflict.process)
                    self.assertTrue((Path(tmp) / "conflict.log").stat().st_size)
                finally:
                    await conflict.stop()
                services[0].process.terminate()
                await asyncio.to_thread(services[0].process.wait, timeout=10)
                self.assertEqual(services[0].status(), "failed")
            finally:
                for service in services:
                    await service.stop()
            self.assertTrue(all(p.poll() is not None for p in processes))
