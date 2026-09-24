"""数据集子集改名（repeat = 目录名数字前缀）的单元测试。"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.server.routes import training as training_routes
from backend.server.routes import system as system_routes
from backend.training.dataset_repeat import (
    DatasetRepeatError,
    apply_subset_repeats,
)
from backend.training.sd_dataset_config import build_sd_scripts_dataset_config


class _BodyRequest:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    async def body(self):
        return self._body


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

    def test_rename_is_visible_to_sd_scripts_subset_parser(self):
        # 改名的意义就在于 sd-scripts 从目录名重新解析 repeats。
        self._subset("5_cat_portrait")

        apply_subset_repeats(self.train, [{"name": "5_cat_portrait", "repeats": 10}])

        config = build_sd_scripts_dataset_config({"train_data_dir": str(self.train)}, {})
        subsets = config["datasets"][0]["subsets"]
        self.assertEqual(len(subsets), 1)
        self.assertEqual(subsets[0]["num_repeats"], 10)
        self.assertEqual(subsets[0]["class_tokens"], "cat_portrait")

    def test_swaps_two_subsets_through_relay_names(self):
        # 互换：两端的目标名都被对方占着，必须经中转名完成。
        self._subset("3_alpha")
        self._subset("5_alpha")

        result = apply_subset_repeats(self.train, [
            {"name": "3_alpha", "repeats": 5},
            {"name": "5_alpha", "repeats": 3},
        ])

        self.assertEqual(len(result["applied"]), 2)
        self.assertEqual(self._names(), ["3_alpha", "5_alpha"])
        self.assertFalse(any(item.name.startswith(".repeat_tmp_") for item in self.train.iterdir()))

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
        # 第一个已经改完，必须被回滚，不留半成品。
        self.assertEqual(self._names(), ["2_beta", "5_alpha"])

    def test_rejects_path_traversal_and_separators(self):
        for name in ("../5_cat", "a/5_cat", "a\\5_cat", "..", ""):
            with self.subTest(name=name):
                with self.assertRaises(DatasetRepeatError) as ctx:
                    apply_subset_repeats(self.train, [{"name": name, "repeats": 5}])
                self.assertEqual(ctx.exception.code, "invalidSubsetName")

    def test_rejects_out_of_range_repeats(self):
        self._subset("5_cat")

        for repeats in (0, -1, 1000, "abc", ""):
            with self.subTest(repeats=repeats):
                with self.assertRaises(DatasetRepeatError) as ctx:
                    apply_subset_repeats(self.train, [{"name": "5_cat", "repeats": repeats}])
                self.assertIn(ctx.exception.code, {"invalidRepeats", "repeatsOutOfRange"})
        self.assertTrue((self.train / "5_cat").is_dir())


class DatasetRepeatRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.train = Path(self.tmp.name) / "train"
        (self.train / "5_cat").mkdir(parents=True)
        system_routes._files_cache.clear()

    def tearDown(self):
        system_routes._files_cache.clear()
        self.tmp.cleanup()

    def _post(self, payload):
        with patch.object(training_routes.tm, "dump", return_value=[]):
            return asyncio.run(training_routes.update_dataset_repeat(_BodyRequest(payload)))

    def test_route_renames_and_invalidates_picker_cache(self):
        system_routes._files_cache["train-dir"] = (0.0, [{"name": "stale"}])

        result = self._post({"dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 8}]})

        self.assertEqual(result.status, "success")
        self.assertEqual(result.data["applied"][0]["newName"], "8_cat")
        self.assertTrue((self.train / "8_cat").is_dir())
        # 选择器缓存留着旧名字会让用户看到已经改掉的目录。
        self.assertEqual(system_routes._files_cache, {})

    def test_route_blocked_while_training(self):
        from backend.tasks import TaskManager
        manager = TaskManager()
        reservation = manager.reserve_task()
        with patch.object(training_routes, "tm", manager):
            result = asyncio.run(training_routes.update_dataset_repeat(_BodyRequest({
                "dir": str(self.train),
                "changes": [{"name": "5_cat", "repeats": 8}],
            })))
        manager.release_reserved(reservation)

        self.assertEqual(result.status, "fail")
        self.assertEqual(result.data["errorCode"], "trainingActive")
        self.assertTrue((self.train / "5_cat").is_dir())

    def test_stopping_preparation_does_not_allow_dataset_rename(self):
        import threading
        from backend.tasks import TaskManager, TaskStatus

        entered = threading.Event()
        release = threading.Event()
        manager = TaskManager()

        def slow_disk_work():
            entered.set()
            release.wait(5)

        async def prepare(preparation):
            await training_routes._settled_to_thread(slow_disk_work)
            return {"status": "success"}

        async def scenario():
            with patch.object(training_routes, "tm", manager):
                pending = asyncio.create_task(training_routes._prepare_training(prepare))
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                task_id = manager.dump()[0]["id"]
                manager.terminate_task(task_id)
                self.assertIs(manager.tasks[task_id].status, TaskStatus.CREATED)
                blocked = await training_routes.update_dataset_repeat(_BodyRequest({
                    "dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 8}],
                }))
                self.assertEqual(blocked.data["errorCode"], "trainingActive")
                release.set()
                result = await pending
                self.assertEqual(result.status, "fail")
                self.assertEqual(manager.dump(), [])

        asyncio.run(scenario())

    def test_cancelled_request_keeps_mutation_slot_until_rename_finishes(self):
        import threading

        entered = threading.Event()
        release = threading.Event()

        def slow_rename(*_args):
            entered.set()
            self.assertTrue(release.wait(5))
            return {"applied": []}

        async def exercise():
            task = asyncio.create_task(training_routes.update_dataset_repeat(_BodyRequest({
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

        with patch.object(training_routes, "apply_subset_repeats", side_effect=slow_rename):
            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
