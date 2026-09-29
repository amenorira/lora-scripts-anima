"""Integration checks against the venv's actual TensorBoard, without training."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from backend.tensorboard_service import TensorBoardService
from backend.server import proxy


class TensorBoardServiceTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_disable_and_cancel_startup(self):
        service = TensorBoardService()
        service.start(enabled=False)
        self.assertEqual(service.status(), "disabled")
        self.assertIsNone(service.process)
        with tempfile.TemporaryDirectory() as tmp:
            service.start(logdir=tmp, log_path=Path(tmp) / "cancel.log")
            await asyncio.sleep(0)
            process = service.process
            await service.stop()
            self.assertEqual(service.status(), "disabled")
            self.assertIsNone(service.client)
            self.assertIsNotNone(process)
            self.assertIsNotNone(process.poll())
