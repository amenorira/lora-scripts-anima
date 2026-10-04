"""Plan review, GPU ownership, recovery and reversible result inspection."""
import copy
import os
import threading
import time
import uuid
from pathlib import Path

import psutil
from PIL import Image

from backend.constants import REPO_ROOT
from backend.tasks import tm, TaskStatus, kill_proc_tree
from . import storage
from .planning import Settings, scan, identity, choose_output, make_items, random_seed, actual_prompt, clean_caption, numbered_filename

_lock = threading.RLock()
_plans = {}
_tasks = {}
_recovery_started = False
_ACTIVE = {"created", "running", "stopping"}


def _reserve():
    task = tm.reserve_task()
    if task:
        task.kind = "regularization"
    return task


class PlanChanged(Exception):
    def __init__(self, plan):
        super().__init__("Plan changed; review and click Start again / 计划已变化，请检查后重新点击开始")
        self.plan = plan


def _live_process(manifest, root):
    worker = manifest.get("worker") or {}
    if not worker.get("pid"):
        return None
    try:
        process = psutil.Process(worker["pid"])
        if abs(process.create_time() - worker["created"]) > .1:
            return None
        command = process.cmdline()
        if "backend.regularization.worker" not in command or str(root) not in command:
            return None
        return process if process.is_running() else None
    except psutil.NoSuchProcess:
        return None
    except psutil.AccessDenied as exc:
        # An unverifiable process is not safe to declare exited.
        raise RuntimeError("Cannot verify old worker exit / 无法确认旧 worker 已退出") from exc


def recover():
    """Called at server startup, before training/tagging can claim the GPU."""
    global _recovery_started
    with _lock:
        if _recovery_started:
            return
        _recovery_started = True
        if not storage.OUTPUT_ROOT.exists():
            return
        for root in storage.OUTPUT_ROOT.iterdir():
            if not root.is_dir() or root.is_symlink() or not root.name.startswith("reg_"):
                continue
            try:
                manifest = storage.read_manifest(root)
                process = _live_process(manifest, root)
                if process:
                    owner = f"regularization-recovery:{root.name}"
                    if not tm.claim_external(owner):
                        # More than one old worker must still keep the existing
                        # single external claim until every recovered process exits.
                        owner = None
                    _tasks[manifest["task_id"]] = {"root": root, "process": process, "task": None}
                elif manifest.get("status") in _ACTIVE:
                    manifest.update(status="terminated", phase="idle", error="Worker interrupted / worker 已中断")
                    for item in manifest["items"]:
                        if item["status"] == "running":
                            item["status"] = "pending"
                    storage.save_manifest(root, manifest)
            except (OSError, ValueError, KeyError):
                continue
        recovered = [v for v in _tasks.values() if v.get("process")]
        if recovered:
            def watch():
                while any(v["process"].is_running() for v in recovered):
                    time.sleep(1)
                for value in recovered:
                    root = value["root"]
                    owner = f"regularization-recovery:{root.name}"
                    tm.release_external(owner)
                    with _lock:
                        manifest = storage.read_manifest(root)
                        if manifest["status"] in _ACTIVE:
                            manifest.update(status="terminated", phase="idle")
                            storage.save_manifest(root, manifest)
            threading.Thread(target=watch, daemon=True).start()


def _validate_pairs(root, manifest, repair=False):
    """Recover only valid image/txt pairs. A half-written pair is never complete."""
    for item in manifest["items"]:
        if item["status"] == "excluded":
            continue
        if item["status"] in {"pending", "failed"} and not storage.item_path(root, item).exists():
            continue
        try:
            with Image.open(storage.item_path(root, item)) as image:
                image.verify()
            text = storage.item_path(root, item, ".txt").read_text(encoding="utf-8-sig")
            caption = text.splitlines()[0].strip() if text else ""
            if not caption:
                raise ValueError("Empty caption")
            if caption != item["caption"]:
                item.setdefault("generated_caption", item["caption"])
                item["caption"] = caption
            item["status"] = "completed"
        except (OSError, ValueError):
            item["status"] = "pending"
            # Generated corrupt/half pairs must not be read as a folder-name
            # caption by sd-scripts while other completed items are used.
            if repair:
                storage.item_path(root, item).unlink(missing_ok=True)
                storage.item_path(root, item, ".txt").unlink(missing_ok=True)


