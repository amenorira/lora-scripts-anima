import asyncio
import json
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend.tasks import Task, TaskManager, TaskStatus
from backend.training import supervisor
from tests.helpers import stub_supervisor


class TaskStateMachineTests(unittest.TestCase):
    def _process(self, returncode=0):
        process = Mock()
        process.pid = 1234
        process.args = ["trainer"]
        process.returncode = returncode
        process.communicate.return_value = (b"", b"")
        process.wait.return_value = returncode
        return process


    def test_business_failure_survives_process_exit_and_repeated_settlement(self):
        for exit_first in (False, True):
            with self.subTest(exit_first=exit_first):
                task = Task("invalid-result", ["trainer"])
                with patch("backend.tasks.subprocess.Popen", return_value=self._process(0)):
                    task.execute()
                    if exit_first:
                        task.communicate()
                    task.complete_work(failed=True)
                    if not exit_first:
                        self.assertIs(task.status, TaskStatus.RUNNING)
                        task.complete_work()
                        task.communicate()
                    finished_at = task.finished_at
                    task.complete_work()
                self.assertIs(task.status, TaskStatus.FAILED)
                self.assertEqual(task.process.returncode, 0)
                self.assertEqual(task.finished_at, finished_at)


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


    def test_supervisor_finalization_precedes_results_and_preserves_stop_or_process_failure(self):
        async def scenario(directory, outcome):
            manager = TaskManager()
            reserved = manager.reserve_task()
            process = self._process(3 if outcome == "process" else 0)
            entered, release = threading.Event(), threading.Event()
            finalized, callbacks = [], []
            worker_futures = []
            loop = asyncio.get_running_loop()
            submit = loop.run_in_executor

            def capture_worker(executor, func, *args):
                future = submit(executor, func, *args)
                if getattr(func, "__name__", "") == "_run":
                    worker_futures.append(future)
                return future

            def finalize_result(status):
                finalized.append(status)
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("finalization was not released")
                if outcome == "exception":
                    raise OSError("validation denied")
                return "Cache files do not match / 缓存文件不匹配"

            def communicate(**_kwargs):
                if outcome == "stop":
                    reserved.terminate()
                return b"", b""

            process.communicate.side_effect = communicate
            with stub_supervisor(), \
                 patch.object(loop, "run_in_executor", side_effect=capture_worker), \
                 patch("backend.tasks.subprocess.Popen", return_value=process), \
                 patch("backend.tasks.kill_proc_tree"):
                response = supervisor.run_train(
                    "config.toml", run_dir=directory, reserved_task=reserved,
                    finalize_result=finalize_result, on_complete=callbacks.append,
                )
                self.assertEqual(response["status"], "success")
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    self.assertIs(reserved.status, TaskStatus.RUNNING)
                    self.assertFalse((Path(directory) / "result.json").exists())
                    self.assertIsNone(manager.reserve_task())
                    self.assertFalse(manager.begin_dataset_mutation())
                finally:
                    release.set()
                await asyncio.wait_for(worker_futures[0], 5)

            expected = "terminated" if outcome == "stop" else "failed"
            result = json.loads((Path(directory) / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], expected)
            self.assertEqual(result["exit_code"], process.returncode)
            self.assertEqual(callbacks, [expected])
            self.assertEqual(finalized, [expected if outcome in ("stop", "process") else "completed"])
            error = {
                "process": "exit code 3",
                "stop": "Training terminated",
                "exception": "validation denied",
            }.get(outcome, "缓存文件不匹配")
            self.assertIn(error, result["error"])
            self.assertIs(reserved.status, TaskStatus.TERMINATED if outcome == "stop" else TaskStatus.FAILED)
            self.assertIsNotNone(manager.reserve_task())

        for outcome in ("invalid", "exception", "process", "stop"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                asyncio.run(scenario(directory, outcome))


    def test_supervisor_popen_failure_settles_after_callback(self):
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

            with stub_supervisor(), \
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


if __name__ == "__main__":
    unittest.main()
