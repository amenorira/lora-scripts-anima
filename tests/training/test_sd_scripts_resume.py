"""Exercise the shipped trainer's resume and iteration blocks with CPU Accelerate."""
import math
import io
import json
import logging
import os
from pathlib import Path
import random
import tempfile
import textwrap
from types import SimpleNamespace
import unittest

from backend.training.execution.sd_scripts_resume import _resume_source, sampling_seed, training_dataloader


def _cpu_training_loop(*, resume=True):
    # Execute the actual vendored position, progress and batch-selection code.
    # Substitute a small linear model for the diffusion forward/backward pass.
    path = Path(__file__).resolve().parents[2] / "vendor/sd-scripts/train_network.py"
    source = _resume_source(path.read_text(encoding="utf-8"), resume=resume)
    compile(source, str(path), "exec")

    def section(start, end):
        begin = source.index(start)
        return textwrap.dedent(source[begin:source.index(end, begin)]).rstrip()

    from tqdm import tqdm
    scope = {"math": math, "json": json, "os": os, "logger": logging.getLogger(__name__),
             "tqdm": lambda *a, **kw: tqdm(*a, **kw, file=io.StringIO()),
             "current_step": SimpleNamespace(value=0)}
    setup = section("        # calculate steps to skip", "        noise_scheduler =")
    skip_epochs = section("        # training loop\n", "        # log device")
    progress = section("        progress_bar = tqdm(", "        validation_steps =")
    batches = section("            skipped_dataloader = None", "                run_controller.on_batch_fetched")
    body = """
args, train_dataloader, model, optimizer, accelerator, steps_from_state, stop_at = inputs
network, current_epoch = model, args.epoch
num_update_steps_per_epoch = math.ceil(len(train_dataloader) / args.gradient_accumulation_steps)
num_train_epochs = math.ceil(args.max_train_steps / num_update_steps_per_epoch)
seen, updates = [], []
"""
    save_hook = section("        def save_model_hook(", "        steps_from_state = None")
    body += "\n".join((save_hook, "accelerator.register_save_state_pre_hook(save_model_hook)",
                        setup, skip_epochs, progress)) + "\n"
    body += "initial_progress = (progress_bar.n, progress_bar.total)\n"
    body += "for epoch in range(epoch_to_start, num_train_epochs):\n    args.epoch.value = epoch + 1\n"
    body += textwrap.indent(batches, "    ") + "\n"
    body += """
        seen.append((epoch, int(batch.item())))
        with accelerator.accumulate(model):
            accelerator.backward(model(batch.float().reshape(1, 1)).sum())
            optimizer.step()
            optimizer.zero_grad()
        if accelerator.sync_gradients:
            global_step += 1
            updates.append(global_step)
        if global_step == stop_at:
            return seen, updates, initial_progress
    if global_step >= args.max_train_steps:
        break
return seen, updates, initial_progress
"""
    exec("def train(inputs):\n" + textwrap.indent(body, "    "), scope)
    return scope["train"]


class _BucketDataset:
    def __init__(self, size):
        self.keys = list(range(size))
        self.epoch = 0

    @property
    def datasets(self):
        return (self,)

    def set_seed(self, seed):
        self.seed = seed

    def set_current_epoch(self, epoch):
        while self.epoch < epoch:
            self.epoch += 1
            random.Random(self.seed + self.epoch).shuffle(self.keys)

    def set_current_step(self, step):
        pass

    def __len__(self):
        return len(self.keys)

    def __getitem__(self, index):
        import torch
        return torch.tensor(self.keys[index])


