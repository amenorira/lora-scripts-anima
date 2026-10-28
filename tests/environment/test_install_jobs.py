import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend.core import install_jobs
from backend.tasks import TaskManager


class ImmediateThread:
    def __init__(self, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


class InstallJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = TaskManager()
        self.jobs = install_jobs.InstallJobs("test")
        self.enterContext(patch.object(install_jobs, "tm", self.manager))
        self.register = self.enterContext(patch.object(install_jobs.realtime_tasks, "register", new_callable=AsyncMock))
        self.enterContext(patch.object(install_jobs.threading, "Thread", ImmediateThread))


    async def test_live_job_blocks_another_installer_and_training(self):
        with patch.object(install_jobs.threading, "Thread") as thread:
            result = await self.jobs.start(Mock())
            self.assertEqual(self.jobs.snapshot(result["job_id"])["status"], "running")
            self.assertIsNone(self.manager.reserve_task())
            installer = Mock()
            blocked = await install_jobs.InstallJobs("other").start(installer)
            self.assertFalse(blocked["success"])
            installer.assert_not_called()
            thread.assert_called_once()

    async def test_failed_launch_or_registration_releases_reservation(self):
        for failure in ("registration", "thread", "cancelled"):
            with self.subTest(failure=failure):
                error = asyncio.CancelledError() if failure == "cancelled" else RuntimeError("cannot start")
                self.register.side_effect = error if failure != "thread" else None
                with patch.object(install_jobs.threading, "Thread") as thread:
                    if failure == "thread":
                        thread.return_value.start.side_effect = error
                    with self.assertRaises(type(error)):
                        await self.jobs.start(Mock())
                if self.register.call_args:
                    snapshot = self.register.call_args.args[2]()
                    self.assertTrue(snapshot["done"])
                    self.assertFalse(snapshot["success"])
                self.assertTrue(self.manager.claim_external("next"))
                self.manager.release_external("next")
