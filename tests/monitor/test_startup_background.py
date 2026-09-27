import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend.monitor import artifacts
from backend.server import application


class BackgroundStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_history_does_not_block_ready_or_lifespan_entry(self):
        started, release = threading.Event(), threading.Event()

        def scan():
            started.set()
            if not release.wait(5):
                raise TimeoutError("test did not release history scan")
            return []

        with patch.object(application, "scan_history", side_effect=scan) as history, \
             patch.object(application, "warm_step_estimator") as estimator, \
             patch.object(application, "tensorboard", start=Mock(), stop=AsyncMock()) as tb, \
             patch.object(application, "task_monitor", start=AsyncMock(), stop=AsyncMock()), \
             patch("backend.training.shape_preview.close_preview_pool"), \
             patch.object(application, "report_runtime_banner", new_callable=AsyncMock) as banner:
            async def report():
                tb.start.assert_called_once()
                history.assert_not_called()
                estimator.assert_not_called()
            banner.side_effect = report
            try:
                async with application.lifespan(application.app):
                    self.assertTrue(await asyncio.to_thread(started.wait, 2))
                    banner.assert_awaited_once()
                    release.set()
            finally:
                release.set()
            tb.stop.assert_awaited_once()
            history.assert_called_once()
            estimator.assert_called_once()

    async def test_optional_cache_failure_is_reported_without_aborting(self):
        with patch.object(application, "scan_history", side_effect=OSError("offline disk")), \
             patch.object(application, "warm_step_estimator") as estimator, \
             patch("backend.log.log.warning") as warning:
            await application.warm_startup_caches()
            estimator.assert_called_once()
            warning.assert_called_once()


class HistoryWarmupTests(unittest.TestCase):
    def test_background_and_page_request_share_one_scan(self):
        started, release = threading.Event(), threading.Event()

        def migrate():
            started.set()
            if not release.wait(5):
                raise TimeoutError("test did not release migration")

        with patch.object(artifacts, "_history_cache", None), \
             patch.object(artifacts, "import_legacy_external_runs", side_effect=migrate) as migration, \
             patch.object(artifacts, "iter_run_records", return_value=[]), \
             ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(artifacts.scan_history)
            try:
                self.assertTrue(started.wait(2))
                second = pool.submit(artifacts.scan_history)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=2), [])
            self.assertEqual(second.result(timeout=2), [])
            migration.assert_called_once()

    def test_invalidation_during_scan_cannot_republish_stale_cache(self):
        started, release = threading.Event(), threading.Event()

        def migrate():
            started.set()
            release.wait(5)

        with patch.object(artifacts, "_history_cache", None), \
             patch.object(artifacts, "_history_cache_generation", 0), \
             patch.object(artifacts, "import_legacy_external_runs", side_effect=migrate), \
             patch.object(artifacts, "iter_run_records", return_value=[]), \
             ThreadPoolExecutor(max_workers=1) as pool:
            scan = pool.submit(artifacts.scan_history)
            try:
                self.assertTrue(started.wait(2))
                artifacts.invalidate_history_cache()
            finally:
                release.set()
            scan.result(timeout=2)
            self.assertIsNone(artifacts._history_cache)


if __name__ == "__main__":
    unittest.main()
