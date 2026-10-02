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
import time
from pathlib import Path
from typing import Any

from backend.core.realtime import realtime_hub, realtime_tasks, task_topic
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import parse_log_progress, latest_train_config, read_tensorboard_incremental
from backend.monitor.artifacts import find_train_log_path, newest_previews, read_output_summary, read_log_slice
from backend.monitor.run_registry import find_run_record_by_task_id
from backend.tasks import tm

logger = logging.getLogger(__name__)

_PROGRESS_FIELDS = (
    "step", "total_steps", "percent", "loss", "lr", "epoch",
    "eta", "elapsed", "speed", "has_error", "error_msg",
)
_MAX_REALTIME_LOG_CHARS = 48 * 1024
_MAX_REALTIME_LOG_LINES = 1000
_MAX_REALTIME_METRIC_POINTS = 256


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


def _build_console_progress():
    """构建控制台训练进度条（rich Progress），列：描述 | ASCII进度条 | 百分比 | 步数 | 速度 | 时间 | loss | lr | epoch。

    与模型下载进度条独立实例，仅在训练时活跃。
    """
    from rich.progress import (BarColumn, Progress, ProgressColumn)
    from rich.text import Text
    from backend.log import COLORS

    class _PlainBarColumn(BarColumn):
        """纯 ASCII 进度条：# 已完成 / . 待完成。"""
        def render(self, task):
            if task.total is None or task.total == 0:
                return Text("." * 20, style=COLORS["muted"])
            pct = max(0.0, min(1.0, task.completed / task.total))
            filled = int(round(20 * pct))
            return Text("#" * filled + "." * (20 - filled), style=COLORS["muted"])

    class _StepColumn(ProgressColumn):
        """步数列：450/1000"""
        def render(self, task):
            completed = int(task.completed)
            total = int(task.total) if task.total else 0
            if total:
                return Text(f"{completed}/{total}", style=COLORS["accent"])
            return Text(f"{completed}", style=COLORS["accent"])

    class _DescColumn(ProgressColumn):
        """描述列：Training <output_name>。"""
        def render(self, task):
            return Text(task.description or "Training", style=COLORS["text"])

    class _PctColumn(ProgressColumn):
        """百分比列：右对齐 3 位。"""
        def render(self, task):
            if task.total:
                pct = max(0.0, min(100.0, task.completed / task.total * 100))
                return Text(f"{pct:>3.0f}%", style=COLORS["accent"])
            return Text("--%", style=COLORS["muted"])

    class _MetaColumn(ProgressColumn):
        """附加元数据列：从 task.fields 取 loss/lr/epoch/elapsed/eta/speed 渲染。
        缺失字段显示 --，保持单行紧凑。"""
        def render(self, task):
            fields = task.fields or {}
            elapsed = fields.get("elapsed") or "--"
            eta = fields.get("eta") or "--"
            loss = fields.get("loss") or "--"
            lr = fields.get("lr") or "--"
            ep = fields.get("epoch") or "--"
            speed = fields.get("speed") or ""
            parts = [f"{elapsed}<{eta}", f"loss={loss}", f"lr={lr}", f"ep={ep}"]
            if speed:
                parts.append(speed)
            return Text("  ".join(parts), style=COLORS["text"])

    try:
        from backend.log import console as _console
    except Exception:
        _console = None

    return Progress(
        _DescColumn(),
        _PlainBarColumn(),
        _PctColumn(),
        _StepColumn(),
        _MetaColumn(),
        console=_console,
        # transient=True：训练中任意外部 log（RichHandler 共用同一 console）会让 rich Live
        # 暂停渲染进度条——transient=False 会定格保留该行，导致每次 log 后上面多一条不动的
        # 残影进度条。transient=True 在暂停时清除当前行，log 在该行打印后进度条重新在原行
        # 刷新，不留残影。训练结束时这条不再保留，最终完成信息由 supervisor._log_run_end 输出。
        transient=True,
    )