def preview(body):
    recover()
    settings = Settings.model_validate(body.get("settings", body))
    root, sources = scan(settings, body.get("overrides"))
    config, fingerprint = identity(settings, root, sources)
    new_round = bool(body.get("new_round", False))
    with _lock:
        key, existing, occupied = choose_output(root, fingerprint, new_round)
        if existing and not _live_process(existing, storage.run_path(key)):
            existing = copy.deepcopy(existing)
            _validate_pairs(storage.run_path(key), existing)
        previous = _plans.get(body.get("previous_token"))
        keep_seed = previous and previous["settings"]["seed"] == settings.seed and previous["settings"]["source_dir"] == str(root) and previous["new_round"] == new_round
        master = existing["master_seed"] if existing else settings.seed if settings.seed >= 0 else previous["master_seed"] if keep_seed else random_seed()
        items = existing["items"] if existing else make_items(sources, master)
        token = uuid.uuid4().hex
        plan = {"token": token, "settings": config, "fingerprint": fingerprint, "sources": sources,
                "items": items, "master_seed": master, "run_key": key, "new_round": new_round,
                "overrides": body.get("overrides", {}), "existing": occupied, "created_at": time.time(),
                "resume": bool(existing), "revision": _revision(storage.run_path(key))}
        _remember_plan(plan)
        return _public_plan(plan)


def _remember_plan(plan):
    _plans[plan["token"]] = plan
    for old, value in list(_plans.items()):
        if time.time() - value["created_at"] > 3600:
            _plans.pop(old, None)
    while len(_plans) > 4:
        _plans.pop(next(iter(_plans)))


def run_plan(key):
    """Read the executed source plan without rescanning a changing dataset."""
    with _lock:
        manifest = storage.read_manifest(storage.run_path(key), readonly=True)
        plan = {k: manifest[k] for k in ("settings", "fingerprint", "sources", "items", "master_seed", "run_key")}
        plan.update(token=uuid.uuid4().hex, readonly=True, new_round=False, existing=[], created_at=time.time())
        _remember_plan(plan)
        return _public_plan(plan) | {"overrides": run_settings(key)["overrides"]}


def _revision(root):
    if not root.exists():
        return None
    manifest = root / "generation.json"
    if manifest.exists():
        stat = manifest.stat()
        return [stat.st_size, stat.st_mtime_ns]
    return ["occupied", root.stat().st_mtime_ns]


def _public_plan(plan):
    items = plan["items"]
    return {k: v for k, v in plan.items() if k not in {"items", "sources", "revision", "overrides"}} | {
        "total": len(items), "valid_sources": sum(not s["reason"] for s in plan["sources"]),
        "invalid_sources": sum(bool(s["reason"]) for s in plan["sources"]),
        "completed": sum(i["status"] == "completed" for i in items),
        "pending": sum(i["status"] in {"pending", "failed", "running"} for i in items),
        "output_path": str(storage.run_path(plan["run_key"])), "source_count": len(plan["sources"]),
        "master_seed": str(plan["master_seed"]), "settings": dict(plan["settings"], seed=str(plan["settings"]["seed"]))}


def plan_items(token, offset=0, limit=30):
    with _lock:
        plan = _plans.get(token)
        if not plan:
            raise ValueError("Plan expired; scan again / 计划已过期，请重新扫描")
        offset, limit = max(0, offset), max(1, min(100, limit))
        return {"items": plan["sources"][offset:offset + limit], "total": len(plan["sources"])}


def source_preview(token, index):
    with _lock:
        if token not in _plans or index < 0 or index >= len(_plans[token]["sources"]):
            raise ValueError("Source not found")
        return Path(_plans[token]["sources"][index]["source"])


