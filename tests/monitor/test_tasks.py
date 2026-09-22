import asyncio
import json
import subprocess
import sys
import threading
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import psutil

from backend.tasks import Task, TaskManager, TaskStatus


class TaskStateMachineTests(unittest.TestCase):
    def _process(self, returncode=0):
        process = Mock()
        process.pid = 1234
        process.args = ["trainer"]
        process.returncode = returncode
        process.communicate.return_value = (b"", b"")
        process.wait.return_value = returncode
        return process

    def test_normal_exit_settles_finished(self):
        task = Task("ok", ["trainer"])
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(0)):
            task.execute()
            result = task.communicate()

        self.assertEqual(result.returncode, 0)
        self.assertIs(task.status, TaskStatus.FINISHED)

    def test_nonzero_exit_settles_failed(self):
        task = Task("failed", ["trainer"])
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(2)):
            task.execute()
            task.communicate()

        self.assertIs(task.status, TaskStatus.FAILED)

    def test_termination_wins_over_later_process_cleanup(self):
        task = Task("terminated", ["trainer"])
        process = self._process(0)
        with patch("backend.tasks.subprocess.Popen", return_value=process), patch(
            "backend.tasks.kill_proc_tree"
        ):
            task.execute()
            task.terminate()
            task.communicate()

        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_termination_before_start_prevents_process_launch(self):
        task = Task("cancelled-before-start", ["trainer"])
        task.terminate()

        with patch("backend.tasks.subprocess.Popen") as popen:
            with self.assertRaises(RuntimeError):
                task.execute()

        popen.assert_not_called()
        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_failed_process_is_not_counted_as_active(self):
        manager = TaskManager(max_concurrent=1)
        task = manager.create_task(["trainer"])
        self.assertIsNotNone(task)
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(2)):
            task.execute()
            task.communicate()

        replacement = manager.create_task(["trainer-2"])

        self.assertIsNotNone(replacement)
        self.assertEqual(manager.dump()[0]["status"], "FAILED")

    def test_stop_direct_process_before_releasing_slot(self):
        manager = TaskManager()
        task = manager.create_task([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            task.execute()
            task.terminate()
            self.assertIsNotNone(task.process.poll())
            self.assertIs(task.status, TaskStatus.TERMINATED)
            self.assertIsNotNone(manager.create_task(["replacement"]))
        finally:
            if task.process and task.process.poll() is None:
                task.process.kill()
                task.process.wait()

    def test_failed_stop_keeps_slot_and_can_be_retried(self):
        manager = TaskManager()
        task = manager.create_task(["trainer"])
        with patch("backend.tasks.subprocess.Popen", return_value=self._process()):
            task.execute()
        with patch("backend.tasks.kill_proc_tree", side_effect=OSError("busy")):
            with self.assertRaises(OSError):
                task.terminate()
        # 父进程先退出，也不能掩盖进程树清理失败或向调用方报告成功。
        with self.assertRaisesRegex(RuntimeError, "termination incomplete"):
            task.communicate()
        self.assertIs(task.status, TaskStatus.RUNNING)
        self.assertIsNone(manager.create_task(["replacement"]))
        with patch("backend.tasks.kill_proc_tree") as kill:
            task.terminate()
        kill.assert_called_once_with(task.process.pid, processes=task._process_tree)
        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_stop_waits_for_real_parent_and_child_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "child.txt"
            script = (
                "import subprocess,sys,time; from pathlib import Path; "
                "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                "Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
            )
            task = Task("tree", [sys.executable, "-c", script, str(ready)])
            child = None
            try:
                task.execute()
                deadline = time.monotonic() + 5
                while (not ready.exists() or not ready.read_text()) and time.monotonic() < deadline:
                    time.sleep(0.01)
                child = psutil.Process(int(ready.read_text()))
                task.terminate()
                self.assertFalse(child.is_running())
                self.assertIsNotNone(task.process.poll())
                self.assertIs(task.status, TaskStatus.TERMINATED)
            finally:
                if child and child.is_running():
                    child.kill()
                    child.wait(5)
                if task.process and task.process.poll() is None:
                    task.process.kill()
                    task.process.wait()

    def test_process_exit_during_tree_cleanup_does_not_release_slot(self):
        for method in ("communicate", "wait"):
            for returncode in (0, 1):
                with self.subTest(method=method, returncode=returncode):
                    manager = TaskManager()
                    task = manager.create_task(["trainer"])
                    process = self._process(returncode)
                    cleanup_started, release = threading.Event(), threading.Event()
                    parent_exited, finished = threading.Event(), threading.Event()
                    outcomes, errors = [], []

                    def exited(*args, **kwargs):
                        parent_exited.set()
                        return (b"", b"") if method == "communicate" else returncode

                    getattr(process, method).side_effect = exited
                    with patch("backend.tasks.subprocess.Popen", return_value=process):
                        task.execute()

                    def cleanup(*args, **kwargs):
                        cleanup_started.set()
                        if not release.wait(5):
                            raise TimeoutError("test cleanup was not released")

                    def stop():
                        try:
                            task.terminate()
                        except Exception as exc:
                            errors.append(exc)

                    def collect():
                        try:
                            getattr(task, method)()
                            outcomes.append(task.status)
                        except Exception as exc:
                            errors.append(exc)
                        finally:
                            finished.set()

                    with patch("backend.tasks.kill_proc_tree", side_effect=cleanup):
                        stopper = threading.Thread(target=stop)
                        collector = threading.Thread(target=collect)
                        stopper.start()
                        try:
                            self.assertTrue(cleanup_started.wait(5))
                            collector.start()
                            self.assertTrue(parent_exited.wait(5))
                            self.assertFalse(finished.wait(0.05))
                            self.assertIs(task.status, TaskStatus.RUNNING)
                            self.assertIsNone(manager.create_task(["replacement"]))
                        finally:
                            release.set()
                            stopper.join(5)
                            if collector.ident is not None:
                                collector.join(5)
                        self.assertFalse(stopper.is_alive() or collector.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(outcomes, [TaskStatus.TERMINATED])
                    self.assertIsNotNone(manager.create_task(["replacement"]))

    def test_stop_waits_for_startup_to_publish_process(self):
        entered, release = threading.Event(), threading.Event()
        task = Task("startup", ["trainer"])
        process = self._process()

        def popen(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return process

        with patch("backend.tasks.subprocess.Popen", side_effect=popen), patch("backend.tasks.kill_proc_tree") as kill:
            start = threading.Thread(target=task.execute)
            stop = threading.Thread(target=task.terminate)
            start.start()
            try:
                self.assertTrue(entered.wait(5))
                stop.start()
                self.assertIs(task.status, TaskStatus.RUNNING)
            finally:
                release.set()
                start.join(5)
                stop.join(5)
            self.assertFalse(start.is_alive() or stop.is_alive())
            kill.assert_called_once_with(process.pid, processes=task._process_tree)
        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_supervisor_records_manual_stop_after_tree_cleanup(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            process = self._process(1)
            collecting, killed, release = threading.Event(), threading.Event(), threading.Event()
            callbacks = []

            def communicate(**kwargs):
                collecting.set()
                if not killed.wait(5):
                    raise TimeoutError("test process was not stopped")
                return None, None

            def cleanup(*args, **kwargs):
                killed.set()
                if not release.wait(5):
                    raise TimeoutError("test cleanup was not released")

            process.communicate.side_effect = communicate
            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 patch("backend.tasks.subprocess.Popen", return_value=process), \
                 patch("backend.tasks.kill_proc_tree", side_effect=cleanup):
                response = supervisor.run_train("config.toml", run_dir=directory, on_complete=callbacks.append)
                self.assertEqual(response["status"], "success")
                background = next(t for t in asyncio.all_tasks() if t is not asyncio.current_task())
                stopper = None
                try:
                    self.assertTrue(await asyncio.to_thread(collecting.wait, 5))
                    stopper = asyncio.create_task(asyncio.to_thread(manager.terminate_task, response["data"]["task_id"]))
                    self.assertTrue(await asyncio.to_thread(killed.wait, 5))
                    await asyncio.sleep(0.05)
                    self.assertFalse((Path(directory) / "result.json").exists())
                    self.assertEqual(callbacks, [])
                finally:
                    release.set()
                    if stopper is not None:
                        await asyncio.wait_for(stopper, 5)
                    await asyncio.wait_for(background, 5)
                result = json.loads((Path(directory) / "result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "terminated")
                self.assertEqual(callbacks, ["terminated"])

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))


if __name__ == "__main__":
    unittest.main()
