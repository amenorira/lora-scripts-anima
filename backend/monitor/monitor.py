"""
任务监控器：每秒采样进程内任务状态并发布实时事件。

功能：
- 监控任务状态变化
- 收集训练进度
- 收集硬件信息
- 发布 WebSocket 实时事件
- 控制台单行训练进度条（rich Progress，含 loss/lr/epoch/已运行/剩余）
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from pathlib import Path
from typing import Any

from backend.constants import OUTPUT_DIR
from backend.core.realtime import realtime_hub, realtime_tasks, task_topic
from backend.utils.file_io import is_fuse_or_network_fs
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import parse_log_progress, primary_learning_rate_tag, read_tensorboard_incremental
from backend.monitor.artifacts import newest_previews, read_output_summary
from backend.monitor.log_files import find_train_log_path, read_log_slice
from backend.monitor.run_control import reported_progress
from backend.monitor.run_registry import find_run_record_by_task_id, read_run_config
from backend.tasks import tm

logger = logging.getLogger(__name__)

_PROGRESS_FIELDS = (
    "step", "total_steps", "percent", "loss", "lr", "metrics_step", "epoch",
    "eta", "elapsed", "speed", "has_error", "error_msg",
)
_MAX_REALTIME_LOG_CHARS = 48 * 1024
_MAX_REALTIME_LOG_LINES = 1000
_MAX_REALTIME_METRIC_POINTS = 256
_DEFAULT_SAMPLE_INTERVAL = 1.0
_FUSE_SAMPLE_INTERVAL = 2.0
_DEFAULT_CONSOLE_PROGRESS_INTERVAL = 30.0


def _resolve_console_progress_interval(default: float = _DEFAULT_CONSOLE_PROGRESS_INTERVAL) -> float:
    """Resolve non-TTY plain-text progress log interval from ANIMA_CONSOLE_PROGRESS_INTERVAL."""
    raw = os.environ.get("ANIMA_CONSOLE_PROGRESS_INTERVAL", "").strip()
    if raw:
        try:
            value = float(raw)
            if math.isfinite(value) and value >= 0:
                return value
        except ValueError:
            pass
    return default


def resolve_monitor_interval(run_dir: Path | None = None, *, default: float = _DEFAULT_SAMPLE_INTERVAL) -> float:
    """Resolve polling interval from ANIMA_MONITOR_INTERVAL or FUSE auto-tuning."""
    raw = os.environ.get("ANIMA_MONITOR_INTERVAL", "").strip()
    if raw:
        try:
            value = float(raw)
            if value > 0:
                return max(0.25, min(30.0, value))
        except ValueError:
            pass
    probe = run_dir if run_dir is not None else OUTPUT_DIR
    if is_fuse_or_network_fs(probe):
        return max(default, _FUSE_SAMPLE_INTERVAL)
    return default


def _format_learning_rate(value: Any) -> str:
    """Keep LR text stable across log parsing and TensorBoard updates."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if 0 < abs(number) < 0.001:
        return f"{number:.4e}"
    return f"{number:.6g}"


def _bounded_realtime_log_lines(lines: list[str]) -> tuple[list[str], bool]:
    """Keep a WebSocket log event small while preserving the newest output.

    The full log remains available through the HTTP log-slice endpoint.  This
    guard prevents a delayed filesystem flush from turning one realtime event
    into a multi-megabyte JSON frame on a slow link.
    """
    if not lines:
        return [], False
    kept: list[str] = []
    used = 0
    for line in reversed(lines):
        text = str(line)
        size = len(text) + 1
        if kept and used + size > _MAX_REALTIME_LOG_CHARS:
            break
        if not kept and size > _MAX_REALTIME_LOG_CHARS:
            kept.append(text[-_MAX_REALTIME_LOG_CHARS:])
            return kept, True
        kept.append(text)
        used += size
    kept.reverse()
    return kept, len(kept) != len(lines)


def _bounded_realtime_metrics(points: dict[str, list[dict]]) -> tuple[dict[str, list[dict]], bool]:
    """Cap a delayed TensorBoard catch-up to a small realtime JSON frame."""
    bounded: dict[str, list[dict]] = {}
    truncated = False
    for tag, series in points.items():
        if not isinstance(series, list):
            continue
        if len(series) > _MAX_REALTIME_METRIC_POINTS:
            bounded[tag] = series[-_MAX_REALTIME_METRIC_POINTS:]
            truncated = True
        else:
            bounded[tag] = series
    return bounded, truncated