def start(token):
    recover()
    with _lock:
        if token not in _plans:
            raise ValueError("Plan expired; scan again / 计划已过期，请重新扫描")
        plan = _plans[token]
        if plan.get("readonly"):
            raise ValueError("Use resume for an existing run / 已执行计划请使用续跑")
        if not any(i["status"] in {"pending", "failed", "running"} for i in plan["items"]):
            raise ValueError("No unfinished valid images / 没有有效的待生成图片")
        task = _reserve()
        if task is None:
            raise RuntimeError("Training, tagging or generation is active / 训练、打标或正则生成任务正在运行")
        try:
            # Rescan once under the reserved GPU slot. Captions/models may have
            # changed since review, and another process may have occupied the path.
            settings = Settings.model_validate(plan["settings"])
            source_root, sources = scan(settings, plan["overrides"])
            _, fingerprint = identity(settings, source_root, sources)
            key, _, _ = choose_output(source_root, fingerprint, plan["new_round"])
            root = storage.run_path(plan["run_key"])
            if fingerprint != plan["fingerprint"] or key != plan["run_key"] or _revision(root) != plan["revision"]:
                raise PlanChanged(preview({"settings": plan["settings"], "overrides": plan["overrides"], "new_round": plan["new_round"], "previous_token": token}))
            if plan["resume"]:
                manifest = storage.read_manifest(root)
                if _live_process(manifest, root):
                    raise RuntimeError("Previous worker is still active / 旧 worker 仍在运行")
                _validate_pairs(root, manifest, repair=True)
                manifest.pop("selection", None)
            else:
                storage.OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
                try:
                    root.mkdir(exist_ok=False)
                except FileExistsError:
                    raise PlanChanged(preview({"settings": plan["settings"], "overrides": plan["overrides"], "new_round": plan["new_round"], "previous_token": token}))
                manifest = {"schema_version": 1, "settings": plan["settings"], "fingerprint": fingerprint,
                            "master_seed": plan["master_seed"], "sources": sources, "items": copy.deepcopy(plan["items"]),
                            "created_at": time.time(), "run_key": plan["run_key"]}
            if not any(i["status"] in {"pending", "failed", "running"} for i in manifest["items"]):
                raise ValueError("No unfinished images / 没有待生成图片，请选择新一轮生成")
            return _launch(task, root, manifest)
        except Exception:
            if task.process is None:
                tm.release_reserved(task)
            raise


