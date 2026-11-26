"""Bridge between a locally owned training task and sd-scripts' file protocol."""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path, PureWindowsPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.monitor.training import primary_learning_rate_tag
from backend.monitor.sample_metadata import browser_json
from backend.training.checkpoint_state import resumable_state
from backend.utils.file_io import atomic_write_text, read_bytes


class ControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["save", "save_state", "sample", "stop", "force", "pause", "resume"]
    mode: Literal["both", "weights", "state", "discard"] = "discard"
    index: int | None = Field(default=None, ge=0)
    base_index: int | None = Field(default=None, ge=0)
    prompt: str | None = Field(default=None, min_length=1, max_length=32768)
    seed: int | None = Field(default=None, ge=-(2**63), le=2**64 - 1)
    steps: int | None = Field(default=None, ge=1, le=1000)
    width: int | None = Field(default=None, ge=64, le=4096)
    height: int | None = Field(default=None, ge=64, le=4096)
    scale: float | None = Field(default=None, gt=0, le=50)


def read_object(path):
    try:
        value = json.loads(read_bytes(path), parse_constant=lambda _: None)
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def reported_progress(status: dict) -> dict:
    """Use the same progress fields for the live stream, snapshots and history."""
    p = status.get("progress") or {}
    if status.get("schema_version") != 1 or not isinstance(p, dict):
        return {}
    step, total = p.get("global_step"), p.get("max_train_steps")
    if type(step) is not int or type(total) is not int or total <= 0:
        return {}
    rates = {"lr/" + key: value for key, value in (status.get("lr") or {}).items()}
    result = {"step": step, "total_steps": total, "percent": round(min(100, step * 100 / total), 2),
              "metrics_step": p.get("metrics_step"),
              "metrics_time": p.get("metrics_time"),
              "loss": (status.get("loss") or {}).get("current"),
              "lr": rates.get(primary_learning_rate_tag(rates))}
    if p.get("epoch") is not None and p.get("num_train_epochs"):
        result["epoch"] = f"{p['epoch']}/{p['num_train_epochs']}"
    speed = status.get("speed") or {}
    if speed.get("sec_per_step"):
        result["speed"] = f"{speed['sec_per_step']:.2f}s/it"
    for name, key in (("eta", "eta_sec"), ("elapsed", "elapsed_sec")):
        if speed.get(key) is not None:
            seconds = max(0, round(speed[key]))
            hours, remainder = divmod(seconds, 3600)
            minutes, seconds = divmod(remainder, 60)
            result[name] = f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"
    if status.get("error"):
        result.update(has_error=True, error_msg=status["error"].get("message"))
    return {key: value for key, value in result.items() if value is not None}


def saved_training_state(root: Path, artifacts: Path, run_dir: Path | None = None) -> dict:
    """Only advertise the last state confirmed by this trainer in its output directory."""
    status = read_object(root / "status.json")
    saved = status.get("last_state") or {}
    if status.get("schema_version") != 1 or not isinstance(saved, dict) or not isinstance(saved.get("path"), str):
        return {}
    # Trainer status can come from a different OS. Only reuse its directory name.
    name = PureWindowsPath(saved["path"]).name
    if not name or name == "..":
        return {}
    path = artifacts / name
    if resumable_state(path, run_dir):
        return {"resume_state": str(path), "resume_step": saved.get("step")}
    return {}


