from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from backend.monitor import legacy_sample_steps
from backend.monitor.artifacts import newest_previews
from backend.monitor.sample_metadata import legacy_sample_metadata, write_sample_batch


class LegacySampleStepsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "train_demo.log"

    def sample(self, epoch=1, timestamp="20261114090015"):
        name = f"demo_e{epoch:06d}_00_{timestamp}_42.png"
        return {"name": name, "sample": legacy_sample_metadata(name, "sample/" + name)}

    def write_log(self, text):
        self.log.write_text(text, encoding="utf-8")

    def prompt_line(self, prompt="a rabbit, cowboy shot", seed="42", timestamp="09:00:00"):
        return (f"2026-11-14 {timestamp} INFO       prompt: {prompt}, size: 832x1216, steps: 16, "
                f"scale: 1.0, flow_shift: 3, seed: {seed}  anima_train_utils.py:609\n")

    def prompt_log(self, *lines):
        return ("epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                + "".join(lines) + "2026-11-14 09:01:00 INFO done\n")

    def test_explicit_calls_restore_steps_without_pairing_or_arithmetic(self):
        self.write_log("epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                       "epoch 2/20\n2026-11-14 09:05:00 INFO Generating sample images at step 107\n"
                       "2026-11-14 09:06:00 INFO model saved\n")
        first, second = self.sample(), self.sample(2, "20261114090515")
        legacy_sample_steps.enrich_legacy_sample_steps([first, second], self.root)
        self.assertEqual((first["sample"]["step"], second["sample"]["step"]), (54, 107))
        self.assertEqual(second["sample"]["batch_label"], "Epoch 2 · Step 107")
        self.assertEqual(first["sample"]["step_source"], "log")
        self.assertEqual(first["sample"]["metadata_source"], "filename")
        self.assertFalse(first["sample"]["comparable"])
        self.assertIsNone(first["sample"]["pair_key"])

    def test_resume_and_multiple_calls_match_image_timestamp(self):
        self.write_log("epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                       "2026-11-14 09:01:00 INFO Generating sample images at step 60\n"
                       "epoch 1/2\n2026-11-14 10:00:00 INFO Generating sample images at step 154\n"
                       "2026-11-14 10:01:00 INFO model saved\n")
        samples = [self.sample(), self.sample(timestamp="20261114090115"), self.sample(timestamp="20261114100015")]
        legacy_sample_steps.enrich_legacy_sample_steps(samples, self.root)
        self.assertEqual([item["sample"]["step"] for item in samples], [54, 60, 154])
        self.assertEqual(len({item["sample"]["batch_id"] for item in samples}), 3)

    def test_one_call_keeps_multiple_images_together_across_save_times(self):
        self.write_log("epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                       "2026-11-14 09:05:00 INFO done\n")
        first, second = self.sample(), self.sample(timestamp="20261114090315")
        second["name"] = second["name"].replace("_00_", "_01_")
        second["sample"]["prompt_index"] = 1
        legacy_sample_steps.enrich_legacy_sample_steps([first, second], self.root)
        self.assertEqual(first["sample"]["batch_id"], second["sample"]["batch_id"])

    def test_append_parses_only_new_complete_records_without_global_lock(self):
        self.write_log("epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                       "2026-11-14 09:01:00 INFO done\n")
        initial = legacy_sample_steps._read_calls((self.root,))
        original = legacy_sample_steps._parse_calls

        def parse(*args):
            self.assertTrue(legacy_sample_steps._cache_lock.acquire(blocking=False))
            legacy_sample_steps._cache_lock.release()
            return original(*args)

        with (patch.object(legacy_sample_steps, "record_frames", wraps=legacy_sample_steps.record_frames) as frames,
              patch.object(legacy_sample_steps, "_parse_calls", side_effect=parse)):
            with self.log.open("ab") as stream:
                stream.write(b"2026-11-14 09:02:00 INFO Generating sample images at step 6")
            self.assertEqual(legacy_sample_steps._read_calls((self.root,)), initial)
            self.assertEqual(frames.call_count, 0)
            with self.log.open("ab") as stream:
                stream.write(b"0\n2026-11-14 09:03:00 INFO done\n")
            updated = legacy_sample_steps._read_calls((self.root,))
            self.assertEqual([call.step for call in updated], [54, 60])
            self.assertEqual(frames.call_count, 2)
            self.assertEqual(updated[0].end, updated[1].start)

    def test_truncation_replacement_and_rewritten_tail_reset_incremental_state(self):
        original = "epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n2026-11-14 09:01:00 INFO done\n"
        self.write_log(original)
        self.assertEqual(legacy_sample_steps._read_calls((self.root,))[0].step, 54)
        self.write_log(original.replace("step 54", "step 4"))
        self.assertEqual(legacy_sample_steps._read_calls((self.root,))[0].step, 4)
        self.write_log(original.replace("step 54", "step 154") + "2026-11-14 09:02:00 INFO done\n")
        self.assertEqual([call.step for call in legacy_sample_steps._read_calls((self.root,))], [154])
        replacement = self.root / "replacement.log"
        replacement.write_text(original.replace("step 54", "step 254"), encoding="utf-8")
        os.replace(replacement, self.log)
        self.assertEqual([call.step for call in legacy_sample_steps._read_calls((self.root,))], [254])

    def test_missing_or_conflicting_evidence_leaves_step_unknown(self):
        cases = [
            "epoch 1/20\ntotal optimization steps: 1080\n",
            "epoch 1/20\nGenerating sample images at step 54\n",
            "epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
            "2026-11-14 09:00:00 INFO Generating sample images at step 55\n2026-11-14 09:01:00 INFO done\n",
            "epoch 2/20\n2026-11-14 09:00:00 INFO Generating sample images at step 108\n2026-11-14 09:01:00 INFO done\n",
            "epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n",
            "epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 5",
        ]
        for text in cases:
            with self.subTest(log=text):
                self.write_log(text)
                sample = self.sample()
                legacy_sample_steps.enrich_legacy_sample_steps([sample], self.root)
                self.assertIsNone(sample["sample"]["step"])
                self.assertNotIn("step_source", sample["sample"])

    def test_timestamp_outside_log_and_clock_reversal_do_not_match(self):
        self.write_log("epoch 1/20\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                       "2026-11-14 09:01:00 INFO done\n")
        samples = [self.sample(timestamp="20261114085959"), self.sample(timestamp="20261114090101")]
        legacy_sample_steps.enrich_legacy_sample_steps(samples, self.root)
        self.assertTrue(all(item["sample"]["step"] is None for item in samples))
        self.write_log("epoch 1/20\n2026-11-14 09:01:00 INFO Generating sample images at step 54\n"
                       "2026-11-14 09:00:00 INFO Generating sample images at step 55\n2026-11-14 09:02:00 INFO done\n")
        sample = self.sample()
        legacy_sample_steps.enrich_legacy_sample_steps([sample], self.root)
        self.assertIsNone(sample["sample"]["step"])

    def test_cache_reuses_unchanged_log_and_reloads_changed_or_selected_log(self):
        text = "epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n2026-11-14 09:01:00 INFO done\n"
        self.write_log(text)
        with patch.object(legacy_sample_steps, "_parse_calls", wraps=legacy_sample_steps._parse_calls) as parse:
            for _ in range(2):
                legacy_sample_steps.enrich_legacy_sample_steps([self.sample()], self.root)
            self.assertEqual(parse.call_count, 1)
            self.write_log(text.replace("step 54", "step 154"))
            changed = self.sample()
            legacy_sample_steps.enrich_legacy_sample_steps([changed], self.root)
            self.assertEqual(changed["sample"]["step"], 154)
            self.assertEqual(parse.call_count, 2)
            other = self.root / "train_other.log"
            other.write_text(text.replace("step 54", "step 254"), encoding="utf-8")
            self.log.unlink()
            selected = self.sample()
            legacy_sample_steps.enrich_legacy_sample_steps([selected], self.root)
            self.assertEqual(selected["sample"]["step"], 254)
            self.assertEqual(parse.call_count, 3)

    def test_preview_response_uses_run_log_and_preserves_existing_recorded_step(self):
        artifact = self.root / "external"
        image = artifact / "sample" / self.sample()["name"]
        image.parent.mkdir(parents=True)
        image.write_bytes(b"image contents are not decoded")
        self.write_log("epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n2026-11-14 09:01:00 INFO done\n")
        preview = newest_previews(str(artifact), force_refresh=True, run_dir=str(self.root))[0]
        self.assertEqual(preview["sample"]["step"], 54)
        self.assertTrue(preview["sample"]["metadata_version"].endswith(":log-step:54"))
        relative = image.relative_to(artifact).as_posix()
        write_sample_batch(artifact, {"id": "recorded", "epoch": 1, "step": 777, "status": "complete"},
                           {relative: {"params": {}, "prompt_index": 0}})
        with patch.object(legacy_sample_steps, "_read_calls", side_effect=AssertionError("recorded step needs no log scan")):
            preview = newest_previews(str(artifact), force_refresh=True, run_dir=str(self.root))[0]
        self.assertEqual(preview["sample"]["step"], 777)
        self.assertNotIn("step_source", preview["sample"])

    def test_recovered_step_changes_metadata_signature_but_unrelated_appends_do_not(self):
        image = self.root / "sample" / self.sample()["name"]
        image.parent.mkdir()
        image.write_bytes(b"image contents are not decoded")
        text = "epoch 1/2\n2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
        self.write_log(text)
        first = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.write_log(text + "2026-11-14 09:01:00 INFO done\n")
        recovered = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertNotEqual(first["metadata_version"], recovered["metadata_version"])
        with self.log.open("a", encoding="utf-8") as stream:
            stream.write("2026-11-14 09:02:00 INFO unrelated update\n")
        appended = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertEqual(recovered["metadata_version"], appended["metadata_version"])

    def test_single_actual_prompt_restores_display_only_for_its_sampling_call(self):
        self.write_log(self.prompt_log(self.prompt_line())
                       + "epoch 2/20\n2026-11-14 09:05:00 INFO Generating sample images at step 108\n"
                       + self.prompt_line("a different rabbit", timestamp="09:05:01")
                       + "2026-11-14 09:06:00 INFO done\n")
        samples = [self.sample(), self.sample(2, "20261114090515")]
        legacy_sample_steps.enrich_legacy_sample_steps(samples, self.root)
        first, second = [item["sample"] for item in samples]
        self.assertEqual(first["params"], {"prompt": "a rabbit, cowboy shot"})
        self.assertEqual(second["params"], {"prompt": "a different rabbit"})
        self.assertEqual(first["prompt_label"], "a rabbit, cowboy shot")
        self.assertEqual(first["metadata_source"], "filename")
        self.assertFalse(first["comparable"])
        self.assertIsNone(first["pair_key"])
        self.assertIsNone(first["condition_key"])
        self.assertEqual(first["prompt_id"], "legacy:demo_:0")

    def test_ambiguous_or_incomplete_prompt_evidence_leaves_prompt_unknown(self):
        cases = [
            "",
            self.prompt_line(seed="43"),
            self.prompt_line(seed="None"),
            self.prompt_line() + self.prompt_line(),
            self.prompt_line() + self.prompt_line("another rabbit"),
            self.prompt_line("a rabbit --n bad --w 832 --h 1216 --d 42"),
            "2026-11-14 09:00:00 INFO prompt: a rabbit --n bad --d 42\n",
            self.prompt_line(timestamp="08:59:59"),
            self.prompt_line(timestamp="09:00:16"),
            self.prompt_line().split(" INFO", 1)[1].lstrip(),
            self.prompt_line().replace("anima_train_utils.py", "other_trainer.py"),
            self.prompt_line() + "2026-11-14 09:00:00 INFO prompt: truncated\n",
        ]
        for evidence in cases:
            with self.subTest(evidence=evidence):
                self.write_log(self.prompt_log(evidence))
                sample = self.sample()
                legacy_sample_steps.enrich_legacy_sample_steps([sample], self.root)
                self.assertEqual(sample["sample"]["step"], 54)
                self.assertEqual(sample["sample"]["params"], {})
                self.assertEqual(sample["sample"]["prompt_label"], "Prompt 1")

    def test_prompt_requires_unique_call_slot_zero_and_explicit_matching_filename_seed(self):
        self.write_log(self.prompt_log(self.prompt_line()))
        samples = [self.sample() for _ in range(4)]
        samples[0]["name"] = samples[0]["name"].replace("_00_", "_01_")
        samples[0]["sample"]["prompt_index"] = 1
        samples[1]["name"] = samples[1]["name"].replace("_42.png", ".png")
        samples[2]["name"] = samples[2]["name"].replace("_42.png", "_43.png")
        samples[3]["sample"]["seed"] = 43
        legacy_sample_steps.enrich_legacy_sample_steps(samples, self.root)
        self.assertTrue(all(item["sample"]["params"] == {} for item in samples))
        self.write_log(self.prompt_log(self.prompt_line()
                                      + "2026-11-14 09:00:00 INFO Generating sample images at step 54\n"
                                      + self.prompt_line()))
        sample = self.sample()
        legacy_sample_steps.enrich_legacy_sample_steps([sample], self.root)
        self.assertEqual(sample["sample"]["step"], 54)
        self.assertEqual(sample["sample"]["params"], {})

    def test_existing_actual_prompt_and_recorded_metadata_are_preserved(self):
        self.write_log(self.prompt_log(self.prompt_line()))
        existing, recorded = self.sample(), self.sample()
        existing["sample"]["params"] = {"prompt": "saved actual prompt"}
        existing["sample"]["prompt_label"] = "saved actual label"
        recorded["sample"].update(metadata_source="recorded", params={"prompt": "recorded actual prompt"})
        legacy_sample_steps.enrich_legacy_sample_steps([existing, recorded], self.root)
        self.assertEqual(existing["sample"]["params"], {"prompt": "saved actual prompt"})
        self.assertEqual(existing["sample"]["prompt_label"], "saved actual label")
        self.assertEqual(recorded["sample"]["params"], {"prompt": "recorded actual prompt"})
        self.assertEqual(recorded["sample"]["metadata_source"], "recorded")

    def test_prompt_signature_changes_with_actual_text_only(self):
        image = self.root / "sample" / self.sample()["name"]
        image.parent.mkdir()
        image.write_bytes(b"image contents are not decoded")
        self.write_log(self.prompt_log())
        first = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.write_log(self.prompt_log(self.prompt_line()))
        recovered = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertIn(":log-prompt:", recovered["metadata_version"])
        self.assertNotEqual(first["metadata_version"], recovered["metadata_version"])
        with self.log.open("a", encoding="utf-8") as stream:
            stream.write("2026-11-14 09:02:00 INFO unrelated update\n")
        appended = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertEqual(recovered["metadata_version"], appended["metadata_version"])
        self.write_log(self.prompt_log(self.prompt_line("a different rabbit")))
        changed = newest_previews(str(self.root), force_refresh=True)[0]["sample"]
        self.assertNotEqual(recovered["metadata_version"], changed["metadata_version"])
