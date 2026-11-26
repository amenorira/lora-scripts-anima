"""Exercise the shipped trainer's resume and iteration blocks with CPU Accelerate."""
import math
import io
from pathlib import Path
import tempfile
import textwrap
from types import SimpleNamespace
import unittest

from backend.training.execution.sd_scripts_resume import _resume_source


def _cpu_training_loop():
    # Execute the actual vendored position, progress and batch-selection code.
    # Substitute a small linear model for the diffusion forward/backward pass.
    path = Path(__file__).resolve().parents[2] / "vendor/sd-scripts/train_network.py"
    source = _resume_source(path.read_text(encoding="utf-8"))
    compile(source, str(path), "exec")

    def section(start, end):
        begin = source.index(start)
        return textwrap.dedent(source[begin:source.index(end, begin)]).rstrip()

    from tqdm import tqdm
    scope = {"math": math, "tqdm": lambda *a, **kw: tqdm(*a, **kw, file=io.StringIO()),
             "current_step": SimpleNamespace(value=0)}
    setup = section("        # calculate steps to skip", "        noise_scheduler =")
    skip_epochs = section("        # training loop\n", "        # log device")
    progress = section("        progress_bar = tqdm(", "        validation_steps =")
    batches = section("            skipped_dataloader = None", "                run_controller.on_batch_fetched")
    body = """
args, train_dataloader, model, optimizer, accelerator, steps_from_state, stop_at = inputs
num_update_steps_per_epoch = math.ceil(len(train_dataloader) / args.gradient_accumulation_steps)
num_train_epochs = math.ceil(args.max_train_steps / num_update_steps_per_epoch)
seen, updates = [], []
"""
    body += "\n".join((setup, skip_epochs, progress)) + "\n"
    body += "initial_progress = (progress_bar.n, progress_bar.total)\n"
    body += "for epoch in range(epoch_to_start, num_train_epochs):\n" + textwrap.indent(batches, "    ") + "\n"
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


class DesktopResumeTests(unittest.TestCase):
    def test_saved_optimizer_step_and_remaining_batches_match_uninterrupted_training(self):
        import torch
        from accelerate import Accelerator, DataLoaderConfiguration
        from torch.utils.data import DataLoader

        train = _cpu_training_loop()
        for batches, accumulation, total, saved in (
            (100, 1, 200, 50),   # middle of the first epoch
            (5, 2, 8, 3),       # complete epoch, including a partial accumulation
            (5, 2, 8, 4),       # middle of a later epoch
            (5, 2, 8, 5),       # only the partial last update remains in this epoch
        ):
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as temp:
                args = SimpleNamespace(max_train_steps=total, initial_step=None, initial_epoch=None,
                                       gradient_accumulation_steps=accumulation, skip_until_initial_step=False)

                def prepare():
                    accelerator = Accelerator(cpu=True, gradient_accumulation_steps=accumulation,
                                              dataloader_config=DataLoaderConfiguration(
                                                  use_seedable_sampler=True, data_seed=913))
                    model = torch.nn.Linear(1, 1, bias=False)
                    model.weight.data.zero_()
                    optim = torch.optim.SGD(model.parameters(), lr=0.01, momentum=0.9)
                    loader = DataLoader(range(batches), shuffle=True)
                    return (*accelerator.prepare(loader, model, optim), accelerator)

                baseline = prepare()
                all_batches, all_updates, _ = train((args, *baseline, None, total))
                before = prepare()
                prefix, pre_updates, _ = train((args, *before, None, saved))
                before[-1].save_state(temp)
                after = prepare()
                after[-1].load_state(temp)
                suffix, post_updates, progress = train((args, *after, saved, total))
                self.assertEqual(prefix + suffix, all_batches)
                self.assertEqual(pre_updates + post_updates, all_updates)
                self.assertEqual(post_updates, list(range(saved + 1, total + 1)))
                self.assertEqual(progress, (saved, total))
                torch.testing.assert_close(baseline[1].weight, after[1].weight)
