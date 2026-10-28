"""Shared lifecycle for optional acceleration installers."""
from collections import deque
from collections.abc import Callable
import threading
import time
from uuid import uuid4

from backend.core.realtime import realtime_tasks
from backend.tasks import tm


class InstallJobs:
    def __init__(self, name: str):
        self.name = name
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def snapshot(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return {"done": True, "success": False, "error": "Task expired / 任务已过期"}
            return {"done": job["done"], "success": job.get("success"),
                    "status": ("finished" if job.get("success") else "error") if job["done"] else "running",
                    "progress": dict(job["progress"]), "lines": "\n".join(job["log"]),
                    "elapsed": time.time() - job["start"], "error": job.get("error")}

    async def start(self, installer: Callable[..., None], **options) -> dict:
        job_id = uuid4().hex[:12]
        owner = self.name + ":" + job_id
        if not tm.claim_external(owner):
            return {"success": False, "message": "Finish the active training or GPU task first / 请先结束正在运行的训练或 GPU 任务"}
        with self._lock:
            for expired in [key for key, job in self._jobs.items() if job["done"] and time.time() - job["start"] > 600]:
                del self._jobs[expired]
            self._jobs[job_id] = {"start": time.time(), "done": False, "progress": {}, "log": deque(maxlen=80)}

        def emit(**event):
            with self._lock:
                job = self._jobs[job_id]
                job["progress"].update({key: value for key, value in event.items() if key != "message"})
                if event.get("message"):
                    job["log"].append(str(event["message"]))

        def work():
            try:
                installer(emit, **options)
                with self._lock:
                    self._jobs[job_id]["success"] = True
            except Exception as exc:
                emit(stage="error", message=str(exc))
                with self._lock:
                    self._jobs[job_id].update(success=False, error=str(exc))
            finally:
                tm.release_external(owner)
                with self._lock:
                    self._jobs[job_id]["done"] = True

        try:
            await realtime_tasks.register(job_id, self.name + "-install", lambda: self.snapshot(job_id))
            threading.Thread(target=work, daemon=True).start()
        except BaseException:
            tm.release_external(owner)
            with self._lock:
                self._jobs.pop(job_id, None)
            raise
        return {"success": True, "job_id": job_id}
