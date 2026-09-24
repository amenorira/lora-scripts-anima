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
    FAILED = 4


_TERMINAL_STATUSES = frozenset({TaskStatus.FINISHED, TaskStatus.TERMINATED, TaskStatus.FAILED})


def kill_proc_tree(pid: int, *, processes: list | None = None) -> None:
    """终止进程树并确认退出；超时不能当作已释放资源。"""
    if processes is None:
        processes = []
    try:
        if not processes:
            processes.append(psutil.Process(pid))
        # 保留已发现的句柄：父进程退出后重试，仍能清理此前未退出的子进程。
        for process in processes[0].children(recursive=True):
            if process not in processes:
                processes.append(process)
    except psutil.NoSuchProcess:
        pass
    for child in processes:
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(processes, timeout=5)
    if alive:
        raise psutil.TimeoutExpired(5, pid=alive[0].pid)


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
        self._terminate_requested = False
        self._termination_lock = threading.Lock()
        self._process_tree: list = []
        self._termination_complete = False
        self._exit_collected = False
        self._work_complete = False

    def configure_reserved(self, command: List[str]) -> None:
        """Hand a reserved slot to the launcher without opening a second slot."""
        with self.lock:
            if self.status is not TaskStatus.CREATED or self._terminate_requested:
                raise RuntimeError("Reserved task is no longer startable")
            self.command = command

    @property
    def stop_requested(self) -> bool:
        with self.lock:
            return self._terminate_requested

    def complete_work(self) -> None:
        """Signal that preparation or worker callbacks are done, then try to release the slot."""
        with self._termination_lock:
            with self.lock:
                self._work_complete = True
            self._publish_terminal_if_ready_locked()

    def _publish_terminal_if_ready_locked(self) -> None:
        """The only terminal transition; caller holds _termination_lock."""
        with self.lock:
            if self.status in _TERMINAL_STATUSES or not self._work_complete:
                return
            if self._terminate_requested:
                if self.process is not None and not self._termination_complete:
                    # The parent may exit first; a later successful stop retry settles it.
                    return
                self.status = TaskStatus.TERMINATED
            elif self.process is None:
                self.status = TaskStatus.FAILED
            elif self._exit_collected:
                self.status = TaskStatus.FINISHED if self.process.returncode == 0 else TaskStatus.FAILED
            else:
                return
            self.finished_at = time.time()

    def _confirm_process_exit(self) -> None:
        # Wait for any in-progress tree cleanup before returning process output.
        with self._termination_lock:
            with self.lock:
                self._exit_collected = True
                if self._terminate_requested and not self._termination_complete:
                    raise RuntimeError("Process tree termination incomplete / 进程树终止未完成，请重试停止")
            self._publish_terminal_if_ready_locked()

    def communicate(self, input=None, timeout=None) -> subprocess.CompletedProcess:
        """等待子进程并收集输出；业务所有者完成结果与回调后调用 complete_work。"""
        try:
            stdout, stderr = self.process.communicate(input=input, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                stdout, stderr = self.process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                self.terminate()
                stdout, stderr = self.process.communicate()
                raise
        except Exception:
            self.terminate()
            raise
        self._confirm_process_exit()
        return subprocess.CompletedProcess(self.process.args, self.process.returncode, stdout, stderr)

    def wait(self) -> None:
        self.process.wait()
        self._confirm_process_exit()

    def execute(self, stdout_file=None) -> None:
        popen_kwargs: dict = {"env": self.environ}
        if stdout_file is not None:
            popen_kwargs["stdout"] = stdout_file
            popen_kwargs["stderr"] = subprocess.STDOUT
        with self.lock:
            if self.status is not TaskStatus.CREATED or self._terminate_requested:
                raise RuntimeError("Task is no longer startable")
            self.status = TaskStatus.RUNNING
            try:
                # 发布进程句柄与启动互斥，停止请求不会在 Popen 期间提前释放名额。
                self.process = subprocess.Popen(self.command, **popen_kwargs)
            except Exception as e:
                log.error(f"Failed to start process / 启动进程失败: {e}")
                raise

    def terminate(self) -> None:
        with self._termination_lock:
            with self.lock:
                if self.status in _TERMINAL_STATUSES:
                    return
                if self._exit_collected and not self._terminate_requested:
                    # The process has finished; its owner is completing result/callback work.
                    return
                self._terminate_requested = True
                process = self.process
                cleanup_done = self._termination_complete
            if process is None or cleanup_done:
                self._publish_terminal_if_ready_locked()
                return
            if process is not None:
                kill_proc_tree(process.pid, processes=self._process_tree)
                process.wait(timeout=5)
            with self.lock:
                self._termination_complete = True
            self._publish_terminal_if_ready_locked()

    def snapshot(self) -> dict:
        with self.lock:
            return {"id": self.task_id, "status": self.status.name}


class TaskManager:
    """任务注册表：并发上限校验、终态任务自动清理（超时 + 超量双策略）。"""

    def __init__(self, max_concurrent: int = 1) -> None:
        self.max_concurrent = max_concurrent
        self.tasks: Dict[str, Task] = {}
        self._lock = threading.Lock()
        self._external_claims: set[str] = set()
        self._dataset_readers: set[str] = set()
        self._dataset_mutation = False

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
            if active >= self.max_concurrent or self._external_claims or self._dataset_mutation:
                log.warning(
                    "Unable to create task / 无法创建任务：active=%s, max=%s, tagger_claims=%s, dataset_mutation=%s",
                    active, self.max_concurrent, len(self._external_claims), self._dataset_mutation,
                )
                return None

            task_id = str(uuid.uuid4())
            task = Task(task_id, command, environ)
            self.tasks[task_id] = task
            self._cleanup_finished()
            log.info(f"Task {task_id[:8]} created / 任务已创建")
            return task

    def reserve_task(self) -> Optional[Task]:
        """Reserve the existing task slot before dataset preflight or run-file writes."""
        return self.create_task([])

    def release_reserved(self, task: Task) -> None:
        """Release a preparation only after its owner has finished disk work."""
        with task.lock:
            if task.process is not None:
                raise RuntimeError("Cannot release a task after its worker started")
        task.complete_work()
        with self._lock:
            if self.tasks.get(task.task_id) is task:
                self.tasks.pop(task.task_id)

    def claim_external(self, owner: str) -> bool:
        """Atomically exclude a Tagger job from training and other GPU claims."""
        with self._lock:
            active = any(task.status in (TaskStatus.CREATED, TaskStatus.RUNNING) for task in self.tasks.values())
            if active or self._external_claims or self._dataset_mutation:
                return False
            self._external_claims.add(owner)
            return True

    def release_external(self, owner: str) -> None:
        with self._lock:
            self._external_claims.discard(owner)

    def claim_dataset_reader(self, owner: str) -> bool:
        """Keep a read-only remote Tagger scan stable during folder renames."""
        with self._lock:
            if self._dataset_mutation:
                return False
            self._dataset_readers.add(owner)
            return True

    def release_dataset_reader(self, owner: str) -> None:
        with self._lock:
            self._dataset_readers.discard(owner)

    def begin_dataset_mutation(self) -> bool:
        """Keep folder renames outside training preparation and execution."""
        with self._lock:
            active = any(task.status in (TaskStatus.CREATED, TaskStatus.RUNNING) for task in self.tasks.values())
            if active or self._external_claims or self._dataset_readers or self._dataset_mutation:
                return False
            self._dataset_mutation = True
            return True

    def end_dataset_mutation(self) -> None:
        with self._lock:
            self._dataset_mutation = False

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
            return [task.snapshot() for task in self.tasks.values()]


tm = TaskManager()
