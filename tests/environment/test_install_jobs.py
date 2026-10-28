import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend.core import install_jobs
from backend.tasks import TaskManager
from tests.helpers import json_request


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

    async def test_success_keeps_progress_contract_and_bounds_log(self):
        def installer(emit, *, source):
            self.assertEqual(source, "mirror")
            self.assertFalse(self.manager.claim_external("other"))
            for index in range(85):
                emit(stage="download", message=str(index), percent=index)

        result = await self.jobs.start(installer, source="mirror")
        task_id, kind, snapshot_provider = self.register.call_args.args
        self.assertEqual(task_id, result["job_id"])
        self.assertEqual(kind, "test-install")
        snapshot = snapshot_provider()
        self.assertEqual(snapshot["status"], "finished")
        self.assertTrue(snapshot["done"])
        self.assertTrue(snapshot["success"])
        self.assertEqual(snapshot["progress"], {"stage": "download", "percent": 84})
        self.assertEqual(snapshot["lines"].splitlines(), [str(index) for index in range(5, 85)])
        self.assertTrue(self.manager.claim_external("next"))

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

    async def test_expiration_preserves_recent_completed_job(self):
        with patch.object(install_jobs.time, "time", return_value=1000):
            first = await self.jobs.start(Mock())
        with patch.object(install_jobs.time, "time", return_value=1599):
            second = await self.jobs.start(Mock())
            self.assertTrue(self.jobs.snapshot(first["job_id"])["success"])
        with patch.object(install_jobs.time, "time", return_value=1601):
            await self.jobs.start(Mock())
            self.assertFalse(self.jobs.snapshot(first["job_id"])["success"])
            self.assertTrue(self.jobs.snapshot(second["job_id"])["success"])

    async def test_flash_route_preserves_source_validation_and_worker_options(self):
        from backend.server.routes import flash_attention as routes

        with patch.object(routes, "install_jobs", install_jobs.InstallJobs("flash-attn")), \
             patch.object(routes.flash_attention, "install") as installer:
            invalid = await routes.install(json_request({"source": "invalid"}))
            self.assertFalse(invalid["success"])
            self.register.assert_not_called()
            installer.assert_not_called()
            for source in ("auto", "direct", "mirror"):
                result = await routes.install(json_request({"source": source}))
                self.assertTrue(result["success"])
                self.assertEqual(installer.call_args.kwargs, {"source": source})
                self.assertEqual(self.register.call_args.args[1], "flash-attn-install")
