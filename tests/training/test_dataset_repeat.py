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

    def test_renames_prefix_and_keeps_name(self):
        self._subset("5_cat_portrait")

        result = apply_subset_repeats(self.train, [{"name": "5_cat_portrait", "repeats": 10}])

        self.assertEqual(result["applied"], [
            {"oldName": "5_cat_portrait", "newName": "10_cat_portrait", "repeats": 10},
        ])
        self.assertFalse((self.train / "5_cat_portrait").exists())
        self.assertTrue((self.train / "10_cat_portrait" / "a.png").is_file())

    def test_rename_is_visible_to_sd_scripts_subset_parser(self):
        # 改名的意义就在于 sd-scripts 从目录名重新解析 repeats。
        self._subset("5_cat_portrait")

        apply_subset_repeats(self.train, [{"name": "5_cat_portrait", "repeats": 10}])

        config = build_sd_scripts_dataset_config({"train_data_dir": str(self.train)}, {})
        subsets = config["datasets"][0]["subsets"]
        self.assertEqual(len(subsets), 1)
        self.assertEqual(subsets[0]["num_repeats"], 10)
        self.assertEqual(subsets[0]["class_tokens"], "cat_portrait")

    def test_batch_applies_every_change(self):
        self._subset("5_alpha")
        self._subset("2_beta")

        result = apply_subset_repeats(self.train, [
            {"name": "5_alpha", "repeats": 8},
            {"name": "2_beta", "repeats": 3},
        ])

        self.assertEqual(len(result["applied"]), 2)
        self.assertEqual(self._names(), ["3_beta", "8_alpha"])

    def test_unchanged_entries_are_not_renamed(self):
        self._subset("5_cat")

        result = apply_subset_repeats(self.train, [{"name": "5_cat", "repeats": 5}])

        self.assertEqual(result["applied"], [])
        self.assertTrue((self.train / "5_cat").is_dir())

    def test_multi_digit_to_single_digit(self):
        self._subset("12_face")

        apply_subset_repeats(self.train, [{"name": "12_face", "repeats": 3}])

        self.assertTrue((self.train / "3_face").is_dir())

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

    def test_rejects_existing_target_outside_the_batch(self):
        self._subset("5_cat")
        self._subset("10_cat")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [{"name": "5_cat", "repeats": 10}])

        self.assertEqual(ctx.exception.code, "targetExists")
        self.assertEqual(ctx.exception.params["name"], "10_cat")
        # 两个目录都必须原样保留，绝不能合并。
        self.assertEqual(self._names(), ["10_cat", "5_cat"])

    def test_rejects_two_subsets_colliding_on_one_name(self):
        self._subset("1_alpha")
        self._subset("2_alpha")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [
                {"name": "1_alpha", "repeats": 3},
                {"name": "2_alpha", "repeats": 3},
            ])

        self.assertEqual(ctx.exception.code, "duplicateTarget")
        self.assertEqual(self._names(), ["1_alpha", "2_alpha"])

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

    def test_duplicate_subset_rename_fails_and_rolls_back(self):
        # 同一子集在一批里提交两次：第二次改时目录已不在 → 报错并回滚，不留半成品。
        self._subset("5_cat")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [
                {"name": "5_cat", "repeats": 8},
                {"name": "5_cat", "repeats": 9},
            ])

        self.assertEqual(ctx.exception.code, "renameFailed")
        self.assertEqual(self._names(), ["5_cat"])

    def test_empty_change_list_is_a_noop(self):
        self._subset("5_cat")

        result = apply_subset_repeats(self.train, [])

        self.assertEqual(result["applied"], [])
        self.assertEqual(self._names(), ["5_cat"])

    def test_malformed_change_list_is_rejected(self):
        self._subset("5_cat")

        for changes in (None, "5_cat", [{"name": "5_cat", "repeats": 5}, "5_cat"]):
            with self.subTest(changes=changes):
                with self.assertRaises(DatasetRepeatError) as ctx:
                    apply_subset_repeats(self.train, changes)
                self.assertEqual(ctx.exception.code, "invalidChanges")

    def test_rejects_subset_without_numeric_prefix(self):
        self._subset("cat")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [{"name": "cat", "repeats": 5}])

        self.assertEqual(ctx.exception.code, "invalidSubsetName")

    def test_rejects_empty_name_part(self):
        # "5_" 能过 int() 解析但没有 class_tokens，train_utils 的正则也不认，不允许改成这种名字。
        self._subset("5_")

        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [{"name": "5_", "repeats": 10}])

        self.assertEqual(ctx.exception.code, "invalidSubsetName")

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

    def test_accepts_numeric_string_repeats(self):
        self._subset("5_cat")

        result = apply_subset_repeats(self.train, [{"name": "5_cat", "repeats": "7"}])

        self.assertEqual(result["applied"][0]["newName"], "7_cat")

    def test_missing_dataset_dir(self):
        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.root / "nope", [{"name": "5_cat", "repeats": 5}])

        self.assertEqual(ctx.exception.code, "datasetMissing")

    def test_missing_subset(self):
        with self.assertRaises(DatasetRepeatError) as ctx:
            apply_subset_repeats(self.train, [{"name": "5_cat", "repeats": 5}])

        self.assertEqual(ctx.exception.code, "subsetMissing")


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

    def test_route_keeps_picker_cache_when_nothing_changed(self):
        system_routes._files_cache["train-dir"] = (0.0, [{"name": "cached"}])

        result = self._post({"dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 5}]})

        self.assertEqual(result.status, "success")
        self.assertEqual(result.data["applied"], [])
        self.assertIn("train-dir", system_routes._files_cache)

    def test_route_reports_error_code(self):
        result = self._post({"dir": str(self.train), "changes": [{"name": "5_cat", "repeats": 0}]})

        self.assertEqual(result.status, "fail")
        self.assertEqual(result.data["errorCode"], "repeatsOutOfRange")

    def test_route_requires_dataset_dir(self):
        result = self._post({"dir": "", "changes": [{"name": "5_cat", "repeats": 3}]})

        self.assertEqual(result.status, "fail")
        self.assertEqual(result.data["errorCode"], "datasetMissing")

    def test_route_blocked_while_training(self):
        with patch.object(training_routes.tm, "dump", return_value=[{"status": "RUNNING"}]):
            result = asyncio.run(training_routes.update_dataset_repeat(_BodyRequest({
                "dir": str(self.train),
                "changes": [{"name": "5_cat", "repeats": 8}],
            })))

        self.assertEqual(result.status, "fail")
        self.assertEqual(result.data["errorCode"], "trainingActive")
        self.assertTrue((self.train / "5_cat").is_dir())


if __name__ == "__main__":
    unittest.main()
