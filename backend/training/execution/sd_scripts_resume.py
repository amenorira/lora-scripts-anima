"""Adapt sd-scripts' training dataloader and optimizer-step counter for desktop resumes."""
import importlib.util
import json
import logging
from operator import itemgetter
from pathlib import Path
import sys


class _TrainingDataset:
    def __init__(self, dataset, epoch, step):
        self.dataset = dataset
        self.epoch = epoch
        self.step = step

    def __len__(self):
        return len(self.dataset)

    def __getitem__(self, index):
        # The upstream collator updates these after fetching the first example.
        # Each worker needs the right bucket permutation before its first lookup.
        self.dataset.set_current_epoch(self.epoch.value)
        self.dataset.set_current_step(self.step.value)
        return self.dataset[index]


def sampling_seed(args):
    if args.resume:
        state_file = Path(args.resume) / "train_state.json"
        state = json.loads(state_file.read_text(encoding="utf-8")) if state_file.is_file() else {}
        if "data_seed" in state:
            return state["data_seed"]
        logging.getLogger(__name__).warning("Checkpoint has no saved sampling seed. Sample order may differ on resume. / "
                                            "旧断点缺少采样种子，本次续训的样本顺序可能不同。")
    return args.seed


def training_dataloader(dataset, accelerator, args, epoch, step, workers, seed):
    from torch.utils.data import DataLoader

    accelerator.dataloader_config.use_seedable_sampler = True
    accelerator.dataloader_config.data_seed = seed
    for child_dataset in dataset.datasets:
        child_dataset.set_seed(seed)
    return DataLoader(_TrainingDataset(dataset, epoch, step), batch_size=1, shuffle=True,
                      collate_fn=itemgetter(0), num_workers=workers,
                      persistent_workers=args.persistent_data_loader_workers)


def _resume_source(source: str, *, resume: bool = True) -> str:
    # sd-scripts v0.13.1 仍通过 Accelerate 保存和加载训练状态。这里适配的是
    # NetworkTrainer.train 内部的采样顺序和步数，两者在上游都是局部变量。
    # 同步上游时，先用原生训练循环对照 tests/training/test_sd_scripts_resume.py
    # 中的中断场景，分别核对优化器步数和剩余样本 ID 序列，再移除上游已覆盖的适配。
    # 下方的唯一匹配检查只能发现源码片段变化；周围逻辑改变也可能影响续训结果。
    loader_edits = (
        ("        set_seed(args.seed)\n", """        set_seed(args.seed)
        from backend.training.execution.sd_scripts_resume import sampling_seed, training_dataloader
        data_seed = sampling_seed(args)
"""),
        ("blueprint_generator.generate(user_config, args)",
         "blueprint_generator.generate(user_config, args, validation_seed=data_seed)"),
        ("""        train_dataloader = torch.utils.data.DataLoader(
            train_dataset_group,
            batch_size=1,
            shuffle=True,
            collate_fn=collator,
            num_workers=n_workers,
            persistent_workers=args.persistent_data_loader_workers,
        )""",
         """        train_dataloader = training_dataloader(
            train_dataset_group, accelerator, args, current_epoch, current_step, n_workers, data_seed
        )"""),
        ('json.dump({"current_epoch": current_epoch.value,',
         'json.dump({"data_seed": accelerator.dataloader_config.data_seed, "current_epoch": current_epoch.value,'),
    )
    # 梯度累积时，断点记录的是优化器步数，轮内跳过的是数据批次。上游跟踪见
    # https://github.com/kohya-ss/sd-scripts/issues/2407 和 https://github.com/kohya-ss/sd-scripts/pull/2425
    resume_edits = (
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
    for original, updated in loader_edits + (resume_edits if resume else ()):
        if source.count(original) != 1:
            raise RuntimeError("The sd-scripts training loop changed. Review the desktop resume integration.")
        source = source.replace(original, updated)
    return source


def load_resume_trainer(path: Path, *, resume: bool) -> None:
    """Load the same train_network module imported by the three desktop trainers."""
    spec = importlib.util.spec_from_file_location("train_network", path)
    module = importlib.util.module_from_spec(spec)
    code = compile(_resume_source(path.read_text(encoding="utf-8"), resume=resume), str(path), "exec")
    sys.modules[spec.name] = module
    exec(code, module.__dict__)
