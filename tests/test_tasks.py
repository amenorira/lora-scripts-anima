import subprocess
import unittest
from unittest.mock import Mock, patch

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
        task._settle(TaskStatus.FAILED)

        replacement = manager.create_task(["trainer-2"])

        self.assertIsNotNone(replacement)
        self.assertEqual(manager.dump()[0]["status"], "FAILED")


if __name__ == "__main__":
    unittest.main()