def _launch(task, root, manifest):
    previous_id = manifest.get("task_id")
    if previous_id and previous_id != task.task_id:
        previous = _tasks.setdefault(previous_id, {"root": root, "task": None})
        previous["final"] = summary(root, manifest)
    (root / ".cancel").unlink(missing_ok=True)
    manifest.update(task_id=task.task_id, status="created", phase="loading", worker=None, error="", updated_at=time.time())
    storage.save_manifest(root, manifest)
    python = REPO_ROOT / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    try:
        if not python.is_file():
            raise RuntimeError("Project venv is missing / 项目 venv 不存在")
        task.environ["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + task.environ.get("PYTHONPATH", "")
        task.environ["PYTHONUNBUFFERED"] = "1"
        task.configure_reserved([str(python), "-m", "backend.regularization.worker", "--run-dir", str(root)])
        # Persist PID identity before returning success. If that write fails,
        # settle the process before allowing any other GPU owner to start.
        with (root / "generation.log").open("ab") as log:
            task.execute(stdout_file=log)
            manifest["worker"] = {"pid": task.process.pid, "created": psutil.Process(task.process.pid).create_time()}
            storage.save_manifest(root, manifest)
    except Exception as exc:
        if task.process is not None:
            task.terminate()
            task.wait()
            task.complete_work()
        manifest.update(status="failed", phase="idle", error=f"Worker start failed / worker 启动失败: {exc}"[:1000])
        storage.save_manifest(root, manifest)
        raise
    _tasks[task.task_id] = {"root": root, "task": task}
    def wait():
        try:
            task.wait()
        finally:
            try:
                with _lock:
                    latest = storage.read_manifest(root)
                    if latest["status"] in _ACTIVE:
                        latest.update(status="terminated" if (root / ".cancel").exists() else "failed", phase="idle",
                                      error="Worker exited / worker 已退出", updated_at=time.time())
                        for item in latest["items"]:
                            if item["status"] == "running":
                                item["status"] = "pending"
                        storage.save_manifest(root, latest)
                    else:
                        storage.save_progress(root, storage.manifest_summary(latest))
            finally:
                task.complete_work()
    threading.Thread(target=wait, daemon=True).start()
    return {"task_id": task.task_id, "run_key": root.name, "output_path": str(root)}


def _find(task_id):
    value = _tasks.get(task_id)
    if value:
        if storage.read_progress(value["root"]).get("task_id") != task_id:
            raise ValueError("Task has ended; use the current task / 旧任务已结束，请使用当前任务")
        return value["root"]
    for root in storage.OUTPUT_ROOT.glob("reg_*"):
        if root.is_dir() and not root.is_symlink():
            try:
                if storage.read_progress(root).get("task_id") == task_id:
                    return root
            except (OSError, ValueError):
                continue
    raise ValueError("Task not found / 任务不存在")


def summary(root, manifest=None):
    result = storage.manifest_summary(manifest) if manifest is not None else storage.read_progress(root)
    result.update(run_key=root.name, output_path=str(root))
    result["master_seed"] = str(result["master_seed"])
    # Parent process exit settles the GPU slot; never expose "finished" early.
    owner = _tasks.get(result.get("task_id")) or {}
    task = owner.get("task")
    if task and task.status in {TaskStatus.CREATED, TaskStatus.RUNNING} and result["status"] not in _ACTIVE:
        result["status"] = "stopping" if (root / ".cancel").exists() else "running"
    if owner.get("process") and owner["process"].is_running() and result["status"] not in _ACTIVE:
        result["status"] = "stopping" if (root / ".cancel").exists() else "running"
    if result["status"] in _ACTIVE and (root / ".cancel").exists():
        result["status"] = "stopping"
    return result


def task_snapshot(task_id):
    cached = _tasks.get(task_id, {}).get("final")
    if cached:
        return copy.deepcopy(cached)
    value = _tasks.get(task_id)
    if value:
        result = summary(value["root"])
        if result["task_id"] == task_id:
            return result
        raise ValueError("Task has ended; use the current task / 旧任务已结束，请使用当前任务")
    return summary(_find(task_id))


def runs():
    recover()
    results = []
    for root in storage.OUTPUT_ROOT.glob("reg_*"):
        if root.is_dir() and not root.is_symlink():
            try:
                results.append(summary(root))
            except (OSError, ValueError, KeyError):
                continue
    return sorted(results, key=lambda r: r.get("updated_at") or 0, reverse=True)


def results(key, offset=0, limit=30, status="all"):
    root = storage.run_path(key)
    manifest = storage.read_manifest(root, readonly=True)
    items = [i for i in manifest["items"] if status == "all" or i["status"] == status]
    offset, limit = max(0, offset), max(1, min(100, limit))
    public_items = [dict(item, seed=str(item["seed"]), filename=storage.item_filename(item)) for item in items[offset:offset + limit]]
    for item in public_items:
        if item["status"] in {"completed", "excluded"}:
            try:
                text = storage.item_path(root, item, ".txt").read_text(encoding="utf-8-sig")
                item["caption"] = text.splitlines()[0] if text else ""
            except OSError:
                pass
    return {"items": public_items, "total": len(items), "settings": dict(manifest["settings"], seed=str(manifest["settings"]["seed"])), "summary": summary(root)}


def run_settings(key):
    manifest = storage.read_manifest(storage.run_path(key), readonly=True)
    settings = manifest["settings"]
    overrides = {s["relative"]: s["caption"] for s in manifest["sources"]
                 if not s["reason"] and s["caption"] != clean_caption(
                     s["original_caption"], settings["ignore_first"], settings["exclude_tags"])}
    return {"settings": dict(settings, seed=str(settings["seed"])), "overrides": overrides}


def result_image(key, index):
    root = storage.run_path(key)
    manifest = storage.read_manifest(root, readonly=True)
    # Indices are append-only and contiguous, including excluded replacements.
    item = manifest["items"][index - 1] if 1 <= index <= len(manifest["items"]) else None
    if not item or item["status"] not in {"completed", "excluded"}:
        raise ValueError("Image not available / 图片尚不可用")
    return storage.item_path(root, item)


def cancel(task_id):
    root = _find(task_id)
    current = summary(root)
    if current["status"] not in _ACTIVE:
        return current
    storage.atomic_write(root / ".cancel", b"cancel")
    def terminate_later():
        value = _tasks.get(task_id, {})
        task = value.get("task")
        if task and task.process:
            try:
                task.process.wait(timeout=15)
            except TimeoutError:
                task.terminate()
            except Exception as exc:
                import subprocess
                if isinstance(exc, subprocess.TimeoutExpired):
                    task.terminate()
        else:
            process = _live_process(storage.read_manifest(root), root)
            if process:
                try:
                    process.wait(timeout=15)
                except psutil.TimeoutExpired:
                    kill_proc_tree(process.pid)
    threading.Thread(target=terminate_later, daemon=True).start()
    return {"task_id": task_id, "status": "stopping"}


def resume(key, failed_only=False):
    with _lock:
        recover()
        root = storage.run_path(key)
        manifest = storage.read_manifest(root)
        if _live_process(manifest, root):
            raise RuntimeError("Old worker still active / 旧 worker 仍在运行")
        task = _reserve()
        if not task:
            raise RuntimeError("Training, tagging or generation is active / 训练、打标或正则生成任务正在运行")
        try:
            _validate_pairs(root, manifest, repair=True)
            if failed_only:
                # Worker receives an explicit selection, so pending images do not
                # disappear or get incorrectly relabeled as completed.
                manifest["selection"] = [i["index"] for i in manifest["items"] if i["status"] == "failed"]
            else:
                manifest.pop("selection", None)
            selected = manifest.get("selection")
            if not any(i["status"] in {"pending", "failed", "running"} and (selected is None or i["index"] in selected) for i in manifest["items"]):
                raise ValueError("Nothing to resume / 没有待续跑条目")
            return _launch(task, root, manifest)
        except Exception:
            if task.process is None:
                tm.release_reserved(task)
            raise


def mutate(key, index, action):
    recover()
    if action not in {"exclude", "restore", "regenerate"}:
        raise ValueError("Unknown result action")
    with _lock:
        root = storage.run_path(key)
        manifest = storage.read_manifest(root)
        if _live_process(manifest, root) or not tm.begin_dataset_mutation():
            raise RuntimeError("Stop training/generation before editing results / 请停止训练或生成后再修改结果")
        try:
            _validate_pairs(root, manifest, repair=True)
            item = next((i for i in manifest["items"] if i["index"] == index), None)
            if item is None:
                raise ValueError("Image not found")
            if action in {"exclude", "regenerate"} and item["status"] == "completed":
                previous = item["status"]
                image, caption = storage.item_path(root, item), storage.item_path(root, item, ".txt")
                item["status"] = "excluded"
                target_image, target_caption = storage.item_path(root, item), storage.item_path(root, item, ".txt")
                if target_image.exists() or target_caption.exists():
                    item["status"] = previous
                    raise ValueError("Excluded files already exist / 排除文件已存在")
                target_image.parent.mkdir(exist_ok=True)
                os.replace(image, target_image)
                try:
                    os.replace(caption, target_caption)
                except Exception:
                    os.replace(target_image, image)
                    item["status"] = previous
                    raise
                storage.save_manifest(root, manifest)
            elif action == "restore" and item["status"] == "excluded":
                image, caption = storage.item_path(root, item), storage.item_path(root, item, ".txt")
                item["status"] = "completed"
                target_image, target_caption = storage.item_path(root, item), storage.item_path(root, item, ".txt")
                if target_image.exists() or target_caption.exists():
                    raise ValueError("Output files already exist / 输出文件已存在")
                os.replace(image, target_image)
                try:
                    os.replace(caption, target_caption)
                except Exception:
                    os.replace(target_image, image)
                    raise
                storage.save_manifest(root, manifest)
            elif action != "regenerate":
                raise ValueError("Image state does not permit this action / 当前图片状态不允许此操作")
            if action == "regenerate":
                # Append replacement rather than overwriting the excluded pair.
                has_artifact = item["status"] == "excluded"
                replacement = copy.deepcopy(item) if has_artifact else item
                history = list(replacement.get("seed_history", [])) + [replacement["seed"]]
                existing_seeds = {i["seed"] for i in manifest["items"]}
                replacement.update(index=max(i["index"] for i in manifest["items"]) + 1 if has_artifact else index,
                                   status="pending", error="", seed=random_seed(), replaces=index, seed_history=history,
                                   prompt=actual_prompt(item["caption"], manifest["settings"]["extra_positive"]))
                while replacement["seed"] in existing_seeds:
                    replacement["seed"] = random_seed()
                if has_artifact:
                    used = {storage.item_filename(i).casefold() for i in manifest["items"]}
                    replacement["filename"] = numbered_filename(Path(item["relative"]).stem, used, {})
                    manifest["items"].append(replacement)
                manifest["selection"] = [replacement["index"]]
                storage.save_manifest(root, manifest)
        finally:
            tm.end_dataset_mutation()
        if action == "regenerate":
            task = _reserve()
            if not task:
                raise RuntimeError("GPU slot unavailable; replacement is saved as pending / GPU 被占用，补生成条目已保存为待生成")
            try:
                return _launch(task, root, manifest)
            except Exception:
                if task.process is None:
                    tm.release_reserved(task)
                raise
        return summary(root, manifest)


def logs(key):
    root = storage.run_path(key)
    path = root / "generation.log"
    if not path.exists():
        return []
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - 24000))
        return stream.read().decode("utf-8", errors="replace").splitlines()[-150:]
