"""子进程任务管理器。

线程安全的任务生命周期：创建（受并发上限约束）、执行、终止、查询、自动清理。
训练/打标等长任务统一经 `tm` 单例调度，保证 GPU 任务串行。
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from enum import Enum
from typing import Dict, List, Optional

import psutil

from backend.log import log

_FINISHED_KEEP_MAX = 20    # 终态任务最多保留条数
_FINISHED_TTL_SEC = 3600   # 终态任务保留时长（秒）


class TaskStatus(Enum):
    CREATED = 0
    RUNNING = 1
    FINISHED = 2
    TERMINATED = 3


_TERMINAL_STATUSES = frozenset({TaskStatus.FINISHED, TaskStatus.TERMINATED})


def kill_proc_tree(pid: int, including_parent: bool = True) -> None:
    """终止整棵进程树：先杀子进程再等其退出，最后按需杀父进程，确保显存释放。"""
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return

    descendants = root.children(recursive=True)
    for child in descendants:
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(descendants, timeout=5)

    if including_parent:
        try:
            root.kill()
            root.wait(5)
        except psutil.NoSuchProcess:
            pass


class Task:
    """单个子进程任务的句柄（状态流转线程安全）。"""

    def __init__(self, task_id: str, command: List[str], environ: Optional[dict] = None):
        self.task_id = task_id
        self.lock = threading.Lock()
        self.command = command
        self.status = TaskStatus.CREATED
        self.environ = environ or os.environ.copy()
        self.process: Optional[subprocess.Popen] = None
        self.created_at = time.time()
        self.finished_at: Optional[float] = None

    def _settle(self, status: TaskStatus) -> None:
        self.status = status
        self.finished_at = time.time()

    def communicate(self, input=None, timeout=None) -> subprocess.CompletedProcess:
        """等待子进程结束并收集输出。超时时先短等二次确认，仍不死则强杀。"""
        try:
            stdout, stderr = self.process.communicate(input=input, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                stdout, stderr = self.process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                stdout, stderr = self.process.communicate()
                self._settle(TaskStatus.TERMINATED)
                raise
        except Exception:
            self.process.kill()
            self._settle(TaskStatus.TERMINATED)
            raise
        self._settle(TaskStatus.FINISHED)
        return subprocess.CompletedProcess(self.process.args, self.process.returncode, stdout, stderr)

    def wait(self) -> None:
        self.process.wait()
        if self.status is not TaskStatus.TERMINATED:
            self._settle(TaskStatus.FINISHED)
        else:
            self.finished_at = time.time()

    def execute(self, stdout_file=None) -> None:
        self.status = TaskStatus.RUNNING
        popen_kwargs: dict = {"env": self.environ}
        if stdout_file is not None:
            popen_kwargs["stdout"] = stdout_file
            popen_kwargs["stderr"] = subprocess.STDOUT
        try:
            self.process = subprocess.Popen(self.command, **popen_kwargs)
        except Exception as e:
            log.error(f"Failed to start process / 启动进程失败: {e}")
            self._settle(TaskStatus.TERMINATED)
            raise

    def terminate(self) -> None:
        try:
            if self.process and self.process.pid:
                # 只杀子进程树：直接启动的父进程（如 accelerate）会在子进程
                # 死后自行退出，强行杀父进程反而可能丢掉收尾日志
                kill_proc_tree(self.process.pid, including_parent=False)
        except Exception as e:
            log.error(f"Error when killing process: {e}")
        finally:
            self._settle(TaskStatus.TERMINATED)


class TaskManager:
    """任务注册表：并发上限校验、终态任务自动清理（超时 + 超量双策略）。"""

    def __init__(self, max_concurrent: int = 1) -> None:
        self.max_concurrent = max_concurrent
        self.tasks: Dict[str, Task] = {}
        self._lock = threading.Lock()

    def _cleanup_finished(self) -> None:
        now = time.time()
        terminal = [
            (task_id, task) for task_id, task in self.tasks.items()
            if task.status in _TERMINAL_STATUSES
        ]

        evict = {
            task_id for task_id, task in terminal
            if now - (task.finished_at or task.created_at) > _FINISHED_TTL_SEC
        }
        fresh = [(task_id, task) for task_id, task in terminal if task_id not in evict]
        if len(fresh) > _FINISHED_KEEP_MAX:
            fresh.sort(key=lambda item: item[1].finished_at or item[1].created_at)
            evict.update(task_id for task_id, _ in fresh[:len(fresh) - _FINISHED_KEEP_MAX])

        for task_id in evict:
            self.tasks.pop(task_id, None)
            log.debug(f"Cleaned up finished task / 清理已完成任务: {task_id[:8]}")

    def create_task(self, command: List[str], environ: Optional[dict] = None) -> Optional[Task]:
        """原子地完成并发槽位校验与任务登记；槽位不足时返回 None。"""
        with self._lock:
            active = sum(
                1 for task in self.tasks.values()
                if task.status in (TaskStatus.CREATED, TaskStatus.RUNNING)
            )
            if active >= self.max_concurrent:
                log.error(
                    f"Unable to create task: {active} tasks active, max {self.max_concurrent}. "
                    f"/ 无法创建任务：已有 {active} 个任务占用槽位，最大并发 {self.max_concurrent}。"
                )
                return None

            task_id = str(uuid.uuid4())
            task = Task(task_id, command, environ)
            self.tasks[task_id] = task
            self._cleanup_finished()
            log.info(f"Task {task_id[:8]} created / 任务已创建")
            return task

    def add_task(self, task_id: str, task: Task) -> None:
        with self._lock:
            self.tasks[task_id] = task

    def terminate_task(self, task_id: str) -> None:
        with self._lock:
            task = self.tasks.get(task_id)
        if task is not None:
            task.terminate()

    def dump(self) -> List[Dict]:
        """全部任务的快照（线程安全），状态以枚举名（如 RUNNING）给出。"""
        with self._lock:
            return [
                {"id": task.task_id, "status": task.status.name}
                for task in self.tasks.values()
            ]


tm = TaskManager()