def _console_is_terminal() -> bool:
    """Gate Rich Live/Progress redraws so non-TTY cloud logs stay clean."""
    try:
        from backend.log import console as rich_console
    except Exception:
        return False
    return rich_console is not None and bool(getattr(rich_console, "is_terminal", False))


def _build_console_progress():
    """惰性加载单行进度条；终端缩放不影响训练监控。"""
    from backend.monitor.console_progress import build_console_progress

    return build_console_progress()


class TaskMonitor:
    """任务监控器"""

    def __init__(self):
        self._running = False
        self._tasks: list[asyncio.Task] = []
        self._sample_interval = resolve_monitor_interval()  # 真实采样间隔（秒）
        self._active_run_dir: Path | None = None
        self._last_status: dict[str, str] = {}  # task_id -> last_status
        self._last_log_cursor: dict[str, dict] = {}  # 与分页共用规范化行号，包含可被覆盖的末行。
        self._last_progress: dict[str, dict[str, Any]] = {}  # task_id -> 最近一次有效字段
        self._output_names: dict[str, str] = {}
        self._primary_lr_tag: dict[str, str] = {}
        self._last_artifact_check: dict[str, float] = {}
        self._last_artifact_signature: dict[str, tuple] = {}
        self._pending_artifact_signature: dict[str, tuple] = {}
        # 控制台进度条状态
        self._console_progress = None
        self._progress_task_id = None
        self._progress_active_task: str | None = None  # 当前显示进度的 task_id
        self._last_plain_progress_at: float | None = None
        self._plain_progress_completed: bool = False

    async def start(self) -> None:
        """启动监控器"""
        if self._running:
            return

        self._running = True
        self._tasks = [
            asyncio.create_task(self._monitor_loop(self._check_all_tasks)),
            asyncio.create_task(self._monitor_loop(self._poll_tracked_tasks)),
            asyncio.create_task(self._monitor_loop(self._collect_hardware)),
        ]
        logger.info("任务监控器已启动")

    async def stop(self) -> None:
        """停止监控器"""
        self._running = False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        self._stop_console_progress()
        logger.info("任务监控器已停止")

    def _stop_console_progress(self) -> None:
        """停止并清除动态进度行，开始/结束日志由 supervisor 单独保留。"""
        if self._console_progress and self._console_progress.live.is_started:
            try:
                self._console_progress.stop()
            except Exception:
                pass
        self._console_progress = None
        self._progress_task_id = None
        self._progress_active_task = None
        self._last_plain_progress_at = None
        self._plain_progress_completed = False

    def _log_plain_console_progress(self, task_id: str, progress: dict, output_name: str) -> None:
        """非 TTY 环境下以节流纯文本日志输出训练进度（适配 Colab / Docker 日志）。"""
        try:
            step = int(progress.get("step") or 0)
            total = int(progress.get("total_steps") or 0)
        except (TypeError, ValueError):
            return
        if total <= 0 or step <= 0:
            return

        if self._progress_active_task and self._progress_active_task != task_id:
            self._stop_console_progress()

        now = time.monotonic()
        interval = _resolve_console_progress_interval()
        is_first = self._last_plain_progress_at is None
        is_complete = step >= total
        if is_complete and self._plain_progress_completed:
            return
        if not is_first and not is_complete and (now - self._last_plain_progress_at) < interval:
            return

        pct = max(0.0, min(100.0, (step / total) * 100.0))
        header = f"Training {' '.join(str(output_name or '').split())}".strip()
        parts = [header, f"step {step}/{total} ({pct:.1f}%)"]

        def _clean(val: Any) -> str:
            if val is None:
                return ""
            return " ".join(str(val).split())

        epoch = _clean(progress.get("epoch"))
        if epoch:
            parts.append(f"epoch {epoch}")
        loss = _clean(progress.get("loss"))
        if loss:
            parts.append(f"loss {loss}")
        lr = _clean(progress.get("lr"))
        if lr:
            parts.append(f"lr {lr}")
        speed = _clean(progress.get("speed"))
        if speed:
            parts.append(speed)
        eta = _clean(progress.get("eta"))
        if eta:
            parts.append(f"ETA {eta}")

        logger.info(" | ".join(parts))
        self._progress_active_task = task_id
        self._last_plain_progress_at = now
        if is_complete:
            self._plain_progress_completed = True

    def _update_console_progress(self, task_id: str, progress: dict, output_name: str) -> None:
        """更新控制台单行训练进度条"""
        if not _console_is_terminal():
            self._log_plain_console_progress(task_id, progress, output_name)
            return
        step = progress.get("step", 0)
        total = progress.get("total_steps", 0)
        if not total:
            return  # 无总步数时不显示进度条
        try:
            # 任务切换：停止旧进度条，重新开始
            if self._progress_active_task and self._progress_active_task != task_id:
                self._stop_console_progress()

            # 惰性创建进度条实例
            if self._console_progress is None:
                self._console_progress = _build_console_progress()

            cp = self._console_progress
            description = f"Training {output_name or ''}".strip()
            progress_kwargs = dict(
                total=total, completed=step,
                elapsed=progress.get("elapsed") or "",
                eta=progress.get("eta") or "",
                loss=progress.get("loss"),
                lr=progress.get("lr"),
                epoch=progress.get("epoch"),
                speed=progress.get("speed"),
            )
            # 首次启动进度条
            if not cp.live.is_started:
                cp.start()
            if self._progress_task_id is None:
                self._progress_task_id = cp.add_task(description, **progress_kwargs)
                self._progress_active_task = task_id
            else:
                cp.update(self._progress_task_id, description=description, **progress_kwargs)
        except Exception:
            # 控制台进度条是辅助显示，不应影响监控主流程
            pass

    def _merge_progress(self, task_id: str, updates: dict) -> dict:
        """合并增量进度；空值不能覆盖之前已经解析到的有效字段。"""
        current = self._last_progress.setdefault(task_id, {})
        for key, value in updates.items():
            if key not in _PROGRESS_FIELDS or value is None or value == "":
                continue
            if key == "lr":
                value = _format_learning_rate(value)
            current[key] = value
        return dict(current)
    
    async def _monitor_loop(self, sample) -> None:
        """Sample each independent domain without accumulating overlapping work."""
        while self._running:
            try:
                await sample()
                interval = resolve_monitor_interval(self._active_run_dir, default=self._sample_interval)
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("监控循环异常 (%s): %s", sample.__name__, e, exc_info=True)
                await asyncio.sleep(1)  # 出错后短暂等待

    async def _poll_tracked_tasks(self) -> None:
        await realtime_tasks.poll()
        await realtime_hub.prune()
    
    async def _check_all_tasks(self) -> None:
        """检查所有任务状态"""
        tasks = tm.training_dump()
        retained_ids = {task.get("id") for task in tasks}
        for task_id in set(self._last_status) - retained_ids:
            self._cleanup_task(task_id)
            self._last_status.pop(task_id, None)
        
        for task_data in tasks:
            task_id = task_data.get("id")
            if not task_id:
                continue
            
            current_status = task_data.get("status")
            last_status = self._last_status.get(task_id)
            
            # 状态变化事件
            if current_status != last_status:
                terminal = current_status in ("FINISHED", "TERMINATED", "FAILED", "STOPPED")
                if terminal:
                    await self._collect_task_data(task_id)
                await realtime_hub.publish(task_topic(task_id), "task.status", {
                    "task_id": task_id,
                    "kind": "training",
                    "status": current_status,
                })
                await realtime_hub.publish("server", "server.tasks", {
                    "tasks": tasks,
                    "training_active": any(item.get("status") in {"CREATED", "RUNNING"} for item in tasks),
                })
                self._last_status[task_id] = current_status
                
                # 任务结束时清理
                if terminal:
                    await realtime_hub.publish(task_topic(task_id), "task.result", {
                        "task_id": task_id,
                        "kind": "training",
                        "status": current_status,
                    })
                    self._cleanup_task(task_id)
                    # 停止控制台进度条（结束信息由 supervisor 的 log 输出）
                    if self._progress_active_task == task_id:
                        self._stop_console_progress()
            
            # 只有运行中的任务才收集进度和日志
            if current_status == "RUNNING":
                await self._collect_task_data(task_id)
        
    async def _collect_task_data(self, task_id: str) -> None:
        """收集任务进度和日志增量"""
        try:
            record = await asyncio.to_thread(find_run_record_by_task_id, task_id)
            run_dir = str(record["run_path"]) if record else None
            run_dir_path = Path(run_dir) if run_dir else None
            if run_dir_path is not None:
                self._active_run_dir = run_dir_path
            if run_dir_path and task_id not in self._output_names:
                config = await asyncio.to_thread(read_run_config, run_dir_path)
                if config:
                    self._output_names[task_id] = config.get("output_name", "")
            output_name = self._output_names.get(task_id, "")

            # 增量索引只扫描追加内容，行号/进度条覆盖规则与 HTTP 分页一致。
            log_delta = await asyncio.to_thread(
                self._read_log_delta, task_id, run_dir_path
            )

            task = tm.get_task(task_id)
            updates = reported_progress(await asyncio.to_thread(task.control.status)) if task and task.control else {}
            if log_delta:
                updates = await asyncio.to_thread(parse_log_progress, log_delta["lines"], updates)
            if updates:
                previous = dict(self._last_progress.get(task_id, {}))
                progress = self._merge_progress(task_id, updates)
                if progress != previous:
                    await realtime_hub.publish(task_topic(task_id), "task.progress", {
                        "task_id": task_id,
                        "kind": "training",
                        "status": "RUNNING",
                        "data": progress,
                    })

                    # 控制台始终更新同一个 Rich Live 任务，不保留历史进度行。
                    self._update_console_progress(
                        task_id, progress, output_name
                    )

            if log_delta is not None:
                new_lines = log_delta["lines"]
                log_lines, log_truncated = _bounded_realtime_log_lines(new_lines)
                await realtime_hub.publish(task_topic(task_id), "task.log", {
                    "task_id": task_id,
                    "kind": "training",
                    "status": "RUNNING",
                    "data": {
                        "lines": log_lines,
                        "log_total": log_delta["total"],
                        "offset": log_delta["offset"] + len(new_lines) - len(log_lines),
                        "reset": log_delta["reset"],
                        "truncated": log_truncated or log_delta["truncated"],
                    }
                })

            # TB 增量 loss 数据推送
            await self._collect_tb_incremental(
                task_id,
                run_dir=run_dir,
                output_name=output_name,
            )
            await self._collect_artifact_update(task_id, record)
        except Exception as e:
            logger.debug(f"收集任务数据失败 (task_id={task_id}): {e}")

    async def _collect_artifact_update(self, task_id: str, record: dict | None) -> None:
        """Emit counts and a tiny notice when previews or output files change.

        Preview paths are metadata and remain an HTTP read; putting the image
        itself (or a whole growing preview list) on the realtime socket would
        make slow connections progressively worse.
        """
        if not record or not record.get("artifact_available") or not await realtime_hub.subscriber_count("artifacts"):
            return
        task = tm.get_task(task_id)
        events = await asyncio.to_thread(task.control.artifact_events) if task and task.control else None
        if events is not None:
            if events:
                root = str(record["artifact_path"])
                previews_changed = "samples_generated" in events
                if previews_changed:
                    await asyncio.to_thread(newest_previews, root, 0, True, record.get("run_dir", ""))
                summary = await asyncio.to_thread(read_output_summary, root)
                await realtime_hub.publish("artifacts", "task.artifacts", {
                    "task_id": task_id, "kind": "training", "output_count": summary["count"],
                    "previews_changed": previews_changed,
                })
            return
        now = time.monotonic()
        if now - self._last_artifact_check.get(task_id, 0.0) < 2.0:
            return
        self._last_artifact_check[task_id] = now
        root = str(record["artifact_path"])
        outputs = await asyncio.to_thread(read_output_summary, root)
        previous = self._pending_artifact_signature.get(task_id)
        # An older preview can be added or removed inside the cache TTL.
        refresh = previous is not None and outputs["image_count"] != previous[2]
        previews = await asyncio.to_thread(newest_previews, root, 0, refresh, record.get("run_dir", ""))
        signature = (outputs["count"], outputs["models"], outputs["image_count"], previews)
        self._pending_artifact_signature[task_id] = signature
        last = self._last_artifact_signature.get(task_id)
        if previous != signature or signature == last:
            return
        self._last_artifact_signature[task_id] = signature
        await realtime_hub.publish("artifacts", "task.artifacts", {
            "task_id": task_id,
            "kind": "training",
            "output_count": outputs["count"],
            "previews_changed": last is None or last[3] != previews,
        })

    def _read_log_delta(self, task_id: str, output_dir_path: Path | None = None) -> dict | None:
        """从分页索引取得新增/被覆盖的行及文件总数，不靠推送批次长度累计计数。"""
        try:
            log_path = find_train_log_path(task_id, output_dir_path)
            if not log_path:
                return None

            stat = log_path.stat()
            stamp = (str(log_path.resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            previous = self._last_log_cursor.get(task_id)
            if previous and previous["stamp"] == stamp:
                return None
            same_file = previous and stamp[:3] == previous["stamp"][:3]
            cursor = (max(0, previous["total"] - 2), previous["generation"]) if same_file else None
            page = read_log_slice(log_path, limit=_MAX_REALTIME_LOG_LINES, tail=True, tail_cursor=cursor)
            total, lines = page["total"], page["lines"]
            reset = bool(previous and (stamp[:3] != previous["stamp"][:3]
                         or page["generation"] != previous["generation"]))
            start = max(0, previous["total"] - 2) if previous and not reset else 0
            truncated = start < page["offset"]
            offset = max(start, page["offset"])
            delta = lines[offset - page["offset"]:]
            if previous and not reset:
                old_start = previous["total"] - len(previous["tail"])
                while delta and old_start <= offset < previous["total"] and delta[0] == previous["tail"][offset - old_start]:
                    delta = delta[1:]
                    offset += 1
            self._last_log_cursor[task_id] = {"stamp": stamp, "generation": page["generation"], "total": total, "tail": lines[-2:]}
            if not delta and not reset and (not previous or total == previous["total"]):
                return None
            return {"lines": delta, "offset": offset, "total": total, "reset": reset, "truncated": truncated}
        except OSError:
            return None

    async def _collect_tb_incremental(
        self,
        task_id: str,
        run_dir: str | None = None,
        output_name: str = "",
    ) -> None:
        """从 TensorBoard event 文件读取增量 loss/lr 数据并推送到实时通道"""
        try:
            if not run_dir:
                return
            tb_points = await asyncio.to_thread(
                read_tensorboard_incremental,
                run_dir=run_dir,
            )
            if tb_points:
                tb_progress: dict[str, str] = {}
                for tag in ("loss/current", "loss/average"):
                    if tb_points.get(tag):
                        tb_progress["loss"] = f"{float(tb_points[tag][-1]['value']):.6g}"
                        break
                previous_lr_tag = self._primary_lr_tag.get(task_id)
                # Partial batches must not replace the selected adaptive metric with a multiplier.
                lr_tags = ([previous_lr_tag] if previous_lr_tag else []) + list(tb_points)
                lr_tag = primary_learning_rate_tag(lr_tags)
                lr_points = tb_points.get(lr_tag) if lr_tag else None
                if lr_points:
                    self._primary_lr_tag[task_id] = lr_tag
                    lr = float(lr_points[-1]["value"])
                    tb_progress["lr"] = _format_learning_rate(lr)
                if tb_progress:
                    progress = self._merge_progress(task_id, tb_progress)
                    self._update_console_progress(task_id, progress, output_name)

                bounded_points, metrics_truncated = _bounded_realtime_metrics(tb_points)
                await realtime_hub.publish(task_topic(task_id), "task.metrics", {
                    "task_id": task_id,
                    "kind": "training",
                    "status": "RUNNING",
                    "points": bounded_points,
                    "truncated": metrics_truncated,
                })
        except Exception:
            logger.debug(f"TB 增量读取失败 (task_id={task_id})", exc_info=True)

    async def _collect_hardware(self) -> None:
        """收集硬件信息"""
        try:
            if not await realtime_hub.subscriber_count("hardware"):
                return
            gpu, sys_info = await asyncio.gather(
                asyncio.to_thread(gpu_info, True),
                asyncio.to_thread(system_info, True),
            )
            await realtime_hub.publish("hardware", "hardware.sample", {
                "gpu": gpu,
                "system": sys_info,
                "sampled_at": time.time(),
            })
        except Exception as e:
            logger.debug(f"收集硬件信息失败: {e}")
    
    def _cleanup_task(self, task_id: str) -> None:
        """清理任务状态"""
        # 保留终态，避免任务仍在 TaskManager 中保留期间，每一轮轮询都
        # 被误判为一次新的状态变化并重复发送终态事件。
        self._last_log_cursor.pop(task_id, None)
        self._last_progress.pop(task_id, None)
        self._output_names.pop(task_id, None)
        self._primary_lr_tag.pop(task_id, None)
        self._last_artifact_check.pop(task_id, None)
        self._last_artifact_signature.pop(task_id, None)
        self._pending_artifact_signature.pop(task_id, None)
        if not self._last_progress:
            self._active_run_dir = None
        logger.debug(f"清理任务状态: {task_id}")


# 全局监控器实例
task_monitor = TaskMonitor()
