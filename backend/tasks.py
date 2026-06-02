"""
Anima Backend — 子进程任务管理器

线程安全的任务生命周期管理：创建、执行、终止、查询、清理。
"""
from __future__ import annotations

import subprocess
import os
import threading
import time
import uuid
from enum import Enum
from typing import Dict, List, Optional

import psutil

from backend.log import log

try:
    import msvcrt
    import _winapi
    _mswindows = True
except ModuleNotFoundError:
    _mswindows = False

# 已完成任务最大保留数（超出后自动清理最旧的）
_MAX_FINISHED_TASKS = 20
# 已完成任务最大保留时间（秒），超过此时间的任务自动清理
_MAX_TASK_AGE = 3600


def kill_proc_tree(pid: int, including_parent: bool = True) -> None:
    """递归终止进程树，确保 GPU 资源释放"""
    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    children = parent.children(recursive=True)
    for child in children:
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(children, timeout=5)
    if including_parent:
        try:
            parent.kill()
            parent.wait(5)
        except psutil.NoSuchProcess:
            pass


class TaskStatus(Enum):
    CREATED = 0
    RUNNING = 1
    FINISHED = 2
    TERMINATED = 3


class Task:
    """单个训练任务（线程安全）"""

    def __init__(self, task_id: str, command: List[str], environ: Optional[dict] = None):
        self.task_id = task_id
        self.lock = threading.Lock()
        self.command = command
        self.status = TaskStatus.CREATED
        self.environ = environ or os.environ.copy()
        self.process: Optional[subprocess.Popen] = None
        self.created_at = time.time()
        self.finished_at: Optional[float] = None

    def communicate(self, input=None, timeout=None):
        """等待子进程结束并收集输出。超时时先尝试获取已有输出再 kill。"""
        try:
            stdout, stderr = self.process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            # 先尝试收集已有输出，再 kill
            try:
                stdout, stderr = self.process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                stdout, stderr = self.process.communicate()
                self.status = TaskStatus.TERMINATED
                raise
            else:
                # 内层重试成功，进程已结束，不要再 kill
                retcode = self.process.poll()
                self.status = TaskStatus.FINISHED
                self.finished_at = time.time()
                return subprocess.CompletedProcess(self.process.args, retcode, stdout, stderr)
        except Exception:
            self.process.kill()
            self.status = TaskStatus.TERMINATED
            raise
        retcode = self.process.poll()
        self.status = TaskStatus.FINISHED
        self.finished_at = time.time()
        return subprocess.CompletedProcess(self.process.args, retcode, stdout, stderr)

    def wait(self):
        self.process.wait()
        if self.status != TaskStatus.TERMINATED:
            self.status = TaskStatus.FINISHED
        self.finished_at = time.time()

    def execute(self, stdout_file=None):
        self.status = TaskStatus.RUNNING
        kwargs: dict = {"env": self.environ}
        if stdout_file:
            kwargs["stdout"] = stdout_file
            kwargs["stderr"] = subprocess.STDOUT
        try:
            self.process = subprocess.Popen(self.command, **kwargs)
        except Exception as e:
            log.error(f"Failed to start process / 启动进程失败: {e}")
            self.status = TaskStatus.TERMINATED
            self.finished_at = time.time()
            raise

    def terminate(self):
        try:
            if self.process and self.process.pid:
                kill_proc_tree(self.process.pid, including_parent=False)
        except Exception as e:
            log.error(f"Error when killing process: {e}")
        finally:
            self.status = TaskStatus.TERMINATED
            self.finished_at = time.time()


class TaskManager:
    """线程安全的任务管理器"""

    def __init__(self, max_concurrent: int = 1) -> None:
        self.max_concurrent = max_concurrent
        self.tasks: Dict[str, Task] = {}
        self._lock = threading.Lock()

    def _cleanup_finished(self) -> None:
        """清理超时的已完成/已终止任务，以及超出数量上限的任务"""
        now = time.time()
        to_remove = []
        finished = [
            (tid, t) for tid, t in self.tasks.items()
            if t.status in (TaskStatus.FINISHED, TaskStatus.TERMINATED)
        ]
        # 先按时间过期清理
        for tid, t in finished:
            age = now - (t.finished_at or t.created_at)
            if age > _MAX_TASK_AGE:
                to_remove.append(tid)
        # 如果仍然超出数量上限，再按数量清理最旧的
        remaining_finished = [
            (tid, t) for tid, t in finished if tid not in to_remove
        ]
        if len(remaining_finished) > _MAX_FINISHED_TASKS:
            remaining_finished.sort(key=lambda x: x[1].finished_at or x[1].created_at)
            overflow = remaining_finished[:len(remaining_finished) - _MAX_FINISHED_TASKS]
            for tid, _ in overflow:
                to_remove.append(tid)
        for tid in to_remove:
            del self.tasks[tid]
            log.debug(f"Cleaned up finished task / 清理已完成任务: {tid[:8]}")

    def create_task(self, command: List[str], environ: Optional[dict] = None) -> Optional[Task]:
        """原子操作：检查并发限制 + 创建任务"""
        with self._lock:
            running_count = sum(1 for t in self.tasks.values() if t.status == TaskStatus.RUNNING)
            if running_count >= self.max_concurrent:
                log.error(
                    f"Unable to create task: {running_count} tasks running, max {self.max_concurrent}. "
                    f"/ 无法创建任务：已有 {running_count} 个任务运行中，最大并发 {self.max_concurrent}。"
                )
                return None

            task_id = str(uuid.uuid4())
            task = Task(task_id=task_id, command=command, environ=environ)
            self.tasks[task_id] = task
            self._cleanup_finished()
            log.info(f"Task {task_id[:8]} created / 任务已创建")
            return task

    def add_task(self, task_id: str, task: Task) -> None:
        with self._lock:
            self.tasks[task_id] = task

    def terminate_task(self, task_id: str) -> None:
        task = None
        with self._lock:
            task = self.tasks.get(task_id)
        if task:
            task.terminate()

    def wait_for_process(self, task_id: str) -> None:
        task = None
        with self._lock:
            task = self.tasks.get(task_id)
        if task:
            task.wait()

    def dump(self) -> List[Dict]:
        """返回所有任务的快照（线程安全）"""
        with self._lock:
            return [
                {
                    "id": t.task_id,
                    "status": t.status.name,
                }
                for t in self.tasks.values()
            ]

    def get_task(self, task_id: str) -> Optional[Task]:
        with self._lock:
            return self.tasks.get(task_id)


tm = TaskManager()
