"""
任务监控器：轮询任务状态并发布事件到事件总线。

功能：
- 监控任务状态变化
- 收集训练进度
- 收集硬件信息
- 发布事件到事件总线
- 控制台单行训练进度条（rich Progress，含 loss/lr/epoch/已运行/剩余）
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from backend.core.event_bus import event_bus
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import parse_log_progress, latest_train_config, read_tensorboard_incremental
from backend.monitor.artifacts import find_train_log_path, _clean_log_text
from backend.tasks import tm, TaskStatus

logger = logging.getLogger(__name__)


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
        self._poll_interval = 1.0  # 轮询间隔（秒）
        self._last_status: dict[str, str] = {}  # task_id -> last_status
        self._last_log_pos: dict[str, int] = {}  # task_id -> file byte offset for delta tracking
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
        """停止控制台进度条（结束后保留最终一行）。

        旧实例因 transient=False 在 stop 时会保留最终一行渲染在终端；
        必须把实例引用也置 None，否则任务切换时复用同一 Progress 重新 start()+add_task()
        会在旧保留行之上再叠一行，导致出现两条进度条（一条不动的残留 + 一条新刷新）。
        """
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
            # 惰性创建进度条实例
            if self._console_progress is None:
                self._console_progress = _build_console_progress()

            cp = self._console_progress
            # 任务切换：停止旧进度条，重新开始
            if self._progress_active_task and self._progress_active_task != task_id:
                self._stop_console_progress()

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
    
    async def _monitor_loop(self) -> None:
        """主监控循环"""
        while self._running:
            try:
                await self._check_all_tasks()
                await asyncio.sleep(self._poll_interval)
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
                await event_bus.publish(task_id, {
                    "type": "status_change",
                    "task_id": task_id,
                    "status": current_status,
                    "timestamp": time.time()
                })
                
                # 任务结束时清理
                if current_status in ("FINISHED", "TERMINATED"):
                    self._cleanup_task(task_id)
                    # 停止控制台进度条（结束信息由 supervisor 的 log 输出）
                    if self._progress_active_task == task_id:
                        self._stop_console_progress()
            
            # 只有运行中的任务才收集进度和日志
            if current_status == "RUNNING":
                await self._collect_task_data(task_id)
        
        # 收集硬件信息（全局）
        await self._collect_hardware()
    
    async def _collect_task_data(self, task_id: str) -> None:
        """收集任务进度和日志增量"""
        try:
            train_config = latest_train_config(task_id)
            output_dir = train_config.get("output_dir")
            output_dir_path = Path(output_dir) if output_dir else None

            # ── 日志增量：按文件字节偏移读取（单次 I/O，同时用于进度解析）──
            new_lines = await asyncio.to_thread(
                self._read_log_delta, task_id, output_dir_path
            )

            if new_lines:
                # 从增量行中解析进度（无需额外 4MB tail 读取）
                progress = await asyncio.to_thread(
                    parse_log_progress, new_lines
                )

                await event_bus.publish(task_id, {
                    "type": "progress",
                    "task_id": task_id,
                    "data": {
                        "step": progress.get("step", 0),
                        "total_steps": progress.get("total_steps", 0),
                        "percent": progress.get("percent", 0),
                        "loss": progress.get("loss"),
                        "lr": progress.get("lr"),
                        "epoch": progress.get("epoch"),
                        "eta": progress.get("eta"),
                        "elapsed": progress.get("elapsed"),
                        "speed": progress.get("speed"),
                        "has_error": progress.get("has_error", False),
                        "error_msg": progress.get("error_msg"),
                    }
                })

                # 控制台进度条
                try:
                    self._update_console_progress(
                        task_id, progress, train_config.get("output_name", "")
                    )
                except Exception:
                    pass

                await event_bus.publish(task_id, {
                    "type": "log_update",
                    "task_id": task_id,
                    "data": {
                        "lines": new_lines,
                        "total": len(new_lines),
                        "truncated": False
                    }
                })

            # TB 增量 loss 数据推送
            await self._collect_tb_incremental(task_id)
        except Exception as e:
            logger.debug(f"收集任务数据失败 (task_id={task_id}): {e}")

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

    async def _collect_tb_incremental(self, task_id: str) -> None:
        """从 TensorBoard event 文件读取增量 loss/lr 数据并推送到 SSE"""
        try:
            train_config = latest_train_config(task_id)
            output_dir = train_config.get("output_dir")
            if not output_dir:
                return
            tb_points = await asyncio.to_thread(
                read_tensorboard_incremental,
                run_dir=output_dir,
            )
            if tb_points:
                await event_bus.publish(task_id, {
                    "type": "loss_update",
                    "task_id": task_id,
                    "points": tb_points,
                    "timestamp": time.time(),
                })
        except Exception:
            logger.debug(f"TB 增量读取失败 (task_id={task_id})", exc_info=True)

    async def _collect_hardware(self) -> None:
        """收集硬件信息"""
        try:
            gpu, sys_info = await asyncio.gather(
                asyncio.to_thread(gpu_info),
                asyncio.to_thread(system_info)
            )
            
            # 广播硬件信息到所有频道
            channels = list(event_bus.get_all_channels())
            for channel in channels:
                await event_bus.publish(channel, {
                    "type": "hardware",
                    "data": {"gpu": gpu, "system": sys_info}
                })
        except Exception as e:
            logger.debug(f"收集硬件信息失败: {e}")
    
    def _cleanup_task(self, task_id: str) -> None:
        """清理任务状态"""
        self._last_status.pop(task_id, None)
        self._last_log_pos.pop(task_id, None)
        logger.debug(f"清理任务状态: {task_id}")


# 全局监控器实例
task_monitor = TaskMonitor()