class TaskMonitor:
    """任务监控器"""

    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None
        self._sample_interval = 1.0  # 真实采样间隔（秒）
        self._last_status: dict[str, str] = {}  # task_id -> last_status
        self._last_log_cursor: dict[str, dict] = {}  # 与分页共用规范化行号，包含可被覆盖的末行。
        self._last_progress: dict[str, dict[str, Any]] = {}  # task_id -> 最近一次有效字段
        self._last_artifact_check: dict[str, float] = {}
        self._last_artifact_signature: dict[str, str] = {}
        self._pending_artifact_signature: dict[str, str] = {}
        # 控制台进度条状态
        self._console_progress = None
        self._progress_task_id = None
        self._progress_active_task: str | None = None  # 当前显示进度的 task_id

    async def start(self) -> None:
        """启动监控器"""
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("任务监控器已启动")

    async def stop(self) -> None:
        """停止监控器"""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
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

    def _update_console_progress(self, task_id: str, progress: dict, output_name: str) -> None:
        """更新控制台单行训练进度条"""
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
    
    async def _monitor_loop(self) -> None:
        """主监控循环"""
        while self._running:
            try:
                await self._check_all_tasks()
                await asyncio.sleep(self._sample_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"监控循环异常: {e}", exc_info=True)
                await asyncio.sleep(1)  # 出错后短暂等待
    
    async def _check_all_tasks(self) -> None:
        """检查所有任务状态"""
        tasks = tm.dump()
        
        for task_data in tasks:
            task_id = task_data.get("id")
            if not task_id:
                continue
            
            current_status = task_data.get("status")
            last_status = self._last_status.get(task_id)
            
            # 状态变化事件
            if current_status != last_status:
                self._last_status[task_id] = current_status
                await realtime_hub.publish(task_topic(task_id), "task.status", {
                    "task_id": task_id,
                    "kind": "training",
                    "status": current_status,
                })
                await realtime_hub.publish("server", "server.tasks", {
                    "tasks": tasks,
                    "training_active": any(item.get("status") in {"CREATED", "RUNNING"} for item in tasks),
                })
                
                # 任务结束时清理
                if current_status in ("FINISHED", "TERMINATED", "FAILED"):
                    await self._collect_task_data(task_id)
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
        
        # 现有打标、下载和环境安装任务通过注册表桥接到同一个实时通道。
        await realtime_tasks.poll()

        # 收集硬件信息（仅在有可见订阅时以 1 Hz 真实采样）
        await self._collect_hardware()
    
    async def _collect_task_data(self, task_id: str) -> None:
        """收集任务进度和日志增量"""
        try:
            train_config = await asyncio.to_thread(latest_train_config, task_id)
            record = await asyncio.to_thread(find_run_record_by_task_id, task_id)
            run_dir = str(record["run_path"]) if record else None
            run_dir_path = Path(run_dir) if run_dir else None

            # 增量索引只扫描追加内容，行号/进度条覆盖规则与 HTTP 分页一致。
            log_delta = await asyncio.to_thread(
                self._read_log_delta, task_id, run_dir_path
            )

            if log_delta is not None:
                new_lines = log_delta["lines"]
                # 从增量行中解析进度（无需额外 4MB tail 读取）
                parsed_progress = await asyncio.to_thread(
                    parse_log_progress, new_lines
                )
                if parsed_progress:
                    progress = self._merge_progress(task_id, parsed_progress)
                    payload = {key: progress[key] for key in _PROGRESS_FIELDS if key in progress}
                    await realtime_hub.publish(task_topic(task_id), "task.progress", {
                        "task_id": task_id,
                        "kind": "training",
                        "status": "RUNNING",
                        "data": payload,
                    })

                    # 控制台始终更新同一个 Rich Live 任务，不保留历史进度行。
                    self._update_console_progress(
                        task_id, progress, train_config.get("output_name", "")
                    )

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
                output_name=train_config.get("output_name", ""),
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
        if not record or not record.get("artifact_available"):
            return
        now = time.monotonic()
        if now - self._last_artifact_check.get(task_id, 0.0) < 2.0:
            return
        self._last_artifact_check[task_id] = now
        previews = await asyncio.to_thread(
            newest_previews,
            str(record["artifact_path"]),
            1,
            False,
            record.get("run_dir", ""),
        )
        latest = previews[-1] if previews else None
        outputs = await asyncio.to_thread(read_output_summary, str(record["artifact_path"]))
        signature = repr((latest.get("path", "") if latest else "", latest.get("version", "") if latest else "", outputs["count"], outputs["models"]))
        previous = self._pending_artifact_signature.get(task_id)
        self._pending_artifact_signature[task_id] = signature
        if previous != signature:
            return
        if signature == self._last_artifact_signature.get(task_id):
            return
        self._last_artifact_signature[task_id] = signature
        await realtime_hub.publish(task_topic(task_id), "task.artifacts", {
            "task_id": task_id,
            "kind": "training",
            "latest_preview": latest,
            "output_count": outputs["count"],
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
            page = read_log_slice(log_path, limit=_MAX_REALTIME_LOG_LINES, tail=True)
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
                if tb_points.get("lr/unet"):
                    lr = float(tb_points["lr/unet"][-1]["value"])
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
        self._last_artifact_check.pop(task_id, None)
        self._last_artifact_signature.pop(task_id, None)
        self._pending_artifact_signature.pop(task_id, None)
        logger.debug(f"清理任务状态: {task_id}")


# 全局监控器实例
task_monitor = TaskMonitor()
