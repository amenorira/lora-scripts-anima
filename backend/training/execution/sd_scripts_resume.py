"""Adapt sd-scripts 0.13.1's local optimizer-step counter for desktop resumes."""
import importlib.util
from pathlib import Path
import sys


def _resume_source(source: str) -> str:
    # The counter and loop are locals inside NetworkTrainer.train, with no
    # upstream override point. Keep each edit anchored to the vendored version.
    replacements = (
        ("                initial_step = steps_from_state\n                steps_from_state = None",
         "                initial_step = steps_from_state"),
        ("        global_step = 0\n", """        global_step = 0
        resume_batches = 0
        if steps_from_state is not None and args.initial_step is None and args.initial_epoch is None:
            global_step = steps_from_state
            epoch_to_start, updates_in_epoch = divmod(global_step, num_update_steps_per_epoch)
            resume_batches = updates_in_epoch * args.gradient_accumulation_steps
            initial_step = 0  # the native skip path uses this for both batches and optimizer steps
"""),
        ("        with run_controller.watch_samples(step=global_step):\n"
         "            self.sample_images(accelerator, args, 0, global_step, accelerator.device, vae, tokenizers, text_encoder, unet)",
         "        if not global_step:\n"
         "            with run_controller.watch_samples(step=global_step):\n"
         "                self.sample_images(accelerator, args, 0, global_step, accelerator.device, vae, tokenizers, text_encoder, unet)"),
        ("range(args.max_train_steps - initial_step), smoothing=0",
         "range(args.max_train_steps - global_step), initial=global_step, total=args.max_train_steps, smoothing=0"),
        ("            skipped_dataloader = None\n", """            skipped_dataloader = None
            if steps_from_state is not None:
                train_dataloader.set_epoch(epoch)
                if epoch == epoch_to_start and resume_batches:
                    skipped_dataloader = accelerator.skip_first_batches(train_dataloader, resume_batches)
"""),
    )
    for original, updated in replacements:
        if source.count(original) != 1:
            raise RuntimeError("The sd-scripts training loop changed. Review the desktop resume integration.")
        source = source.replace(original, updated)
    return source


def load_resume_trainer(path: Path) -> None:
    """Load the same train_network module imported by the three desktop trainers."""
    spec = importlib.util.spec_from_file_location("train_network", path)
    module = importlib.util.module_from_spec(spec)
    code = compile(_resume_source(path.read_text(encoding="utf-8")), str(path), "exec")
    sys.modules[spec.name] = module
    exec(code, module.__dict__)
