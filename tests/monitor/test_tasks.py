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
            task.complete_work()

        self.assertEqual(result.returncode, 0)
        self.assertIs(task.status, TaskStatus.FINISHED)

    def test_nonzero_exit_settles_failed(self):
        task = Task("failed", ["trainer"])
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(2)):
            task.execute()
            task.communicate()
            task.complete_work()

        self.assertIs(task.status, TaskStatus.FAILED)

    def test_process_exit_after_work_completion_publishes_terminal_once(self):
        task = Task("late-exit", ["trainer"])
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(0)):
            task.execute()
            task.complete_work()
            self.assertIs(task.status, TaskStatus.RUNNING)
            task.communicate()
            finished_at = task.finished_at
            task.complete_work()

        self.assertIs(task.status, TaskStatus.FINISHED)
        self.assertEqual(task.finished_at, finished_at)

    def test_termination_wins_over_later_process_cleanup(self):
        task = Task("terminated", ["trainer"])
        process = self._process(0)
        with patch("backend.tasks.subprocess.Popen", return_value=process), patch(
            "backend.tasks.kill_proc_tree"
        ):
            task.execute()
            task.terminate()
            task.communicate()
            task.complete_work()

        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_termination_before_start_prevents_process_launch(self):
        task = Task("cancelled-before-start", ["trainer"])
        task.terminate()
        task.complete_work()

        with patch("backend.tasks.subprocess.Popen") as popen:
            with self.assertRaises(RuntimeError):
                task.execute()

        popen.assert_not_called()
        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_reserved_slot_blocks_other_tasks_until_release_or_process_exit(self):
        manager = TaskManager()
        reserved = manager.reserve_task()
        self.assertIsNotNone(reserved)
        self.assertIsNone(manager.reserve_task())
        self.assertFalse(manager.claim_external("tagger:one"))

        reserved.configure_reserved(["trainer"])
        # Configuring a command is still preparation; only the launcher may
        # transfer ownership to a running worker.
        self.assertIsNone(manager.reserve_task())
        reserved.terminate()
        self.assertIsNone(manager.reserve_task())
        manager.release_reserved(reserved)
        self.assertIsNotNone(manager.reserve_task())

    def test_stop_during_preparation_keeps_slot_until_owner_settles(self):
        manager = TaskManager()
        reserved = manager.reserve_task()
        manager.terminate_task(reserved.task_id)
        self.assertIs(reserved.status, TaskStatus.CREATED)
        self.assertTrue(reserved.stop_requested)
        self.assertIsNone(manager.reserve_task())
        self.assertFalse(manager.begin_dataset_mutation())
        with self.assertRaises(RuntimeError):
            reserved.configure_reserved(["trainer"])
        manager.release_reserved(reserved)
        self.assertIsNotNone(manager.reserve_task())

    def test_external_claim_and_dataset_mutation_are_atomic_with_reservation(self):
        manager = TaskManager()
        self.assertTrue(manager.begin_dataset_mutation())
        self.assertIsNone(manager.reserve_task())
        self.assertFalse(manager.claim_external("tagger:one"))
        manager.end_dataset_mutation()
        self.assertTrue(manager.claim_external("tagger:one"))
        self.assertFalse(manager.claim_external("tagger:two"))
        self.assertIsNone(manager.reserve_task())
        manager.release_external("tagger:one")
        reserved = manager.reserve_task()
        self.assertIsNotNone(reserved)
        self.assertFalse(manager.begin_dataset_mutation())
        manager.release_reserved(reserved)
        self.assertTrue(manager.begin_dataset_mutation())
        manager.end_dataset_mutation()

    def test_read_only_dataset_claim_allows_training_but_blocks_rename(self):
        manager = TaskManager()
        self.assertTrue(manager.claim_dataset_reader("remote:one"))
        reserved = manager.reserve_task()
        self.assertIsNotNone(reserved)
        manager.release_reserved(reserved)
        self.assertFalse(manager.begin_dataset_mutation())
        manager.release_dataset_reader("remote:one")
        self.assertTrue(manager.begin_dataset_mutation())
        self.assertFalse(manager.claim_dataset_reader("remote:two"))
        manager.end_dataset_mutation()

    def test_failed_process_is_not_counted_as_active(self):
        manager = TaskManager(max_concurrent=1)
        task = manager.create_task(["trainer"])
        self.assertIsNotNone(task)
        with patch("backend.tasks.subprocess.Popen", return_value=self._process(2)):
            task.execute()
            task.communicate()
            task.complete_work()

        replacement = manager.create_task(["trainer-2"])

        self.assertIsNotNone(replacement)
        self.assertEqual(manager.dump()[0]["status"], "FAILED")

    def test_stop_direct_process_before_releasing_slot(self):
        manager = TaskManager()
        task = manager.create_task([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            task.execute()
            task.terminate()
            task.complete_work()
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
        task.complete_work()
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
                task.complete_work()
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
                            task.complete_work()
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
        task.complete_work()
        self.assertIs(task.status, TaskStatus.TERMINATED)

    def test_supervisor_records_manual_stop_after_tree_cleanup(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            process = self._process(1)
            collecting, killed, release = threading.Event(), threading.Event(), threading.Event()
            callback_release = threading.Event()
            callbacks = []
            completed = threading.Event()

            def on_complete(status):
                callbacks.append(status)
                completed.set()
                if not callback_release.wait(5):
                    raise TimeoutError("completion callback was not released")

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
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved, on_complete=on_complete,
                )
                self.assertEqual(response["status"], "success")
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
                    self.assertTrue(await asyncio.to_thread(completed.wait, 5))
                try:
                    self.assertIs(manager.tasks[response["data"]["task_id"]].status, TaskStatus.RUNNING)
                    self.assertIsNone(manager.reserve_task())
                finally:
                    callback_release.set()
                for _ in range(100):
                    if manager.tasks[response["data"]["task_id"]].status is TaskStatus.TERMINATED:
                        break
                    await asyncio.sleep(0.01)
                result = json.loads((Path(directory) / "result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "terminated")
                self.assertEqual(callbacks, ["terminated"])
                self.assertIs(manager.tasks[response["data"]["task_id"]].status, TaskStatus.TERMINATED)

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_retry_after_worker_exit_releases_slot_once(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            process = self._process(1)
            collecting, release_process = threading.Event(), threading.Event()
            callbacks = []
            worker_futures = []
            loop = asyncio.get_running_loop()
            run_in_executor = loop.run_in_executor
            kills = []

            def communicate(**_kwargs):
                collecting.set()
                if not release_process.wait(5):
                    raise TimeoutError("process exit was not released")
                return b"", b""

            def kill(*_args, **_kwargs):
                kills.append(True)
                if len(kills) == 1:
                    raise OSError("busy")

            def submit(executor, func, *args):
                future = run_in_executor(executor, func, *args)
                if getattr(func, "__name__", "") == "_run":
                    worker_futures.append(future)
                return future

            process.communicate.side_effect = communicate
            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 patch.object(loop, "run_in_executor", side_effect=submit), \
                 patch("backend.tasks.subprocess.Popen", return_value=process), \
                 patch("backend.tasks.kill_proc_tree", side_effect=kill):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved,
                    on_complete=callbacks.append,
                )
                self.assertEqual(response["status"], "success")
                try:
                    self.assertTrue(await asyncio.to_thread(collecting.wait, 5))
                    with self.assertRaisesRegex(OSError, "busy"):
                        manager.terminate_task(reserved.task_id)
                    self.assertIs(reserved.status, TaskStatus.RUNNING)
                    self.assertIsNone(manager.reserve_task())
                    self.assertFalse(manager.claim_external("tagger"))
                    self.assertFalse(manager.begin_dataset_mutation())
                finally:
                    release_process.set()
                self.assertEqual(len(worker_futures), 1)
                worker_result = await asyncio.gather(worker_futures[0], return_exceptions=True)
                self.assertEqual(len(callbacks), 1)
                self.assertIs(reserved.status, TaskStatus.RUNNING)
                self.assertIsNone(manager.reserve_task())
                self.assertFalse(manager.claim_external("tagger:after-worker"))
                self.assertFalse(manager.begin_dataset_mutation())
                manager.terminate_task(reserved.task_id)
                self.assertIs(reserved.status, TaskStatus.TERMINATED)
                self.assertEqual(len(kills), 2)
                self.assertEqual(len(callbacks), 1)
                self.assertIsNone(worker_result[0])
                self.assertIsNotNone(manager.reserve_task())

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_retry_waits_for_blocked_completion_callback(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            process = self._process(1)
            collecting, release_process = threading.Event(), threading.Event()
            callback_entered, release_callback = threading.Event(), threading.Event()
            callbacks = []
            kills = []

            def communicate(**_kwargs):
                collecting.set()
                if not release_process.wait(5):
                    raise TimeoutError("process exit was not released")
                return b"", b""

            def kill(*_args, **_kwargs):
                kills.append(True)
                if len(kills) == 1:
                    raise OSError("busy")

            def on_complete(status):
                callbacks.append(status)
                callback_entered.set()
                if not release_callback.wait(5):
                    raise TimeoutError("callback was not released")

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
                 patch("backend.tasks.kill_proc_tree", side_effect=kill):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved,
                    on_complete=on_complete,
                )
                self.assertEqual(response["status"], "success")
                try:
                    self.assertTrue(await asyncio.to_thread(collecting.wait, 5))
                    with self.assertRaisesRegex(OSError, "busy"):
                        manager.terminate_task(reserved.task_id)
                    release_process.set()
                    self.assertTrue(await asyncio.to_thread(callback_entered.wait, 5))
                    manager.terminate_task(reserved.task_id)
                    self.assertIs(reserved.status, TaskStatus.RUNNING)
                    self.assertIsNone(manager.reserve_task())
                finally:
                    release_process.set()
                    release_callback.set()
                for _ in range(100):
                    if reserved.status is TaskStatus.TERMINATED:
                        break
                    await asyncio.sleep(0.01)
                self.assertIs(reserved.status, TaskStatus.TERMINATED)
                self.assertEqual(len(callbacks), 1)
                self.assertEqual(len(kills), 2)
                self.assertIsNotNone(manager.reserve_task())

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_holds_slot_until_completion_callback_returns(self):
        from backend.training import supervisor
        from backend.training import musubi_krea2

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            entered, release = threading.Event(), threading.Event()
            cache_dir = Path(directory) / "cache"
            old = {"dataset_cache_dir": str(cache_dir), "fingerprint": "old"}
            new = {"dataset_cache_dir": str(cache_dir), "fingerprint": "new"}
            musubi_krea2.prepare_cache_manifest(old)

            def on_complete(status):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("completion callback was not released")
                musubi_krea2.mark_cache_manifest(old, status)

            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 patch.object(musubi_krea2, "krea2_cache_fingerprint", side_effect=lambda config: config["fingerprint"]), \
                 patch("backend.tasks.subprocess.Popen", return_value=self._process(0)):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved, on_complete=on_complete,
                )
                self.assertEqual(response["status"], "success")
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    self.assertIs(reserved.status, TaskStatus.RUNNING)
                    self.assertIsNone(manager.reserve_task())
                    self.assertFalse(manager.begin_dataset_mutation())
                finally:
                    release.set()
                for _ in range(100):
                    if reserved.status is TaskStatus.FINISHED:
                        break
                    await asyncio.sleep(0.01)
                self.assertIs(reserved.status, TaskStatus.FINISHED)
                replacement = manager.reserve_task()
                self.assertIsNotNone(replacement)
                musubi_krea2.prepare_cache_manifest(new)
                manifest = json.loads(musubi_krea2.cache_manifest_path(cache_dir).read_text(encoding="utf-8"))
                self.assertEqual(manifest["fingerprint"], "new")
                self.assertEqual(manifest["stages"], {"latents": "pending", "text_encoder": "pending"})

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_settles_after_result_or_callback_failure(self):
        from backend.training import supervisor

        async def scenario(directory, failed_step):
            manager = TaskManager()
            reserved = manager.reserve_task()
            callbacks = []
            result_entered, release_result = threading.Event(), threading.Event()

            def on_complete(status):
                callbacks.append(status)
                if failed_step == "callback":
                    raise RuntimeError("callback failed")

            def failed_result(*_args):
                result_entered.set()
                if not release_result.wait(5):
                    raise TimeoutError("result writer was not released")
                raise RuntimeError("result failed")

            result_writer = patch.object(
                supervisor, "_write_result_json",
                side_effect=failed_result if failed_step == "result" else None,
            )
            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 result_writer, patch("backend.tasks.subprocess.Popen", return_value=self._process(0)):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved, on_complete=on_complete,
                )
                self.assertEqual(response["status"], "success")
                if failed_step == "result":
                    try:
                        self.assertTrue(await asyncio.to_thread(result_entered.wait, 5))
                        self.assertIs(reserved.status, TaskStatus.RUNNING)
                        self.assertIsNone(manager.reserve_task())
                    finally:
                        release_result.set()
                for _ in range(100):
                    if reserved.status is TaskStatus.FINISHED:
                        break
                    await asyncio.sleep(0.01)
                self.assertIs(reserved.status, TaskStatus.FINISHED)
                self.assertEqual(callbacks, ["completed"])
                self.assertIsNotNone(manager.reserve_task())

        for failed_step in ("result", "callback"):
            with self.subTest(failed_step=failed_step), tempfile.TemporaryDirectory() as directory:
                asyncio.run(scenario(directory, failed_step))

    def test_supervisor_log_open_failure_settles_reserved_slot(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 patch.object(supervisor, "open", create=True, side_effect=PermissionError("log denied")):
                response = supervisor.run_train("config.toml", run_dir=directory, reserved_task=reserved)
                self.assertEqual(response["status"], "success")
                for _ in range(100):
                    if reserved.status is TaskStatus.FAILED:
                        break
                    await asyncio.sleep(0.01)
                self.assertIs(reserved.status, TaskStatus.FAILED)
                self.assertIsNotNone(manager.reserve_task())

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_popen_failure_settles_after_callback(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            callbacks = []
            worker_futures = []
            loop = asyncio.get_running_loop()
            run_in_executor = loop.run_in_executor

            def submit(executor, func, *args):
                future = run_in_executor(executor, func, *args)
                if getattr(func, "__name__", "") == "_run":
                    worker_futures.append(future)
                return future

            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"), \
                 patch.object(supervisor, "_log_run_end"), \
                 patch.object(loop, "run_in_executor", side_effect=submit), \
                 patch("backend.tasks.subprocess.Popen", side_effect=OSError("start denied")):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved,
                    on_complete=callbacks.append,
                )
                self.assertEqual(response["status"], "success")
                self.assertEqual(len(worker_futures), 1)
                await asyncio.wait_for(worker_futures[0], 5)
                self.assertIs(reserved.status, TaskStatus.FAILED)
                self.assertEqual(callbacks, ["error"])
                self.assertIsNotNone(manager.reserve_task())

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_supervisor_prelaunch_failures_leave_preparation_owner(self):
        from backend.training import supervisor

        for failed_step in ("save_config_snapshot", "_build_train_env"):
            with self.subTest(failed_step=failed_step), tempfile.TemporaryDirectory() as directory:
                manager = TaskManager()
                reserved = manager.reserve_task()
                with patch.object(supervisor, "tm", manager), \
                     patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                     patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                     patch.object(supervisor, "save_config_snapshot"), \
                     patch.object(supervisor, "_build_train_env", return_value={}), \
                     patch.object(supervisor, "_read_run_meta", return_value={}), \
                     patch.object(supervisor, failed_step, side_effect=OSError("prepare denied")):
                    response = supervisor.run_train("config.toml", run_dir=directory, reserved_task=reserved)
                self.assertEqual(response["status"], "error")
                self.assertIs(reserved.status, TaskStatus.CREATED)
                self.assertIsNone(manager.reserve_task())
                manager.release_reserved(reserved)
                self.assertIs(reserved.status, TaskStatus.FAILED)
                self.assertIsNotNone(manager.reserve_task())

    def test_supervisor_executor_submission_failure_leaves_preparation_owner(self):
        from backend.training import supervisor

        async def scenario(directory):
            manager = TaskManager()
            reserved = manager.reserve_task()
            loop_stub = Mock()
            loop_stub.run_in_executor.side_effect = RuntimeError("executor closed")
            with patch.object(supervisor, "tm", manager), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor.asyncio, "get_running_loop", return_value=loop_stub):
                response = supervisor.run_train("config.toml", run_dir=directory, reserved_task=reserved)
            self.assertEqual(response["status"], "error")
            self.assertIs(reserved.status, TaskStatus.CREATED)
            self.assertIsNone(manager.reserve_task())
            manager.release_reserved(reserved)
            self.assertIs(reserved.status, TaskStatus.FAILED)
            self.assertIsNotNone(manager.reserve_task())

        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))


if __name__ == "__main__":
    unittest.main()
