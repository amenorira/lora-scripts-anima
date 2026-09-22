
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase, mock

from tools import install_flash_attn


class _FakeResp:
    def __init__(self, status: int = 200, chunks=()) -> None:
        self.status = status
        self._chunks = iter(chunks)

    def read(self, size: int = -1) -> bytes:
        try:
            return next(self._chunks)
        except StopIteration:
            return b""

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_args) -> None:
        return None


class FlashAttnInstallerTests(TestCase):
    @mock.patch.object(install_flash_attn.importlib.metadata, "version", return_value="2.8.3")
    @mock.patch.object(install_flash_attn.subprocess, "run")
    def test_install_downloads_to_cache_then_pip_installs_local_file(
        self, run_mock: mock.Mock, _version_mock: mock.Mock
    ) -> None:
        wheel_url = "https://github.com/example/releases/download/v1/flash_attn.whl"
        local = Path(tempfile.mkdtemp()) / "flash_attn-2.8.3+cu130torch2.10-cp312-cp312-win_amd64.whl"
        run_mock.return_value = subprocess.CompletedProcess([], 0, stdout="installed", stderr="")

        with mock.patch.object(install_flash_attn, "download_wheel", return_value=local) as dl_mock:
            result = install_flash_attn.install_wheel(wheel_url, source="default")

        self.assertTrue(result["installed"])
        dl_mock.assert_called_once_with(wheel_url, source="default")
        run_mock.assert_called_once()
        cmd = run_mock.call_args.args[0]
        self.assertIn(str(local), cmd)
        self.assertNotIn(wheel_url, cmd)

    @mock.patch.object(install_flash_attn.importlib.metadata, "version", return_value="2.8.3")
    @mock.patch.object(install_flash_attn.subprocess, "run")
    def test_install_uses_local_wheel_file_without_download(
        self, run_mock: mock.Mock, _version_mock: mock.Mock
    ) -> None:
        local = Path(tempfile.mkdtemp()) / "flash_attn_local.whl"
        local.write_bytes(b"x")
        run_mock.return_value = subprocess.CompletedProcess([], 0, stdout="installed", stderr="")

        with mock.patch.object(install_flash_attn, "download_wheel") as dl_mock:
            result = install_flash_attn.install_wheel(str(local), source="default")

        self.assertTrue(result["installed"])
        dl_mock.assert_not_called()
        self.assertIn(str(local), run_mock.call_args.args[0])

    @mock.patch.object(install_flash_attn, "_probe_size", return_value=2048)
    @mock.patch.object(install_flash_attn.urllib.request, "urlopen")
    def test_download_wheel_falls_back_to_next_source_on_timeout(
        self, urlopen_mock: mock.Mock, _probe_mock: mock.Mock
    ) -> None:
        urlopen_mock.side_effect = [
            TimeoutError("stalled / 无响应"),
            _FakeResp(status=200, chunks=(b"a" * 2048, b"")),
        ]

        dest = install_flash_attn.download_wheel(
            "https://github.com/example/releases/download/v1/flash_attn.whl",
            source="default",
            dest_dir=Path(tempfile.mkdtemp()),
        )

        self.assertTrue(dest.exists())
        self.assertEqual(dest.stat().st_size, 2048)
        self.assertEqual(urlopen_mock.call_count, 2)

    def test_download_wheel_reuses_complete_local_cache_without_network(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        dest = tmp / "flash_attn-2.8.3+cu130torch2.10-cp312-cp312-win_amd64.whl"
        dest.write_bytes(b"x" * 100)

        with mock.patch.object(install_flash_attn, "_probe_size", return_value=100), mock.patch.object(
            install_flash_attn.urllib.request, "urlopen"
        ) as urlopen_mock:
            result = install_flash_attn.download_wheel(
                "https://github.com/example/releases/download/v1/flash_attn-2.8.3%2Bcu130torch2.10-cp312-cp312-win_amd64.whl",
                source="default",
                dest_dir=tmp,
            )

        self.assertEqual(result, dest)
        urlopen_mock.assert_not_called()

    def test_fetch_candidates_marks_baseline_mismatch_unusable(self) -> None:
        env = {"python_tag": "cp311", "torch_tag": "torch2.9", "cuda_tag": "cu126", "platform": "win_amd64"}
        candidates, err = install_flash_attn.fetch_candidates(env, source="default")

        self.assertIsNone(err)
        self.assertFalse(candidates[0]["usable"])
        self.assertTrue(candidates[0]["notes"])


if __name__ == "__main__":
    import unittest

    unittest.main()