class DesktopResumeTests(unittest.TestCase):
    def test_validation_split_uses_checkpoint_seed_and_respects_explicit_seed(self):
        from argparse import Namespace
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.config_util import BlueprintGenerator, ConfigSanitizer
        from library.dataset import split_train_val

        path = Path(__file__).resolve().parents[2] / "vendor/sd-scripts/train_network.py"
        source = _resume_source(path.read_text(encoding="utf-8"))
        build = next(line.strip() for line in source.splitlines() if "blueprint = blueprint_generator.generate(" in line)
        generator = BlueprintGenerator(ConfigSanitizer(True, True, False, True))
        config = {"datasets": [{"subsets": [{"image_dir": "images"}], "validation_split": 0.5}]}
        images = [str(i) for i in range(16)]

        def partitions(args):
            scope = dict(blueprint_generator=generator, user_config=config, args=args, data_seed=sampling_seed(args))
            exec(build, scope)
            params = scope["blueprint"].dataset_group.datasets[0].params
            return [split_train_val(images, [None] * len(images), training, params.validation_split,
                                    params.validation_seed)[0] for training in (True, False)]

        with tempfile.TemporaryDirectory() as tmp:
            original = partitions(Namespace(seed=913, resume=None))
            self.assertEqual(set(original[0]).intersection(original[1]), set())
            (Path(tmp) / "train_state.json").write_text('{"data_seed":913}', encoding="utf-8")
            self.assertEqual(partitions(Namespace(seed=72, resume=tmp)), original)
            explicit = partitions(Namespace(seed=72, resume=tmp, validation_seed=81))
            self.assertNotEqual(explicit, original)
            self.assertEqual(explicit, partitions(Namespace(seed=81, resume=None)))

    def test_saved_optimizer_step_and_remaining_batches_match_uninterrupted_training(self):
        import torch
        from accelerate import Accelerator
        from multiprocessing import Value

        train = _cpu_training_loop()
        fresh = _cpu_training_loop(resume=False)
        for batches, accumulation, total, saved, workers in (
            (8, 2, 4, 2, 0),        # mid-epoch with gradient accumulation
            (100, 1, 200, 50, 0),   # middle of the first epoch
            (5, 2, 8, 3, 0),        # complete epoch, including a partial accumulation
            (5, 2, 8, 4, 1),        # later epoch, persistent worker in a new process
            (5, 2, 8, 5, 0),        # only the partial last update remains in this epoch
        ):
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as temp:
                args = SimpleNamespace(max_train_steps=total, initial_step=None, initial_epoch=None,
                                       gradient_accumulation_steps=accumulation, skip_until_initial_step=False,
                                       persistent_data_loader_workers=bool(workers), resume=None, seed=913)

                def prepare():
                    accelerator = Accelerator(cpu=True, gradient_accumulation_steps=accumulation)
                    model = torch.nn.Linear(1, 1, bias=False)
                    model.weight.data.zero_()
                    optim = torch.optim.SGD(model.parameters(), lr=0.01, momentum=0.9)
                    args.epoch = Value("i", 0)
                    dataset = _BucketDataset(batches)
                    loader = training_dataloader(dataset, accelerator, args, args.epoch, Value("i", 0), workers,
                                                 sampling_seed(args))
                    return (*accelerator.prepare(loader, model, optim), accelerator)

                baseline = prepare()
                all_batches, all_updates, _ = fresh((args, *baseline, None, total))
                before = prepare()
                prefix, pre_updates, _ = fresh((args, *before, None, saved))
                before[-1].save_state(temp)
                metadata = json.loads((Path(temp) / "train_state.json").read_text(encoding="utf-8"))
                self.assertEqual((metadata["current_step"], metadata["data_seed"]), (saved, 913))
                args.resume, args.seed = temp, 72
                after = prepare()
                after[-1].load_state(temp)
                suffix, post_updates, progress = train((args, *after, saved, total))
                self.assertEqual(prefix + suffix, all_batches)
                self.assertEqual(sorted(index for epoch, index in all_batches if epoch == 0), list(range(batches)))
                self.assertEqual(pre_updates + post_updates, all_updates)
                self.assertEqual(post_updates, list(range(saved + 1, total + 1)))
                self.assertEqual(progress, (saved, total))
                torch.testing.assert_close(baseline[1].weight, after[1].weight)
