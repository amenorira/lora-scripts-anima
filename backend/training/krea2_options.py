"""Krea 2 option and optimizer contracts shared by fields and runtime."""
from __future__ import annotations

from backend.training.optimizer_contracts import FormArgument
from backend.training.krea2_optimizers import ARGUMENTS as _SHARED_KREA2_OPTIMIZER_ARGUMENTS
from backend.training.optimizer_metadata import (
    KREA2_PRODIGYPLUS_OPTIMIZER_TYPE, KREA2_SCHEDULEFREE_OPTIMIZER_TYPE, KREA2_PROFILE,
    internal_scheduler_selectors, optimizer_beta_hint_map, optimizer_beta_lengths,
    optimizer_entries, optimizer_eps_selectors, optimizer_selectors,
)


KREA2_PROFILE_ID = "krea2-lora"


def is_empty(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


ATTENTION_FLAGS = {
    "sdpa": "sdpa",
    "flash_attn": "flash_attn",
    "xformers": "xformers",
}
MIXED_PRECISIONS = ("bf16", "fp16")
TRAINING_DURATIONS = {"epochs", "steps"}
LR_SCHEDULERS = {
    "constant",
    "constant_with_warmup",
    "linear",
    "cosine",
    "cosine_with_restarts",
    "polynomial",
    "inverse_sqrt",
    "cosine_with_min_lr",
    "warmup_stable_decay",
    "piecewise_constant",
    # Kept for old saved presets.  musubi selects this internally for
    # AdaFactor relative-step mode; it is deliberately not offered as a
    # general UI scheduler.
    "adafactor",
    "rex",
}
COMPILE_MODES = {"default", "reduce-overhead", "max-autotune", "max-autotune-no-cudagraphs"}
COMPILE_DYNAMIC_VALUES = {"auto", "true", "false"}
PRODIGYPLUS_OPTIMIZER = KREA2_PRODIGYPLUS_OPTIMIZER_TYPE
# musubi recognizes optimizer classes ending in ``ScheduleFree`` and supplies
# its own no-op scheduler for them.  That does *not* mean each such class
# accepts AdamWScheduleFree's ``warmup_steps`` constructor argument.
INTERNAL_SCHEDULER_OPTIMIZERS = internal_scheduler_selectors(KREA2_PROFILE)
SCHEDULEFREE_WARMUP_OPTIMIZERS = frozenset({KREA2_SCHEDULEFREE_OPTIMIZER_TYPE})
PRODIGY_OPTIMIZERS = frozenset({"prodigyopt.Prodigy", PRODIGYPLUS_OPTIMIZER})
BETA_LENGTHS: dict[str, set[int]] = optimizer_beta_lengths(KREA2_PROFILE)
# Hidden legacy torch optimizers remain launch-compatible but are not product
# options, so their constructor capabilities stay local to the compatibility path.
BETA_LENGTHS.update(
    {
        "torch.optim.Adam": {2},
        "torch.optim.RAdam": {2},
        "torch.optim.NAdam": {2},
    }
)
BETA_OPTIMIZERS = set(BETA_LENGTHS)
BETA_HINTS = optimizer_beta_hint_map(KREA2_PROFILE)
BETA_HINTS.update(
    {
        "torch.optim.Adam": "field.betasHint_adam",
        "torch.optim.RAdam": "field.betasHint_adam",
        "torch.optim.NAdam": "field.betasHint_adam",
    }
)
EPS_OPTIMIZERS = set(optimizer_eps_selectors(KREA2_PROFILE))
EPS_OPTIMIZERS.update(
    {"torch.optim.Adam", "torch.optim.RAdam", "torch.optim.NAdam"}
)
EPS_OPTIMIZER_ORDER = tuple(
    entry.selector
    for entry in optimizer_entries(KREA2_PROFILE)
    if entry.selector in EPS_OPTIMIZERS
) + ("torch.optim.Adam", "torch.optim.RAdam", "torch.optim.NAdam")
MIN_LR_RATIO_SCHEDULERS = {"cosine_with_min_lr", "warmup_stable_decay", "rex"}
NUM_CYCLES_SCHEDULERS = {"cosine_with_restarts", "cosine_with_min_lr", "warmup_stable_decay"}
LEGACY_OPTIMIZER_ALIASES = {
    **{entry.label.lower(): entry.selector for entry in optimizer_entries(KREA2_PROFILE)},
    # These bare values were valid selectors in the sd-scripts form, but
    # musubi resolves non-dotted names from torch.optim.  Translate only the
    # known values to their real musubi-importable class paths.
    "pagedadamw8bit": "bitsandbytes.optim.PagedAdamW8bit",
    "lion": "pytorch_optimizer.Lion",
    "lion8bit": "bitsandbytes.optim.Lion8bit",
    "pagedlion8bit": "bitsandbytes.optim.PagedLion8bit",
    "prodigy": "prodigyopt.Prodigy",
    "prodigyplus": PRODIGYPLUS_OPTIMIZER,
    "prodigyplusschedulefree": PRODIGYPLUS_OPTIMIZER,
    "adamwschedulefree": "schedulefree.AdamWScheduleFree",
    "came": "pytorch_optimizer.CAME",
}
VISIBLE_OPTIMIZERS = optimizer_selectors(KREA2_PROFILE)
# These generic torch optimizers were visible in the first Krea 2 release.
# Keep them launch-compatible for saved presets, but do not offer new tasks a
# half-configured SGD/Adam-family surface in the curated selector.
HIDDEN_LEGACY_OPTIMIZERS = frozenset(
    {"torch.optim.Adam", "torch.optim.RAdam", "torch.optim.NAdam", "torch.optim.SGD"}
)
CURATED_OPTIMIZERS = VISIBLE_OPTIMIZERS | HIDDEN_LEGACY_OPTIMIZERS
OPTIMIZER_ARGUMENTS = {
    **_SHARED_KREA2_OPTIMIZER_ARGUMENTS,
    "krea_adamw_fused": FormArgument("fused", {"AdamW"}),
    "krea_optimizer_weight_decay": FormArgument("weight_decay", CURATED_OPTIMIZERS),
    "krea_optimizer_betas": FormArgument("betas", BETA_OPTIMIZERS),
    "krea_optimizer_eps": FormArgument("eps", EPS_OPTIMIZERS),
    "krea_prodigy_d_coef": FormArgument("d_coef", PRODIGY_OPTIMIZERS),
    "krea_prodigy_d0": FormArgument("d0", PRODIGY_OPTIMIZERS),
    "krea_prodigyplus_use_stableadamw": FormArgument("use_stableadamw", {PRODIGYPLUS_OPTIMIZER}),
    "krea_schedulefree_warmup_steps": FormArgument("warmup_steps", SCHEDULEFREE_WARMUP_OPTIMIZERS),
    **{
        f"krea_adafactor_{key}": FormArgument(key, {"AdaFactor"})
        for key in ("relative_step", "scale_parameter", "warmup_init", "clip_threshold", "eps")
    },
}
OPTIONAL_OPTIMIZER_PACKAGES = {
    "pytorch_optimizer.": "pytorch-optimizer",
    "prodigyopt.": "prodigyopt",
    "prodigyplus.": "prodigy-plus-schedule-free",
    "schedulefree.": "schedulefree",
}