class TrainingControl:
    def __init__(self, root: Path, multi_process: bool):
        self.root = root
        self.multi_process = multi_process
        self.lock = threading.Lock()
        self.manifest = {}
        self.name = ""
        self.action = ""
        self.command_run_id = ""
        self.command_event_offset = 0
        self.command_result = None
        self.worker = None
        self.error = ""
        self.closed = False
        self.event_offset = 0

    def _load_manifest(self):
        if not self.manifest:
            self.manifest = read_object(self.root / "manifest.json")
        return self.manifest

    def _events_from(self, offset):
        with (self.root / "events.jsonl").open("rb") as stream:
            stream.seek(offset)
            for line in stream:
                if not line.endswith(b"\n"):
                    break
                offset += len(line)
                try:
                    record = json.loads(line)
                except ValueError:
                    record = None
                yield offset, record if isinstance(record, dict) else {}

    def artifact_events(self) -> set[str] | None:
        """Return None when filesystem polling is needed to see every rank's files."""
        if self.multi_process or self._load_manifest().get("training", {}).get("num_processes", 1) != 1:
            return None
        events = set()
        try:
            for self.event_offset, record in self._events_from(self.event_offset):
                kind = record.get("event")
                if kind in ("checkpoint_saved", "state_saved", "samples_generated"):
                    events.add(kind)
                elif kind == "command_finished" and record.get("command") == "sample" and record.get("status") == "ok":
                    # The receipt identifies manual images without a metadata sidecar.
                    events.add("samples_generated")
        except OSError:
            return None
        return events

    def _finished_command(self, status):
        if self.command_result is not None:
            return self.command_result
        receipt = read_object(self.root / "commands" / "done" / self.name)
        if receipt.get("run_id") == self.command_run_id:
            self.command_result = receipt
            return receipt
        try:
            for self.command_event_offset, record in self._events_from(self.command_event_offset):
                if (record.get("event") == "command_finished" and record.get("file") == self.name
                        and record.get("run_id") == self.command_run_id):
                    self.command_result = record
                    return record
        except OSError:
            pass
        last = status.get("last_command") or {}
        if status.get("run_id") == self.command_run_id and last.get("file") == self.name:
            return last
        return None

    def status(self):
        status = read_object(self.root / "status.json")
        return status if status.get("schema_version") == 1 else {}

    def stopped_at_exit(self) -> bool:
        status = self.status()
        state = status.get("state")
        if state in ("stopped", "finished", "failed", "aborted", "interrupted"):
            return state == "stopped"
        # The trainer appends run_end before replacing status.json. On Windows a
        # reader can prevent the final replacement even though training exited cleanly.
        run_id = self._load_manifest().get("run_id") or status.get("run_id")
        if not run_id:
            return False
        try:
            with (self.root / "events.jsonl").open("rb") as stream:
                for line in stream:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(record, dict) and record.get("run_id") == run_id and record.get("event") == "run_end":
                        return record.get("state") == "stopped"
        except OSError:
            pass
        return False

    def _view(self, *, prompts=False):
        status = self.status()
        manifest = self._load_manifest() if status else self.manifest
        args = manifest.get("args", {})
        state = status.get("state")
        ready = bool(not self.closed and manifest.get("run_id") and manifest["run_id"] == status.get("run_id")
                     and not self.multi_process and manifest.get("training", {}).get("num_processes", 1) == 1
                     and state in ("running", "paused", "starting"))
        command = None
        if self.worker is not None and self.worker.poll() is not None:
            if self.worker.returncode:
                self.error = "encodingFailed"
            self.worker = None
        if self.name:
            receipt = self._finished_command(status)
            phase = "encoding" if self.worker is not None else "queued"
            command = {"id": self.name, "action": self.action, "status": "pending", "phase": phase}
            if receipt and receipt.get("status") in ("ok", "error", "expired"):
                command.update(status=receipt.get("status"), phase="done", result=receipt.get("result"), error=receipt.get("error"))
            elif self.error or self.closed or state in ("stopped", "failed", "finished", "aborted", "interrupted"):
                command.update(status="error", phase="error", error=self.error or "expired")
        allowed = []
        choices = manifest.get("preview_prompts") or []
        cached = args.get("cache_text_encoder_outputs") or args.get("cache_text_encoder_outputs_to_disk")
        # SDXL retains its encoders for sampling even when dataset embeddings are cached.
        external_encoder = cached and manifest.get("script") in ("anima_train_network.py", "moss_image_train_network.py")
        new_prompt = not external_encoder or bool(choices) or bool(manifest.get("manual_preview_cache"))
        if ready:
            allowed = ["stop", "resume"] if state == "paused" else ["stop", "save", "save_state"]
            if state != "paused":
                if choices or new_prompt:
                    allowed.append("sample")
                if not args.get("deepspeed") and not (args.get("blocks_to_swap") and args.get("block_swap_h2d_only")):
                    allowed.append("pause")
        view = {"state": state, "allowed": allowed, "command": command, "new_prompt": new_prompt,
                "progress": reported_progress(status), "timing": status.get("timing"),
                "replica": bool(args.get("replica_devices")), "updated_at": status.get("updated_at")}
        for key in ("last_checkpoint", "last_state"):
            saved = status.get(key)
            if isinstance(saved, dict) and type(saved.get("step")) is int and saved["step"] >= 0:
                view[key + "_step"] = saved["step"]
        if prompts:
            view["prompts"] = choices
            view["preview_defaults"] = self.manifest.get("preview_defaults", {})
            view["external_encoder"] = bool(external_encoder)
        return view

    def view(self, *, prompts=False):
        with self.lock:
            result = self._view(prompts=prompts)
            if prompts:
                result["prompts"] = browser_json(result["prompts"])
                result["preview_defaults"] = browser_json(result["preview_defaults"])
            return result

    def submit(self, request, environ):
        with self.lock:
            view = self._view(prompts=True)
            if request.action not in view["allowed"]:
                raise ValueError("unavailable")
            if (view["command"] or {}).get("status") == "pending":
                raise ValueError("pending")
            payload = {"command": request.action}
            if request.action == "stop":
                payload.update(save=request.mode in ("weights", "both"), save_state=request.mode in ("state", "both"))
            external = False
            if request.action == "sample":
                if request.index is not None:
                    if request.index >= len(view["prompts"]):
                        raise ValueError("unavailable")
                    payload["indices"] = [request.index]
                elif request.prompt and request.prompt.strip() and view["new_prompt"]:
                    if request.base_index is not None:
                        if request.base_index >= len(view["prompts"]):
                            raise ValueError("unavailable")
                        template = dict(view["prompts"][request.base_index])
                    else:
                        template = dict(view["preview_defaults"])
                    template["prompt"] = request.prompt
                    payload["prompts"] = [template]
                    external = view["external_encoder"]
                else:
                    raise ValueError("unavailable")
                payload["overrides"] = {
                    k: v
                    for k, v in (
                        ("sample_steps", request.steps),
                        ("seed", request.seed),
                        ("width", request.width),
                        ("height", request.height),
                        ("scale", request.scale),
                    )
                    if v is not None
                }
            name = f"{time.time_ns()}_{request.action}.json"
            try:
                events_start = (self.root / "events.jsonl").stat().st_size
            except OSError:
                events_start = 0
            commands = self.root / "commands"
            commands.mkdir(exist_ok=True)
            if external:
                # The helper writes to this task's private queue only after encoding succeeds.
                input_file = self.root / "encode-request.json"
                atomic_write_text(input_file, json.dumps(payload, ensure_ascii=False))
                with (self.root / "encode.log").open("w", encoding="utf-8") as log:
                    self.worker = subprocess.Popen(
                        [sys.executable, "-B", str(Path(__file__).with_name("encode_preview.py")), str(self.root), name],
                        env=environ, stdout=log, stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
            else:
                atomic_write_text(commands / name, json.dumps(payload, ensure_ascii=False))
            self.name, self.action, self.error = name, request.action, ""
            self.command_run_id = self.manifest["run_id"]
            self.command_event_offset, self.command_result = events_start, None
            return self._view()

    def close(self):
        with self.lock:
            self.closed = True
            if self.worker is not None:
                if self.worker.poll() is None:
                    self.worker.kill()
                self.worker.wait()
                self.worker = None
