"""Start the selected trainer with its control files in the task-owned log directory."""
import os
import runpy
import sys
import time
from pathlib import Path


if __name__ == "__main__":
    sys.argv.pop(0)
    trainer = Path(sys.argv[0]).resolve()
    sys.path.insert(0, str(trainer.parent))
    from backend.training.checkpoint_state import track_state_saves
    from backend.training.preview.prompt_file import read_prompt_entries
    from library import run_control, sampling

    build_manifest = run_control.build_manifest
    build_forced_prompts = sampling.build_forced_prompts

    def load_desktop_prompts(path):
        # Keep scheduled prompts live when the trainer can still encode new text.
        entries = read_prompt_entries(Path(path), moss=trainer.name == "moss_image_train_network.py")
        for index, entry in enumerate(entries):
            if isinstance(entry, str):
                entry = entries[index] = sampling.line_to_prompt_dict(entry)
            entry["enum"] = index
            entry.pop("subset", None)
        return entries

    def tagged_forced_prompts(args, prompts=None, indices=None, overrides=None):
        presets = getattr(args, "_anima_preview_presets", None)
        if indices and presets is not None:
            if any(type(index) is not int or not 0 <= index < len(presets) for index in indices):
                raise ValueError("preview preset index is out of range")
            # Use the same entries the GUI displayed even if the prompt file has changed.
            selected = [presets[index] for index in indices]
            result = build_forced_prompts(args, prompts=selected + (prompts or []), overrides=overrides)
        else:
            result = build_forced_prompts(args, prompts=prompts, indices=indices, overrides=overrides)
        for i, item in enumerate(result):
            item["_anima_manual"] = True
            if indices and i < len(indices) and isinstance(indices[i], int) and not isinstance(indices[i], bool):
                item["_anima_preset_index"] = indices[i]
        return result

    class DesktopRunController(run_control.RunController):
        def __init__(self, args, is_main_process=True):
            root = os.environ["ANIMA_RUN_CONTROL_DIR"] if args.run_control and is_main_process else None
            super().__init__(root, status_interval=1.0)
            self.trainer_args = args
            self._last_loss_flush = -5.0
            self._force_loss_flush = False

        def on_epoch_start(self, *, epoch):
            # The sampler receives epoch=None for step and on-demand previews.
            self.trainer_args._anima_preview_epoch = epoch
            super().on_epoch_start(epoch=epoch)

        def on_step_end(self, *, global_step, **metrics):
            if self.enabled and self._started:
                self._status["progress"]["metrics_step"] = global_step
                self._status["progress"]["metrics_time"] = time.time()
            super().on_step_end(global_step=global_step, **metrics)

        def set_paused(self, paused, *, step):
            # Pause commands run after the optimizer step and before on_step_end.
            if paused and self.enabled and self._started and not self.paused:
                self._status["progress"]["global_step"] = step
            return super().set_paused(paused, step=step)

        def _flush_sample_losses(self):
            if not self._pending_losses:
                return
            now = time.monotonic()
            if not self._force_loss_flush and len(self._pending_losses) < 128 and (now - self._last_loss_flush) < 5.0:
                return
            super()._flush_sample_losses()
            self._last_loss_flush = now

        def finish(self, state="finished"):
            self._force_loss_flush = True
            try:
                return super().finish(state=state)
            finally:
                self._force_loss_flush = False

    def gui_manifest(args, *values, **kwargs):
        manifest = build_manifest(args, *values, **kwargs)
        prompts = []
        if args.sample_prompts and Path(args.sample_prompts).is_file():
            try:
                entries = sampling.load_prompts(args.sample_prompts)
            except (OSError, ValueError):
                entries = []
            if entries:
                defaults = ("width", "height", "scale", "negative_prompt", "flow_shift", "seed")
                manifest["preview_defaults"] = {key: entries[0][key] for key in defaults if key in entries[0]}
                if entries[0].get("sample_steps"):
                    manifest["preview_defaults"]["sample_steps"] = entries[0]["sample_steps"]
                if Path(args.sample_prompts) == Path(os.environ["ANIMA_RUN_CONTROL_DIR"]) / "manual-preview.json":
                    manifest["manual_preview_cache"] = True
                    steps = os.environ.get("ANIMA_MANUAL_PREVIEW_STEPS", "")
                    if steps.isdecimal() and int(steps) > 0:
                        manifest["preview_defaults"]["sample_steps"] = int(steps)
                else:
                    prompts = entries
                args._anima_preview_presets = entries
        manifest["preview_prompts"] = prompts
        return manifest

    track_state_saves()
    sampling.load_prompts = load_desktop_prompts
    sampling.build_forced_prompts = tagged_forced_prompts
    run_control.create_run_controller = DesktopRunController
    run_control.build_manifest = gui_manifest
    from backend.training.execution.sd_scripts_resume import load_resume_trainer

    load_resume_trainer(trainer.parent / "train_network.py", resume=os.environ.get("ANIMA_RESUME_TRAINING") == "1")
    runpy.run_path(str(trainer), run_name="__main__")
