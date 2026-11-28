"""Own the internal TensorBoard process; only /tensorboard/ is public."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from backend.constants import CACHE_DIR, LOGS_DIR, OUTPUT_DIR, REPO_ROOT, get_root_path

PREFIX = "/tensorboard"
ROOT = REPO_ROOT


def _path_prefix() -> str:
    return f"{get_root_path()}{PREFIX}"


class TensorBoardService:
    def __init__(self):
        self.process = None
        self.client = None
        self.state = "disabled"
        self.error = ""
        self._task = None
        self._endpoint = None

    def start(self, *, enabled=True, port=0, logdir=None, log_path=None):
        self.error = ""
        if not enabled:
            self.state = "disabled"
            return
        self.state = "starting"
        self._task = asyncio.create_task(self._start(port, logdir, log_path))

    async def _start(self, port, logdir, log_path):
        import httpx
        from backend.log import log

        try:
            log_path = Path(log_path or LOGS_DIR / "tensorboard.log")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            # Keep the atomic endpoint handshake on local CACHE_DIR rather than
            # a potentially FUSE/network LOGS_DIR, cleaning up only our own path.
            endpoint_dir = CACHE_DIR / "tensorboard"
            endpoint_dir.mkdir(parents=True, exist_ok=True)
            fd, endpoint_name = tempfile.mkstemp(
                prefix=".tensorboard-endpoint-", suffix=".txt", dir=endpoint_dir
            )
            os.close(fd)
            os.unlink(endpoint_name)
            endpoint = Path(endpoint_name)
            self._endpoint = endpoint
            tb_prefix = _path_prefix()
            # The child inherits its own handle; the parent need not retain it.
            with log_path.open("ab", buffering=0) as output:
                self.process = subprocess.Popen(
                    [sys.executable, "-m", "backend.tensorboard_service", str(endpoint),
                     str(port), str(logdir or OUTPUT_DIR)],
                    cwd=REPO_ROOT, stdout=output, stderr=subprocess.STDOUT,
                )
            deadline = asyncio.get_running_loop().time() + 60
            while asyncio.get_running_loop().time() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError(f"TensorBoard exited ({self.process.returncode})")
                if endpoint.exists():
                    if self.client is None:
                        self.client = httpx.AsyncClient(
                            base_url=httpx.URL(endpoint.read_text(encoding="utf-8")).copy_with(path="/"),
                            trust_env=False,
                            timeout=httpx.Timeout(120, connect=5, pool=10),
                            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                        )
                    try:
                        response = await self.client.get(tb_prefix + "/data/environment", timeout=2)
                        response.raise_for_status()
                        response.json()
                        self._cleanup_endpoint()
                        self.state = "ready"
                        log.info("TensorBoard internal URL: %s", self.client.base_url,
                                 extra={"console": False})
                        return
                    except httpx.HTTPError:
                        pass
                await asyncio.sleep(0.25)
            raise RuntimeError("TensorBoard startup timed out (60s)")
        except Exception as exc:
            self.state = "failed"
            self.error = f"{exc}. See logs/tensorboard.log / 请查看 logs/tensorboard.log"
            log.warning("TensorBoard unavailable / TensorBoard 不可用: %s", self.error)
            await self._cleanup()

    async def wait_started(self):
        """Wait for the bounded startup attempt, including failure cleanup."""
        if self._task is not None:
            await self._task

    def status(self):
        if self.state == "ready" and self.process.poll() is not None:
            self.state = "failed"
            self.error = "TensorBoard exited / TensorBoard 已退出。See logs/tensorboard.log"
        return self.state

    async def _cleanup(self):
        if self.client is not None:
            await self.client.aclose()
            self.client = None
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    await asyncio.to_thread(self.process.wait, timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    await asyncio.to_thread(self.process.wait)
            self.process = None
        self._cleanup_endpoint()

    def _cleanup_endpoint(self):
        if self._endpoint is None:
            return
        # The child may have stopped between writing the URL and replacing the
        # final file. Remove that instance's pending publication as well.
        for path in (self._endpoint, Path(str(self._endpoint) + ".tmp")):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        self._endpoint = None

    async def stop(self):
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._cleanup()
        self.state = "disabled"


service = TensorBoardService()


def _serve():
    """TensorBoard binds port 0 itself, then publishes its actual bound URL."""
    from tensorboard import default, program
    from backend.tensorboard_timesteps import TimestepPlugin, chart_assets_provider
    import threading

    endpoint, port, logdir = sys.argv[1:]
    tb_prefix = _path_prefix()
    board = program.TensorBoard(plugins=[*default.get_plugins(), TimestepPlugin],
                               assets_zip_provider=chart_assets_provider(tb_prefix))
    board.configure(argv=["tensorboard", "--host", "127.0.0.1", "--port", port,
                          "--logdir", logdir, "--path_prefix", tb_prefix])
    url = board.launch()
    # Atomic publication: the parent never observes a partial URL.
    pending = Path(endpoint + ".tmp")
    pending.write_text(url, encoding="utf-8")
    os.replace(pending, endpoint)
    threading.Event().wait()


if __name__ == "__main__":
    _serve()
