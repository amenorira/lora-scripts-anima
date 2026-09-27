import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from starlette.requests import ClientDisconnect

from backend.server import proxy


class TensorBoardProxyTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, handler, path="/tensorboard/", state="ready", **kwargs):
        app = FastAPI()
        app.include_router(proxy.router)
        async with httpx.AsyncClient(
            base_url="http://127.0.0.1:6006", transport=httpx.MockTransport(handler),
        ) as upstream:
            service = SimpleNamespace(client=upstream, status=lambda: state, error="test <failure>")
            with patch.object(proxy, "service", service):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="https://localhost:18888",
                ) as browser:
                    return await browser.request(kwargs.pop("method", "GET"), path, **kwargs)

    async def test_forward_preserves_path_query_body_and_filters_headers(self):
        def handler(request):
            self.assertEqual(str(request.url), "http://127.0.0.1:6006/tensorboard/data/test?run=a%2Fb")
            self.assertEqual(request.content, b"payload")
            self.assertNotIn("x-private", request.headers)
            return httpx.Response(200, stream=httpx.ByteStream(b"result"), headers={"connection": "x-private", "x-private": "secret"})
        response = await self.request(handler, "/tensorboard/data/test?run=a%2Fb", method="POST",
                                      content=b"payload", headers={"connection": "x-private", "x-private": "secret"})
        self.assertEqual(response.content, b"result")
        self.assertNotIn("x-private", response.headers)
        self.assertNotIn("connection", response.headers)

    async def test_redirects_stay_on_public_origin_and_prefix(self):
        for location, expected in [
            ("/", "/tensorboard/"),
            ("http://127.0.0.1:6006/tensorboard/?x=1#images", "/tensorboard/?x=1#images"),
            ("/tensorboard/?x=1", "/tensorboard/?x=1"),
            ("../notifications_note.json", "../notifications_note.json"),
        ]:
            with self.subTest(location=location):
                response = await self.request(lambda r: httpx.Response(302, stream=httpx.ByteStream(b""), headers={"Location": location}))
                self.assertEqual(response.headers["location"], expected)

    async def test_waiting_disabled_and_failed_pages(self):
        def unexpected(request):
            self.fail("Unavailable service must not receive requests")
        for state in ("starting", "disabled", "failed"):
            response = await self.request(unexpected, state=state)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual('http-equiv="refresh"' in response.text, state == "starting")
            self.assertIn("&lt;failure&gt;", response.text)

    async def test_network_errors_and_disconnect(self):
        for error, status in [(ClientDisconnect(), 499), (httpx.ConnectError("offline"), 503),
                              (httpx.ReadTimeout("slow"), 503), (httpx.PoolTimeout("busy"), 503)]:
            def handler(request):
                raise error
            response = await self.request(handler)
            self.assertEqual(response.status_code, status)

    async def test_old_bookmark_redirects_with_query(self):
        for path in ("/proxy/tensorboard/?x=1", "/proxy/tensorboard?x=1", "/tensorboard?x=1"):
            response = await self.request(lambda r: self.fail("must redirect locally"), path)
            self.assertEqual(response.status_code, 307)
            self.assertEqual(response.headers["location"], "/tensorboard/?x=1")
