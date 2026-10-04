"""Opt-in real GPU/backend restart check on an isolated localhost server.

Run with venv/Scripts/python.exe tools/dev/verify_regularization_recovery.py
Keeps the test orchestrator alive while crashing its backend child, so the
worker survives the backend exit even under Windows process-job containment.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import psutil
from PIL import Image


def main():
    repo = Path(__file__).resolve().parents[2]
    address = "http://127.0.0.1:12335"
    source = repo / "cache" / ("regularization_recovery_" + uuid.uuid4().hex[:8])
    subset = source / "1_face"
    subset.mkdir(parents=True)
    Image.new("RGB", (512, 512), "white").save(subset / "source.png")
    (subset / "source.txt").write_text("trigger, 1girl, blue hair, portrait, outdoors", encoding="utf-8")
    settings = dict(source_dir=str(source), dit=str(repo / "models/anima-base-v1.0.safetensors"),
                    text_encoder=str(repo / "models/qwen_3_06b_base.safetensors"), vae=str(repo / "models/qwen_image_vae.safetensors"),
                    size_mode="fixed", width=512, height=512, steps=32, cfg=4, per_image=3, seed=54321, ignore_first=1)
    env = dict(os.environ, ANIMA_DISABLE_TENSORBOARD="1", PYTHONUNBUFFERED="1")
    log = (source / "backend.log").open("ab")
    server = None
    worker = None

    def api(path, payload=None, allow_error=False):
        request = urllib.request.Request(address + "/api/regularization" + path,
                  data=json.dumps(payload).encode() if payload is not None else None,
                  headers={"Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = json.load(response)
        if allow_error:
            return result
        assert result["status"] == "success", result
        return result["data"]

    def boot():
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.server.application:app", "--host", "127.0.0.1", "--port", "12335"], cwd=repo, env=env, stdout=log, stderr=log)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Test backend failed to boot; see " + str(source / "backend.log"))
            try:
                api("/runs")
                return process
            except (OSError, AssertionError):
                time.sleep(.5)
        raise TimeoutError("Test backend startup timeout")

    try:
        server = boot()
        plan = api("/plans", {"settings": settings})
        task = api("/tasks", {"token": plan["token"]})
        root = Path(task["output_path"])
        initial = json.loads((root / "generation.json").read_text(encoding="utf-8"))
        seeds = [item["seed"] for item in initial["items"]]
        worker = psutil.Process(initial["worker"]["pid"])
        server.kill(); server.wait(timeout=10)
        assert worker.is_running(), "Worker must survive the backend crash"
        server = boot()
        recovered = api("/tasks/" + task["task_id"])
        assert recovered["status"] in {"created", "running"}, recovered
        denied = api("/runs/" + task["run_key"] + "/resume", {}, allow_error=True)
        assert denied["status"] != "success", denied
        second_plan = api("/plans", {"settings": dict(settings, seed=54322)})
        denied = api("/tasks", {"token": second_plan["token"]}, allow_error=True)
        assert denied["status"] != "success", "Recovered worker must own the shared GPU slot"
        print("Live worker recovered; resume and a competing GPU task were refused", flush=True)
        api("/tasks/" + task["task_id"] + "/cancel", {})
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            stopped = api("/tasks/" + task["task_id"])
            if stopped["status"] not in {"created", "running", "stopping"}:
                break
            time.sleep(1)
        assert not worker.is_running(), "GPU slot cannot be released before worker exit"
        while time.monotonic() < deadline:
            response = api("/runs/" + task["run_key"] + "/resume", {}, allow_error=True)
            if response["status"] == "success":
                resumed = response["data"]
                break
            time.sleep(1)
        else:
            raise TimeoutError("Recovered GPU claim was never released")
        # An obsolete task ID must never report or cancel the new worker.
        obsolete = api("/tasks/" + task["task_id"])
        assert obsolete["status"] not in {"created", "running", "stopping"}, obsolete
        denied = api("/tasks/" + task["task_id"] + "/cancel", {}, allow_error=True)
        assert denied["status"] != "success", denied
        while time.monotonic() < deadline:
            finished = api("/tasks/" + resumed["task_id"])
            if finished["status"] not in {"created", "running", "stopping"}:
                break
            time.sleep(2)
        assert finished["status"] == "finished" and finished["completed"] == 3, finished
        final = json.loads((root / "generation.json").read_text(encoding="utf-8"))
        assert seeds == [item["seed"] for item in final["items"]]
        print("Backend crash, live worker recovery, exclusive GPU ownership, stop and deterministic resume passed: " + str(root), flush=True)
    finally:
        if server is not None and server.poll() is None:
            server.terminate(); server.wait(timeout=15)
        if worker is not None and worker.is_running():
            worker.kill(); worker.wait(timeout=15)
        log.close()


if __name__ == "__main__":
    main()
