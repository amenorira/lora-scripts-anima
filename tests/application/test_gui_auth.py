from base64 import b64encode
from contextlib import closing, redirect_stderr
from io import StringIO
import os
import runpy
import unittest
from unittest.mock import DEFAULT, patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import gui
from backend.server import application


class GuiAuthTests(unittest.TestCase):
    def test_invalid_credentials_fail_without_echoing_the_value(self):
        for value in ("", "private-value", "private-value:", ":private-value"):
            with self.subTest(value=value), redirect_stderr(StringIO()) as error:
                with self.assertRaises(SystemExit) as raised:
                    gui.build_parser().parse_args(["--auth", value])
                self.assertEqual(raised.exception.code, 2)
                self.assertIn("username:password", error.getvalue())
                self.assertNotIn("private-value", error.getvalue())

    def test_launch_bind_and_auth_settings(self):
        cases = [
            ([], "127.0.0.1", False),
            (["--listen"], "0.0.0.0", False),
            (["--host", "192.0.2.1"], "192.0.2.1", False),
            (["--auth", "user:secret"], "127.0.0.1", True),
            (["--listen", "--auth", "user:secret"], "0.0.0.0", True),
            (["--host", "192.0.2.1", "--auth", "user:secret", "--dev"], "192.0.2.1", True),
        ]
        for flags, host, authenticated in cases:
            args = gui.build_parser().parse_args(["--skip-prepare-environment", *flags])
            with (self.subTest(flags=flags), patch.dict(os.environ, ANIMA_AUTH_DIGEST="stale"),
                  patch("backend.user_defaults.ensure_user_defaults"),
                  patch.object(gui, "app_version", return_value="test"),
                  patch.multiple(gui, show_step=DEFAULT, finish_step=DEFAULT, check_environment=DEFAULT,
                                 check_port_available=DEFAULT, _report_optional_accelerators=DEFAULT),
                  patch("uvicorn.run") as serve):
                gui.launch(args)
                self.assertEqual(serve.call_args.kwargs["host"], host)
                self.assertEqual(os.environ["ANIMA_HOST"], host)
                self.assertEqual(serve.call_args.kwargs["reload"], "--dev" in flags)
                self.assertEqual(os.environ.get("ANIMA_AUTH_DIGEST"), args.auth_digest)
                self.assertEqual("ANIMA_AUTH_DIGEST" in os.environ, authenticated)

    def test_access_notice_uses_the_effective_host(self):
        for host in ("localhost", "127.0.0.1", "127.0.0.2", "::1"):
            self.assertIsNone(application._access_notice(host, False))
        for host in ("0.0.0.0", "::", "192.0.2.1", "trainer.lan"):
            self.assertIn("未启用认证", application._access_notice(host, False))
        self.assertIn("已启用认证", application._access_notice("127.0.0.1", True))

    def test_listen_without_auth_allows_normal_access(self):
        with patch.dict(os.environ, ANIMA_HOST="0.0.0.0"):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            app = runpy.run_path(application.__file__)["app"]
        with closing(TestClient(app)) as client:
            self.assertEqual(client.get("/").status_code, 200)
            self.assertEqual(client.get("/api/health").json()["status"], "ok")
            with client.websocket_connect("/ws/realtime") as socket:
                socket.send_json({"op": "hello"})
                self.assertEqual(socket.receive_json()["op"], "ready")

    def test_dev_auth_allows_cors_preflight_and_checks_api_credentials(self):
        args = gui.build_parser().parse_args(["--dev", "--auth", "user:secret"])
        origin = "http://localhost:3000"
        path = "/api/health"
        with patch.dict(os.environ, ANIMA_DEV="1", ANIMA_AUTH_DIGEST=args.auth_digest):
            app = runpy.run_path(application.__file__)["app"]
        with closing(TestClient(app)) as client:
            preflight = client.options(path, headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            })
            self.assertEqual(preflight.status_code, 200)
            self.assertEqual(preflight.headers["access-control-allow-origin"], origin)
            self.assertIn("authorization", preflight.headers["access-control-allow-headers"].lower())

            headers = {"Origin": origin}
            self.assertEqual(client.options(path, headers=headers).status_code, 401)
            denied = client.get(path, headers=headers)
            self.assertEqual(denied.status_code, 401)
            self.assertEqual(denied.headers["access-control-allow-origin"], origin)
            allowed = client.get(path, headers=headers, auth=("user", "secret"))
            self.assertEqual(allowed.status_code, 200)
            self.assertEqual(allowed.headers["access-control-allow-origin"], origin)
            self.assertEqual(allowed.headers["access-control-allow-credentials"], "true")

    def test_auth_protects_the_application_and_realtime_handshake(self):
        credential = "训练员:páss:word"
        args = gui.build_parser().parse_args(["--auth", credential])
        token = b64encode(credential.encode()).decode("ascii")
        headers = {"Authorization": "basic " + token}
        # Build a fresh app as a reload worker would, without starting training services.
        with patch.dict(os.environ, ANIMA_AUTH_DIGEST=args.auth_digest):
            app = runpy.run_path(application.__file__)["app"]
        with closing(TestClient(app)) as client:
            for path in ("/", "/anima-ui/index.html", "/api/docs", "/tensorboard/"):
                response = client.get(path)
                self.assertEqual(response.status_code, 401, path)
                self.assertIn('charset="UTF-8"', response.headers["WWW-Authenticate"])
            wrong = {"Authorization": "Basic " + b64encode(b"user:wrong").decode("ascii")}
            self.assertEqual(client.get("/", headers=wrong).status_code, 401)
            self.assertEqual(client.get("/", headers=headers).status_code, 200)
            self.assertEqual(client.get("/api/health", headers=headers).json()["status"], "ok")
            for rejected in ({}, wrong):
                with self.assertRaises(WebSocketDisconnect) as closed:
                    with client.websocket_connect("/ws/realtime", headers=rejected):
                        self.fail("The connection should have been denied")
                self.assertEqual(closed.exception.code, 1008)
            with client.websocket_connect("/ws/realtime", headers=headers) as socket:
                socket.send_json({"op": "hello"})
                self.assertEqual(socket.receive_json()["op"], "ready")
