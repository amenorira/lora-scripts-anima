"""
任务监控器：轮询任务状态并发布事件到事件总线。

功能：
- 监控任务状态变化
- 收集训练进度
- 收集硬件信息
- 发布事件到事件总线
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from backend.core.event_bus import event_bus
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import parse_log_progress, latest_train_config
from backend.monitor.artifacts import read_train_log
from backend.tasks import tm, TaskStatus

logger = logging.getLogger(__name__)


class TaskMonitor:
    """任务监控器"""
    
    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None
        self._poll_interval = 1.0  # 轮询间隔（秒）
        self._log_push_lines = 1000  # 单次推送日志行数上限
        self._last_status: dict[str, str] = {}  # task_id -> last_status
        self._last_log_line: dict[str, int] = {}  # task_id -> last_log_line_count
    
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
        logger.info("任务监控器已停止")
    
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
            
            # 只有运行中的任务才收集进度和日志
            if current_status == "RUNNING":
                await self._collect_task_data(task_id)
        
        # 收集硬件信息（全局）
        await self._collect_hardware()
    
    async def _collect_task_data(self, task_id: str) -> None:
        """收集任务进度和日志增量（合并为一次日志文件读取）"""
        try:
            # 读取日志文件（一次 I/O）
            log_lines = await asyncio.to_thread(
                self._read_task_log, task_id
            )
            if not log_lines:
                return
            
            # 解析进度
            progress = await asyncio.to_thread(
                parse_log_progress, log_lines
            )
            
            # 发布进度事件
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
                    "speed": progress.get("speed"),
                    "has_error": progress.get("has_error", False),
                    "error_msg": progress.get("error_msg"),
                }
            })
            
            # 计算日志增量
            last_count = self._last_log_line.get(task_id, 0)
            current_count = len(log_lines)
            
            if current_count > last_count:
                new_lines = log_lines[last_count:current_count]
                self._last_log_line[task_id] = current_count
                
                await event_bus.publish(task_id, {
                    "type": "log_update",
                    "task_id": task_id,
                    "data": {
                        "lines": new_lines[-self._log_push_lines:],
                        "total": current_count,
                        "truncated": len(new_lines) > self._log_push_lines
                    }
                })
        except Exception as e:
            logger.debug(f"收集任务数据失败 (task_id={task_id}): {e}")
    
    async def _collect_hardware(self) -> None:
        """收集硬件信息"""
        try:
            gpu, sys_info = await asyncio.gather(
                asyncio.to_thread(gpu_info),
                asyncio.to_thread(system_info)
            )
            
            # 广播硬件信息到所有频道
            for channel in event_bus.get_all_channels():
                await event_bus.publish(channel, {
                    "type": "hardware",
                    "data": {"gpu": gpu, "system": sys_info}
                })
        except Exception as e:
            logger.debug(f"收集硬件信息失败: {e}")
    
    def _read_task_log(self, task_id: str) -> list[str] | None:
        """读取任务日志"""
        try:
            train_config = latest_train_config()
            output_dir = train_config.get("output_dir")
            log_lines = read_train_log(
                task_id,
                Path(output_dir) if output_dir else None
            )
            return log_lines or None
        except Exception:
            return None
    
    def _cleanup_task(self, task_id: str) -> None:
        """清理任务状态"""
        self._last_status.pop(task_id, None)
        self._last_log_line.pop(task_id, None)
        logger.debug(f"清理任务状态: {task_id}")


# 全局监控器实例
task_monitor = TaskMonitor()