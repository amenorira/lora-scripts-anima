"""数据集子集改名（repeat = 目录名数字前缀）的单元测试。"""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.server.routes import training as training_routes
from backend.server.routes import system as system_routes
from backend.training.datasets.dataset_repeat import (
    DatasetRepeatError,
    apply_subset_repeats,
)
from tests.helpers import json_request


class ApplySubsetRepeatsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.train = self.root / "train"
        self.train.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _subset(self, name):
        folder = self.train / name
        folder.mkdir()
        (folder / "a.png").write_bytes(b"x")
        return folder

    def _names(self):
        return sorted(item.name for item in self.train.iterdir())


    def test_validation_failure_leaves_every_folder_untouched(self):
        # 靠前的项合法、靠后的项非法 → 因为先整体校验，第一个也不能动。
        self._subset("5_alpha")
        self._subset("2_beta")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [
                {"name": "5_alpha", "repeats": 8},
                {"name": "2_beta", "repeats": 0},
            ])

        self.assertEqual(ctx.exception.code, "repeatsOutOfRange")
        self.assertEqual(self._names(), ["2_beta", "5_alpha"])

    def test_failed_rollback_reports_actual_directory_and_preserves_files(self):
        self._subset("5_alpha")
        self._subset("2_beta")
        real_rename = Path.rename
        calls = []

        def flaky(source, destination):
            calls.append((source, destination))
            if len(calls) in (2, 3):
                raise PermissionError("in use")
            return real_rename(source, destination)

        with patch.object(Path, "rename", flaky):
            with self.assertRaises(DatasetRepeatError) as ctx:
                apply_subset_repeats(self.train, [
                    {"name": "5_alpha", "repeats": 8}, {"name": "2_beta", "repeats": 3},
                ])
        self.assertEqual(ctx.exception.code, "rollbackFailed")
        recovery = ctx.exception.details["recovery"]
        self.assertEqual([(item["oldName"], item["currentName"]) for item in recovery], [("5_alpha", "8_alpha")])
        self.assertEqual(Path(recovery[0]["currentPath"]), self.train / "8_alpha")
        self.assertEqual(Path(recovery[0]["originalPath"]), self.train / "5_alpha")
        self.assertTrue((self.train / "8_alpha" / "a.png").is_file())
        self.assertEqual(len(ctx.exception.details["rollbackErrors"]), 1)

    def test_relay_rollback_failure_reports_hidden_folder(self):
        self._subset("1_cat")
        self._subset("2_cat")
        real_rename = Path.rename
        calls = []

        def flaky(source, destination):
            calls.append((source, destination))
            if len(calls) in (3, 4):
                raise PermissionError("in use")
            return real_rename(source, destination)

        with patch.object(Path, "rename", flaky):
            with self.assertRaises(DatasetRepeatError) as ctx:
                apply_subset_repeats(self.train, [
                    {"name": "1_cat", "repeats": 2}, {"name": "2_cat", "repeats": 1},
                ])
        item, = ctx.exception.details["recovery"]
        self.assertEqual(ctx.exception.code, "rollbackFailed")
        self.assertEqual(item["oldName"], "2_cat")
        self.assertTrue(item["currentName"].startswith(".repeat_tmp_"))
        self.assertTrue((Path(item["currentPath"]) / "a.png").is_file())

    def test_failed_reverse_move_does_not_overwrite_another_subset(self):
        # 最后一步失败且前一步无法回滚时，后续恢复不能覆盖尚占着原名的另一子集。
        (self.train / "1_cat").mkdir()
        self._subset("2_cat")
        real_rename = Path.rename
        calls = []

        def flaky(source, destination):
            calls.append((source, destination))
            if len(calls) in (4, 5):
                raise PermissionError("in use")
            return real_rename(source, destination)

        with patch.object(Path, "rename", flaky):
            with self.assertRaises(DatasetRepeatError) as ctx:
                apply_subset_repeats(self.train, [
                    {"name": "1_cat", "repeats": 2}, {"name": "2_cat", "repeats": 1},
                ])
        self.assertEqual(ctx.exception.code, "rollbackFailed")
        self.assertEqual(len(ctx.exception.details["recovery"]), 2)
        self.assertEqual(len(list(self.train.iterdir())), 2)
        self.assertTrue(any((path / "a.png").is_file() for path in self.train.iterdir()))

    def test_failed_swap_reports_locations_even_when_original_names_still_exist(self):
        self._subset("1_cat")
        self._subset("2_cat")
        self._subset("1_dog")
        real_rename = Path.rename
        calls = []

        def flaky(source, destination):
            calls.append((source, destination))
            if len(calls) in (6, 7, 8):
                raise PermissionError("in use")
            return real_rename(source, destination)

        with patch.object(Path, "rename", flaky):
            with self.assertRaises(DatasetRepeatError) as ctx:
                apply_subset_repeats(self.train, [
                    {"name": "1_cat", "repeats": 2}, {"name": "2_cat", "repeats": 1},
                    {"name": "1_dog", "repeats": 2},
                ])
        recovery = ctx.exception.details["recovery"]
        self.assertTrue((self.train / "1_cat").is_dir())
        self.assertTrue((self.train / "2_cat").is_dir())
        self.assertEqual({(item["oldName"], item["currentName"]) for item in recovery},
                         {("1_cat", "2_cat"), ("2_cat", "1_cat")})

    def test_failure_during_rename_rolls_back_finished_items(self):
        self._subset("5_alpha")
        self._subset("2_beta")
        real_rename = Path.rename
        calls = {"n": 0}

        def flaky(self, target):
            calls["n"] += 1
            if calls["n"] == 2:
                raise PermissionError("in use")
            return real_rename(self, target)

        with patch.object(Path, "rename", flaky):
            with self.assertRaises(DatasetRepeatError) as ctx:
                apply_subset_repeats(self.train, [
                    {"name": "5_alpha", "repeats": 8},
                    {"name": "2_beta", "repeats": 3},
                ])

        self.assertEqual(ctx.exception.code, "renameFailed")
        self.assertEqual(ctx.exception.details["recovery"], [])
        # 第一个已经改完，必须被回滚，不留半成品。
        self.assertEqual(self._names(), ["2_beta", "5_alpha"])


class DatasetRepeatRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.train = Path(self.tmp.name) / "train"
        (self.train / "5_cat").mkdir(parents=True)
        system_routes._files_cache.clear()

    def tearDown(self):
        system_routes._files_cache.clear()
        self.tmp.cleanup()

    def test_rollback_failure_invalidates_browser_cache_and_returns_recovery(self):
        recovery = [{"oldName": "5_cat", "currentName": "8_cat",
                     "currentPath": str(self.train / "8_cat"), "originalPath": str(self.train / "5_cat")}]
        error = DatasetRepeatError("incomplete", "rollbackFailed", details={
            "mutationAttempted": True, "recovery": recovery,
            "rollbackErrors": [{"reason": "in use"}],
        })
        with patch.object(training_routes, "apply_subset_repeats", side_effect=error), \
                patch.object(system_routes, "invalidate_files_cache") as invalidate:
            response = asyncio.run(training_routes.update_dataset_repeat(json_request({
                "dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 8}],
            })))
        data = response.data
        self.assertEqual(data["errorCode"], "rollbackFailed")
        self.assertEqual(data["recovery"], recovery)
        self.assertEqual(data["rollbackErrors"], [{"reason": "in use"}])
        invalidate.assert_called_once()

    def test_cancelled_request_keeps_mutation_slot_until_rename_finishes(self):
        import threading

        entered = threading.Event()
        release = threading.Event()

        def slow_rename(*_args):
            entered.set()
            self.assertTrue(release.wait(5))
            return {"applied": []}

        async def exercise():
            task = asyncio.create_task(training_routes.update_dataset_repeat(json_request({
                "dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 8}],
            })))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            task.cancel()
            await asyncio.sleep(0)
            self.assertIsNone(training_routes.tm.reserve_task())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            reservation = training_routes.tm.reserve_task()
            self.assertIsNotNone(reservation)
            training_routes.tm.release_reserved(reservation)

        with patch.object(training_routes, "apply_subset_repeats", side_effect=slow_rename), \
                patch.object(system_routes, "invalidate_files_cache") as invalidate:
            asyncio.run(exercise())
        invalidate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
