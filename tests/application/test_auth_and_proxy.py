from base64 import b64encode
from contextlib import closing
import hashlib
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import DEFAULT, MagicMock, patch

from fastapi.testclient import TestClient
import httpx
from starlette.datastructures import MutableHeaders, URL
from starlette.websockets import WebSocketDisconnect

from backend import gui, launch_utils
from backend.server import application, auth, proxy
from backend.server.routes import realtime
from tools import ensure_runtime


class AuthHealthzAndWsTokenTests(unittest.TestCase):
    def test_anima_ui_entry_redirects_to_root_while_assets_still_serve(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            os.environ.pop("ANIMA_ROOT_PATH", None)
            app = runpy.run_path(application.__file__)["app"]
            with closing(TestClient(app)) as client:
                for entry in ("/anima-ui", "/anima-ui/", "/anima-ui/index.html"):
                    resp = client.get(entry, follow_redirects=False)
                    self.assertEqual(resp.status_code, 307, entry)
                    self.assertEqual(resp.headers["location"], "/", entry)

                q_resp = client.get("/anima-ui/?tab=train", follow_redirects=False)
                self.assertEqual(q_resp.status_code, 307)
                self.assertEqual(q_resp.headers["location"], "/?tab=train")

                asset = client.get("/anima-ui/js/shared/net.js")
                self.assertEqual(asset.status_code, 200)

        with patch.dict(os.environ, ANIMA_ROOT_PATH="/proxy/12333"):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            app_proxy = runpy.run_path(application.__file__)["app"]
            with closing(TestClient(app_proxy)) as client:
                resp = client.get("/anima-ui/?view=monitor", follow_redirects=False)
                self.assertEqual(resp.status_code, 307)
                self.assertEqual(resp.headers["location"], "/proxy/12333/?view=monitor")

                asset = client.get("/anima-ui/js/shared/net.js")
                self.assertEqual(asset.status_code, 200)

    def test_anima_ui_entry_prefers_asgi_scope_root_path_without_env(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            os.environ.pop("ANIMA_ROOT_PATH", None)
            app = runpy.run_path(application.__file__)["app"]
            with closing(TestClient(app, root_path="/proxy/12333")) as client:
                for path in ("/proxy/12333/anima-ui/?lang=zh", "/anima-ui/?lang=zh"):
                    resp = client.get(path, follow_redirects=False)
                    self.assertEqual(resp.status_code, 307, path)
                    self.assertEqual(resp.headers["location"], "/proxy/12333/?lang=zh", path)

                no_query = client.get("/proxy/12333/anima-ui", follow_redirects=False)
                self.assertEqual(no_query.status_code, 307)
                self.assertEqual(no_query.headers["location"], "/proxy/12333/")

        with patch.dict(os.environ, ANIMA_ROOT_PATH="/env/fallback"):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            app_env = runpy.run_path(application.__file__)["app"]
            with closing(TestClient(app_env, root_path="/proxy/12333/")) as client:
                resp = client.get("/anima-ui/?lang=zh", follow_redirects=False)
                self.assertEqual(resp.status_code, 307)
                self.assertEqual(resp.headers["location"], "/proxy/12333/?lang=zh")

class CachePolicyAndStaticRootTests(unittest.TestCase):
    def test_frontend_dir_is_anchored_independently_of_cwd(self):
        expected = Path(application.__file__).resolve().parent.parent.parent / "frontend"
        self.assertEqual(application.FRONTEND_DIR, expected)
        self.assertTrue((application.FRONTEND_DIR / "index.html").is_file())


class RootPathAndProxyTests(unittest.TestCase):
    def test_normalize_root_path(self):
        cases = [
            (None, ""),
            ("", ""),
            ("/", ""),
            ("///", ""),
            ("proxy/12333", "/proxy/12333"),
            ("/proxy/12333/", "/proxy/12333"),
            ("  /proxy/12333/// ", "/proxy/12333"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(gui.normalize_root_path(raw), expected)

    def test_tensorboard_legacy_redirect_prepends_root_path(self):
        with patch.dict(os.environ, ANIMA_ROOT_PATH="/proxy/12333/"):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            app = runpy.run_path(application.__file__)["app"]
            with closing(TestClient(app)) as client:
                resp = client.get("/tensorboard", follow_redirects=False)
                self.assertEqual(resp.status_code, 307)
                self.assertEqual(resp.headers["location"], "/proxy/12333/tensorboard/")

                legacy = client.get("/proxy/tensorboard/data?foo=1", follow_redirects=False)
                self.assertEqual(legacy.status_code, 307)
                self.assertEqual(legacy.headers["location"], "/proxy/12333/tensorboard/data?foo=1")

    def test_tensorboard_forward_rewrites_location_with_root_path(self):
        captured_urls = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured_urls.append(request.url.path)
            if request.url.path.endswith("/tensorboard/rel"):
                return httpx.Response(302, headers={"Location": "/runs#scalars"}, stream=httpx.ByteStream(b""))
            if request.url.path.endswith("/tensorboard/prefixed"):
                return httpx.Response(
                    302,
                    headers={"Location": "http://127.0.0.1:6006/proxy/12333/tensorboard/runs?b=2#tab"},
                    stream=httpx.ByteStream(b""),
                )
            return httpx.Response(
                302,
                headers={"Location": "http://127.0.0.1:6006/tensorboard/runs?a=1#tab"},
                stream=httpx.ByteStream(b""),
            )

        fake_client = httpx.AsyncClient(
            base_url="http://127.0.0.1:6006/",
            transport=httpx.MockTransport(handler),
        )
        with patch.dict(os.environ, ANIMA_ROOT_PATH="/proxy/12333"):
            os.environ.pop("ANIMA_AUTH_DIGEST", None)
            app = runpy.run_path(application.__file__)["app"]
            with (
                patch.object(proxy.service, "status", return_value="ready"),
                patch.object(proxy.service, "client", fake_client),
                closing(TestClient(app, root_path="/proxy/12333")) as client,
            ):
                r1 = client.get("/tensorboard/abs", follow_redirects=False)
                self.assertEqual(r1.status_code, 302)
                self.assertEqual(r1.headers["location"], "/proxy/12333/tensorboard/runs?a=1#tab")

                r2 = client.get("/tensorboard/rel", follow_redirects=False)
                self.assertEqual(r2.status_code, 302)
                self.assertEqual(r2.headers["location"], "/proxy/12333/tensorboard/runs#scalars")

                r3 = client.get("/tensorboard/prefixed", follow_redirects=False)
                self.assertEqual(r3.status_code, 302)
                self.assertEqual(r3.headers["location"], "/proxy/12333/tensorboard/runs?b=2#tab")

        # Upstream TensorBoard is started with --path_prefix=/proxy/12333/tensorboard.
        self.assertEqual(
            captured_urls,
            [
                "/proxy/12333/tensorboard/abs",
                "/proxy/12333/tensorboard/rel",
                "/proxy/12333/tensorboard/prefixed",
            ],
        )


class GuiStartupHardeningTests(unittest.TestCase):
    def _launch_with_mocks(self, cli_args, *, port_available=True, fallback_port=30001, env=None):
        import backend.constants as constants

        args = gui.build_parser().parse_args(["--skip-prepare-environment", *cli_args])
        base_env = env or {}
        try:
            with (
                patch.dict(os.environ, base_env, clear=False),
                patch("backend.user_defaults.ensure_user_defaults"),
                patch.object(gui, "app_version", return_value="test"),
                patch.multiple(
                    gui,
                    show_step=DEFAULT,
                    finish_step=DEFAULT,
                    check_environment=DEFAULT,
                    _report_optional_accelerators=DEFAULT,
                ),
                patch.object(gui, "check_port_available", return_value=port_available),
                patch.object(gui, "find_available_ports", return_value=fallback_port) as finder,
                patch("uvicorn.run") as serve,
            ):
                gui.launch(args)
                return serve, finder, dict(os.environ)
        finally:
            constants.refresh_storage_paths()

    def test_strict_port_and_explicit_port_fail_fast(self):
        for cli_args, env in (
            (["--strict-port"], {}),
            (["--port", "12333"], {}),
            ([], {"ANIMA_STRICT_PORT": "1"}),
        ):
            with self.subTest(cli_args=cli_args, env=env):
                with self.assertRaises(SystemExit) as raised:
                    self._launch_with_mocks(cli_args, port_available=False, env=env)
                self.assertEqual(raised.exception.code, 1)

    def test_default_port_still_falls_back_when_occupied(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANIMA_STRICT_PORT", None)
            serve, finder, env_after = self._launch_with_mocks([], port_available=False, fallback_port=30005)
        finder.assert_called_once_with(30000, 30020)
        self.assertEqual(serve.call_args.kwargs["port"], 30005)
        self.assertEqual(env_after["ANIMA_PORT"], "30005")

class RequirementsAndRuntimeSyncTests(unittest.TestCase):
    def test_check_requirements_excludes_onnxruntime_gpu(self):
        installed_calls = []

        def fake_is_installed(req: str) -> bool:
            installed_calls.append(req)
            return not req.startswith(("onnxruntime-gpu", "tqdm"))

        with (
            patch.object(launch_utils, "is_installed", side_effect=fake_is_installed),
            patch.object(launch_utils, "run_pip") as run_pip_mock,
        ):
            launch_utils.check_requirements()

        self.assertFalse(any("onnxruntime" in req for req in installed_calls))
        pip_commands = [call.args[0] for call in run_pip_mock.call_args_list]
        self.assertFalse(any("onnxruntime" in cmd for cmd in pip_commands))
        self.assertTrue(any("tqdm" in cmd for cmd in pip_commands))

    def test_ensure_runtime_skip_sync_keeps_compatible_cuda_torch(self):
        with (
            patch.object(ensure_runtime, "_probe_cuda_torch", return_value=("2.9.1+cu128", "12.8")),
            patch.object(ensure_runtime, "pip") as pip_mock,
        ):
            rc = ensure_runtime.main(["--skip-runtime-sync"])
        self.assertEqual(rc, 0)
        pip_mock.assert_not_called()

        with (
            patch.dict(os.environ, ANIMA_SKIP_RUNTIME_SYNC="1"),
            patch.object(ensure_runtime, "_probe_cuda_torch", return_value=("2.10.0+cu126", "12.6")),
            patch.object(ensure_runtime, "pip") as pip_mock,
        ):
            rc = ensure_runtime.main([])
        self.assertEqual(rc, 0)
        pip_mock.assert_not_called()

    def test_ensure_runtime_skip_sync_still_upgrades_old_or_cpu_torch(self):
        for probe in (("2.8.0+cu124", "12.4"), ("2.9.1+cpu", None)):
            with (
                self.subTest(probe=probe),
                patch.object(ensure_runtime, "_probe_cuda_torch", return_value=probe),
                patch.object(ensure_runtime, "package_version", return_value=probe[0]),
                patch.object(ensure_runtime, "pip", return_value=0) as pip_mock,
                patch.object(ensure_runtime, "sync_triton"),
                patch.object(ensure_runtime, "sync_optional_packages", return_value=[]),
            ):
                rc = ensure_runtime.main(["--skip-runtime-sync"])
            self.assertEqual(rc, 0)
            pip_mock.assert_called_once()

    def test_ensure_runtime_pip_prefers_uv_and_falls_back_to_pip(self):
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", return_value=0) as run_mock,
        ):
            os.environ.pop("ANIMA_NO_UV", None)
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 1)
        cmd = run_mock.call_args.args[0]
        self.assertEqual(cmd[:4], ["/usr/local/bin/uv", "pip", "install", "--python"])

        # Fallback to pip when uv fails
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", side_effect=[1, 0]) as run_mock,
        ):
            os.environ.pop("ANIMA_NO_UV", None)
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 2)
        self.assertEqual(run_mock.call_args_list[1].args[0][1:3], ["-m", "pip"])

        # ANIMA_NO_UV=1 bypasses uv completely
        with (
            patch.dict(os.environ, ANIMA_NO_UV="1"),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", return_value=0) as run_mock,
        ):
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 1)
        self.assertEqual(run_mock.call_args.args[0][1:3], ["-m", "pip"])


if __name__ == "__main__":
    unittest.main()
