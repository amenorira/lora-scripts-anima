"""Own the internal TensorBoard process; only /tensorboard/ is public."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PREFIX = "/tensorboard"
ROOT = Path(__file__).resolve().parents[1]


class TensorBoardService:
    def __init__(self):
        self.process = None
        self.client = None
        self.state = "disabled"
        self.error = ""
        self._task = None
        self._directory = None

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
            self._directory = tempfile.TemporaryDirectory(prefix="anima-tensorboard-")
            endpoint = Path(self._directory.name) / "endpoint"
            log_path = Path(log_path or ROOT / "logs" / "tensorboard.log")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            # The child inherits its own handle; the parent need not retain it.
            with log_path.open("ab", buffering=0) as output:
                self.process = subprocess.Popen(
                    [sys.executable, "-m", "backend.tensorboard_service", str(endpoint),
                     str(port), str(logdir or ROOT / "output")],
                    cwd=ROOT, stdout=output, stderr=subprocess.STDOUT,
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
                        response = await self.client.get(PREFIX + "/data/environment", timeout=2)
                        response.raise_for_status()
                        response.json()
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
        if self._directory is not None:
            self._directory.cleanup()
            self._directory = None

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
    from tensorboard import program
    import threading

    endpoint, port, logdir = sys.argv[1:]
    board = program.TensorBoard()
    board.configure(argv=["tensorboard", "--host", "127.0.0.1", "--port", port,
                          "--logdir", logdir, "--path_prefix", PREFIX])
    url = board.launch()
    # Atomic publication: the parent never observes a partial URL.
    pending = Path(endpoint + ".tmp")
    pending.write_text(url, encoding="utf-8")
    os.replace(pending, endpoint)
    threading.Event().wait()


if __name__ == "__main__":
    _serve()
