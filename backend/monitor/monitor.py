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
from backend.monitor.artifacts import find_train_log_path, newest_previews, _clean_log_text
from backend.monitor.run_registry import find_run_record_by_task_id
from backend.tasks import tm

logger = logging.getLogger(__name__)

_PROGRESS_FIELDS = (
    "step", "total_steps", "percent", "loss", "lr", "epoch",
    "eta", "elapsed", "speed", "has_error", "error_msg",
)
_MAX_REALTIME_LOG_CHARS = 48 * 1024
_MAX_REALTIME_METRIC_POINTS = 256


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

    class _PlainBarColumn(BarColumn):
        """纯 ASCII 进度条：# 已完成 / . 待完成。"""
        def render(self, task):
            if task.total is None or task.total == 0:
                return Text("." * 20, style="dim")
            pct = max(0.0, min(1.0, task.completed / task.total))
            filled = int(round(20 * pct))
            return Text("#" * filled + "." * (20 - filled), style="dim")

    class _StepColumn(ProgressColumn):
        """步数列：450/1000"""
        def render(self, task):
            completed = int(task.completed)
            total = int(task.total) if task.total else 0
            if total:
                return Text(f"{completed}/{total}", style="cyan")
            return Text(f"{completed}", style="cyan")

    class _DescColumn(ProgressColumn):
        """描述列：Training <output_name>（加粗）。"""
        def render(self, task):
            return Text(task.description or "Training", style="bold")

    class _PctColumn(ProgressColumn):
        """百分比列：右对齐 3 位。"""
        def render(self, task):
            if task.total:
                pct = max(0.0, min(100.0, task.completed / task.total * 100))
                return Text(f"{pct:>3.0f}%", style="bold cyan")
            return Text("--%", style="dim")

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
            return Text("  ".join(parts), style="dim")

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
        self._last_log_pos: dict[str, int] = {}  # task_id -> file byte offset for delta tracking
        self._last_progress: dict[str, dict[str, Any]] = {}  # task_id -> 最近一次有效字段
        self._last_preview_check: dict[str, float] = {}
        self._last_preview_signature: dict[str, str] = {}
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
            # 首次启动进度条
            if not cp.live.is_started:
                cp.start()
            if self._progress_task_id is None:
                self._progress_task_id = cp.add_task(
                    f"Training {output_name or ''}".strip(),
                    total=total, completed=step,
                    elapsed=progress.get("elapsed") or "",
                    eta=progress.get("eta") or "",
                    loss=progress.get("loss"),
                    lr=progress.get("lr"),
                    epoch=progress.get("epoch"),
                    speed=progress.get("speed"),
                )
                self._progress_active_task = task_id
            else:
                cp.update(
                    self._progress_task_id,
                    description=f"Training {output_name or ''}".strip(),
                    total=total, completed=step,
                    elapsed=progress.get("elapsed") or "",
                    eta=progress.get("eta") or "",
                    loss=progress.get("loss"),
                    lr=progress.get("lr"),
                    epoch=progress.get("epoch"),
                    speed=progress.get("speed"),
                )
        except Exception:
            # 控制台进度条是辅助显示，不应影响监控主流程
            pass

    def _merge_progress(self, task_id: str, updates: dict) -> dict:
        """合并增量进度；空值不能覆盖之前已经解析到的有效字段。"""
        current = self._last_progress.setdefault(task_id, {})
        for key, value in updates.items():
            if key not in _PROGRESS_FIELDS or value is None or value == "":
                continue
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
                if current_status in ("FINISHED", "TERMINATED"):
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
            train_config = latest_train_config(task_id)
            record = find_run_record_by_task_id(task_id)
            run_dir = str(record["run_path"]) if record else None
            run_dir_path = Path(run_dir) if run_dir else None

            # ── 日志增量：按文件字节偏移读取（单次 I/O，同时用于进度解析）──
            new_lines = await asyncio.to_thread(
                self._read_log_delta, task_id, run_dir_path
            )

            if new_lines:
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
                        "total": len(new_lines),
                        "truncated": log_truncated,
                    }
                })

            # TB 增量 loss 数据推送
            await self._collect_tb_incremental(
                task_id,
                run_dir=run_dir,
                output_name=train_config.get("output_name", ""),
            )
            await self._collect_preview_update(task_id, record)
        except Exception as e:
            logger.debug(f"收集任务数据失败 (task_id={task_id}): {e}")

    async def _collect_preview_update(self, task_id: str, record: dict | None) -> None:
        """Emit a tiny notice when the newest generated preview changes.

        Preview paths are metadata and remain an HTTP read; putting the image
        itself (or a whole growing preview list) on the realtime socket would
        make slow connections progressively worse.
        """
        if not record or not record.get("artifact_available"):
            return
        now = time.monotonic()
        if now - self._last_preview_check.get(task_id, 0.0) < 2.0:
            return
        self._last_preview_check[task_id] = now
        previews = await asyncio.to_thread(
            newest_previews,
            str(record["artifact_path"]),
            1,
            False,
            record.get("run_dir", ""),
        )
        latest = previews[-1] if previews else None
        if not latest:
            return
        signature = f"{latest.get('path', '')}:{latest.get('version', '')}"
        if signature == self._last_preview_signature.get(task_id):
            return
        self._last_preview_signature[task_id] = signature
        await realtime_hub.publish(task_topic(task_id), "task.artifacts", {
            "task_id": task_id,
            "kind": "training",
            "latest_preview": latest,
        })

    def _read_log_delta(self, task_id: str, output_dir_path: Path | None = None) -> list[str] | None:
        """从上次读取位置读取日志文件增量内容，返回新增行列表。
        使用字节偏移追踪，不受 _tail_file 大小限制影响。"""
        try:
            log_path = find_train_log_path(task_id, output_dir_path)
            if not log_path:
                return None

            last_pos = self._last_log_pos.get(task_id, 0)
            file_size = log_path.stat().st_size

            # 文件被截断/轮转：重置偏移
            if file_size < last_pos:
                last_pos = 0

            if file_size <= last_pos:
                return None  # 无新内容

            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(last_pos)
                content = f.read()
                new_pos = f.tell()
                self._last_log_pos[task_id] = new_pos

            if not content:
                return None

            # 清理 ANSI 转义序列 + tqdm 进度条 \r 覆盖
            content = _clean_log_text(content)
            lines = content.split("\n")
            # 如果 last_pos=0（首次读取或截断后），可能是完整文件读取；
            # 否则是增量读取，末尾空行往往是 write buffer 产生的半行
            if last_pos > 0 and lines and lines[-1] == "":
                lines.pop()

            return lines if lines else None
        except OSError:
            return None
        except Exception:
            logger.debug(f"读取日志增量失败 (task_id={task_id})", exc_info=True)
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
                    tb_progress["lr"] = f"{lr:.4e}" if 0 < abs(lr) < 0.001 else f"{lr:.6g}"
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
        self._last_status.pop(task_id, None)
        self._last_log_pos.pop(task_id, None)
        self._last_progress.pop(task_id, None)
        self._last_preview_check.pop(task_id, None)
        self._last_preview_signature.pop(task_id, None)
        logger.debug(f"清理任务状态: {task_id}")


# 全局监控器实例
task_monitor = TaskMonitor()
