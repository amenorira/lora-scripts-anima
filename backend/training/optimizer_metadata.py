"""Product-level optimizer metadata shared by training profiles."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.training.optimizer_contracts import (
    ADAFACTOR_OPTIMIZER_TYPE,
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    ADAN_OPTIMIZER_TYPE,
    ADEMAMIX8BIT_OPTIMIZER_TYPE,
    ADEMAMIX_OPTIMIZER_TYPE,
    AUTOMAGIC_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    EMOSENS_OPTIMIZER_TYPE,
    LORARITE_OPTIMIZER_TYPE,
    MUON_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)


SD_SCRIPTS_PROFILE = "sd-scripts"
KREA2_PROFILE = "krea2-lora"
KREA2_PRODIGY_OPTIMIZER_TYPE = "prodigyopt.Prodigy"
KREA2_PRODIGYPLUS_OPTIMIZER_TYPE = "prodigyplus.ProdigyPlusScheduleFree"
KREA2_SCHEDULEFREE_OPTIMIZER_TYPE = "schedulefree.AdamWScheduleFree"

# 分组按技术特征命名（机制/状态存储/学习率归属），不做推荐性表述。
GROUP_BASELINE = "opt.optimizer_group_baseline"
GROUP_STABLE = "opt.optimizer_group_stable"
GROUP_FAST = "opt.optimizer_group_fast"
GROUP_LONGRUN = "opt.optimizer_group_longrun"
GROUP_AUTOLR = "opt.optimizer_group_autolr"
GROUP_MATRIX = "opt.optimizer_group_matrix"

BETA_HINT_ADAM = "field.betasHint_adam"
BETA_HINT_LION = "field.betasHint_lion"
BETA_HINT_CAME = "field.betasHint_came"
BETA_HINT_PRODIGY = "field.betasHint_prodigy"
BETA_HINT_SCHEDULEFREE = "field.betasHint_schedulefree"
BETA_HINT_ADAN = "field.betasHint_adan"
BETA_HINT_ADEMAMIX = "field.betasHint_ademamix"


@dataclass(frozen=True)
class OptimizerUIEntry:
    selector: str
    label: str
    description_key: str
    group_key: str
    beta_arity: int | None = None
    beta_hint_key: str | None = None
    supports_eps: bool = False
    scheduler_owner: str = "external"
    train_group: str | tuple[str, ...] | None = None


SD_SCRIPTS_OPTIMIZERS: tuple[OptimizerUIEntry, ...] = (
    OptimizerUIEntry(
        "AdamW8bit",
        "AdamW8bit",
        "opt.optimizer_type_AdamW8bit",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        "AdamW",
        "AdamW",
        "opt.optimizer_type_AdamW",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        "PagedAdamW8bit",
        "PagedAdamW8bit",
        "opt.optimizer_type_PagedAdamW8bit",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        STABLE_ADAMW_OPTIMIZER_TYPE,
        "StableAdamW",
        "opt.optimizer_type_StableAdamW",
        GROUP_STABLE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        CAME_OPTIMIZER_TYPE,
        "CAME",
        "opt.optimizer_type_CAME",
        GROUP_STABLE,
        3,
        BETA_HINT_CAME,
    ),
    OptimizerUIEntry(
        ADAN_OPTIMIZER_TYPE,
        "Adan",
        "opt.optimizer_type_Adan",
        GROUP_FAST,
        3,
        BETA_HINT_ADAN,
        True,
    ),
    OptimizerUIEntry(
        "Lion",
        "Lion",
        "opt.optimizer_type_Lion",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        "Lion8bit",
        "Lion8bit",
        "opt.optimizer_type_Lion8bit",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        "PagedLion8bit",
        "PagedLion8bit",
        "opt.optimizer_type_PagedLion8bit",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        ADEMAMIX_OPTIMIZER_TYPE,
        "AdEMAMix",
        "opt.optimizer_type_AdEMAMix",
        GROUP_LONGRUN,
        3,
        BETA_HINT_ADEMAMIX,
        True,
    ),
    OptimizerUIEntry(
        ADEMAMIX8BIT_OPTIMIZER_TYPE,
        "AdEMAMix8bit",
        "opt.optimizer_type_AdEMAMix8bit",
        GROUP_LONGRUN,
        3,
        BETA_HINT_ADEMAMIX,
        True,
    ),
    OptimizerUIEntry(
        PRODIGY_OPTIMIZER_TYPE,
        "Prodigy",
        "opt.optimizer_type_Prodigy",
        GROUP_AUTOLR,
        2,
        BETA_HINT_PRODIGY,
        True,
    ),
    OptimizerUIEntry(
        PRODIGYPLUS_OPTIMIZER_TYPE,
        "ProdigyPlusScheduleFree",
        "opt.optimizer_type_ProdigyPlus",
        GROUP_AUTOLR,
        2,
        BETA_HINT_SCHEDULEFREE,
        True,
        "internal",
    ),
    OptimizerUIEntry(
        ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
        "AdamWScheduleFree",
        "opt.optimizer_type_AdamWScheduleFree",
        GROUP_AUTOLR,
        2,
        BETA_HINT_SCHEDULEFREE,
        True,
        "internal",
    ),
    OptimizerUIEntry(
        ADAFACTOR_OPTIMIZER_TYPE,
        "AdaFactor",
        "opt.optimizer_type_AdaFactor",
        GROUP_AUTOLR,
    ),
    OptimizerUIEntry(
        MUON_OPTIMIZER_TYPE,
        "Muon",
        "opt.optimizer_type_Muon",
        GROUP_MATRIX,
        supports_eps=True,
        train_group="anima",
    ),
    OptimizerUIEntry(
        LORARITE_OPTIMIZER_TYPE,
        "LoRA-RITE",
        "opt.optimizer_type_LoRARite",
        GROUP_MATRIX,
        2,
        BETA_HINT_ADAM,
        True,
        train_group="anima",
    ),
    OptimizerUIEntry(
        AUTOMAGIC_OPTIMIZER_TYPE,
        "Automagic3",
        "opt.optimizer_type_Automagic3",
        GROUP_AUTOLR,
        supports_eps=True,
        scheduler_owner="internal",
    ),
    OptimizerUIEntry(
        EMOSENS_OPTIMIZER_TYPE,
        "EmoSens",
        "opt.optimizer_type_EmoSens",
        GROUP_AUTOLR,
        2,
        BETA_HINT_ADAM,
        True,
        "internal",
    ),
)

KREA2_OPTIMIZERS: tuple[OptimizerUIEntry, ...] = (
    OptimizerUIEntry(
        "adamw8bit",
        "AdamW 8-bit",
        "opt.optimizer_type_AdamW8bit",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        "AdamW",
        "AdamW",
        "opt.optimizer_type_AdamW",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        "bitsandbytes.optim.PagedAdamW8bit",
        "PagedAdamW8bit",
        "opt.optimizer_type_PagedAdamW8bit",
        GROUP_BASELINE,
        2,
        BETA_HINT_ADAM,
        True,
    ),
    OptimizerUIEntry(
        "bitsandbytes.optim.Lion8bit",
        "Lion8bit",
        "opt.optimizer_type_Lion8bit",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        "bitsandbytes.optim.PagedLion8bit",
        "PagedLion8bit",
        "opt.optimizer_type_PagedLion8bit",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        "pytorch_optimizer.Lion",
        "Lion",
        "opt.optimizer_type_Lion",
        GROUP_FAST,
        2,
        BETA_HINT_LION,
    ),
    OptimizerUIEntry(
        ADAFACTOR_OPTIMIZER_TYPE,
        "AdaFactor",
        "opt.optimizer_type_AdaFactor",
        GROUP_AUTOLR,
    ),
    OptimizerUIEntry(
        CAME_OPTIMIZER_TYPE,
        "CAME",
        "opt.optimizer_type_CAME",
        GROUP_STABLE,
        3,
        BETA_HINT_CAME,
    ),
    OptimizerUIEntry(
        KREA2_PRODIGY_OPTIMIZER_TYPE,
        "Prodigy",
        "opt.optimizer_type_Prodigy",
        GROUP_AUTOLR,
        2,
        BETA_HINT_PRODIGY,
        True,
    ),
    OptimizerUIEntry(
        KREA2_PRODIGYPLUS_OPTIMIZER_TYPE,
        "ProdigyPlusScheduleFree",
        "opt.optimizer_type_ProdigyPlus",
        GROUP_AUTOLR,
        2,
        BETA_HINT_SCHEDULEFREE,
        True,
        "internal",
    ),
    OptimizerUIEntry(
        KREA2_SCHEDULEFREE_OPTIMIZER_TYPE,
        "AdamWScheduleFree",
        "opt.optimizer_type_AdamWScheduleFree",
        GROUP_AUTOLR,
        2,
        BETA_HINT_SCHEDULEFREE,
        True,
        "internal",
    ),
)


def optimizer_entries(profile: str) -> tuple[OptimizerUIEntry, ...]:
    if profile == SD_SCRIPTS_PROFILE:
        return SD_SCRIPTS_OPTIMIZERS
    if profile == KREA2_PROFILE:
        return KREA2_OPTIMIZERS
    raise KeyError(f"unknown optimizer profile: {profile}")


def optimizer_groups(profile: str) -> list[dict[str, Any]]:
    entries = optimizer_entries(profile)
    groups: list[dict[str, Any]] = []
    for group_key in (
        GROUP_BASELINE,
        GROUP_STABLE,
        GROUP_FAST,
        GROUP_LONGRUN,
        GROUP_AUTOLR,
        GROUP_MATRIX,
    ):
        options = []
        for entry in entries:
            if entry.group_key != group_key:
                continue
            option = {
                "v": entry.selector,
                "l": entry.label,
                "dk": entry.description_key,
            }
            if entry.train_group is not None:
                option["group"] = entry.train_group
            options.append(option)
        if options:
            groups.append({"label_key": group_key, "options": options})
    return groups


def optimizer_selectors(profile: str) -> frozenset[str]:
    return frozenset(entry.selector for entry in optimizer_entries(profile))


def optimizer_beta_lengths(profile: str) -> dict[str, set[int]]:
    return {
        entry.selector: {entry.beta_arity}
        for entry in optimizer_entries(profile)
        if entry.beta_arity is not None
    }


def optimizer_beta_hint_map(profile: str) -> dict[str, str]:
    return {
        entry.selector: entry.beta_hint_key
        for entry in optimizer_entries(profile)
        if entry.beta_hint_key is not None
    }


def optimizer_eps_selectors(profile: str) -> frozenset[str]:
    return frozenset(
        entry.selector for entry in optimizer_entries(profile) if entry.supports_eps
    )


def internal_scheduler_selectors(profile: str) -> frozenset[str]:
    return frozenset(
        entry.selector
        for entry in optimizer_entries(profile)
        if entry.scheduler_owner == "internal"
    )


SD_OPTIMIZER_AUTO_VALUES: dict[str, list[dict[str, Any]]] = {
    "learning_rate": [
        {"watch": "optimizer_type", "when": PRODIGY_OPTIMIZER_TYPE, "set": "1.0"},
        {"watch": "optimizer_type", "when": PRODIGYPLUS_OPTIMIZER_TYPE, "set": "1.0"},
        {
            "watch": {"optimizer_type": "AdamW", "model_train_type": "anima-lora"},
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": "AdamW8bit", "model_train_type": "anima-lora"},
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": "PagedAdamW8bit", "model_train_type": "anima-lora"},
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": "Lion", "model_train_type": "anima-lora"},
            "set": "5e-6",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": "Lion8bit", "model_train_type": "anima-lora"},
            "set": "5e-6",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": "PagedLion8bit", "model_train_type": "anima-lora"},
            "set": "5e-6",
            "set_if_default": True,
        },
        {"watch": "optimizer_type", "when": "Lion", "set": "2e-5", "set_if_default": True},
        {"watch": "optimizer_type", "when": "Lion8bit", "set": "2e-5", "set_if_default": True},
        {
            "watch": "optimizer_type",
            "when": "PagedLion8bit",
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": MUON_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": MUON_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": AUTOMAGIC_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": {"optimizer_type": CAME_OPTIMIZER_TYPE, "model_train_type": "anima-lora"},
            "set": "1.5e-5",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": CAME_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": STABLE_ADAMW_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": STABLE_ADAMW_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
            "set": "3e-4",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
                "adafactor_relative_step": False,
            },
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": EMOSENS_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "0.1",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": EMOSENS_OPTIMIZER_TYPE,
            "set": "1.0",
            "set_if_default": True,
        },
        # Adan 的有效步长比 AdamW 大，从 0.5× 基线起步
        {
            "watch": {
                "optimizer_type": ADAN_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "1e-5",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": ADAN_OPTIMIZER_TYPE,
            "set": "5e-5",
            "set_if_default": True,
        },
        # AdEMAMix 论文沿用 AdamW 同量级学习率
        {
            "watch": {
                "optimizer_type": ADEMAMIX_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": {
                "optimizer_type": ADEMAMIX8BIT_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "2e-5",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": ADEMAMIX_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        {
            "watch": "optimizer_type",
            "when": ADEMAMIX8BIT_OPTIMIZER_TYPE,
            "set": "1e-4",
            "set_if_default": True,
        },
        # LoRA-RITE 的更新量级与 Adam 不同，anima 上从 1e-4 起步
        {
            "watch": {
                "optimizer_type": LORARITE_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            },
            "set": "1e-4",
            "set_if_default": True,
        },
    ],
    "betas": [
        {
            "watch": "optimizer_type",
            "when": selector,
            "set": value,
            "set_if_default": True,
        }
        for selector, value in (
            ("AdamW", "0.9, 0.999"),
            ("AdamW8bit", "0.9, 0.999"),
            ("PagedAdamW8bit", "0.9, 0.999"),
            ("Lion", "0.9, 0.99"),
            ("Lion8bit", "0.9, 0.99"),
            ("PagedLion8bit", "0.9, 0.99"),
            (CAME_OPTIMIZER_TYPE, "0.9, 0.999, 0.9999"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, "0.9, 0.99"),
            (EMOSENS_OPTIMIZER_TYPE, "0.9, 0.995"),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "0.9, 0.999"),
            (PRODIGY_OPTIMIZER_TYPE, "0.9, 0.999"),
            (PRODIGYPLUS_OPTIMIZER_TYPE, "0.9, 0.99"),
            (ADAN_OPTIMIZER_TYPE, "0.98, 0.92, 0.99"),
            (ADEMAMIX_OPTIMIZER_TYPE, "0.9, 0.999, 0.9999"),
            (ADEMAMIX8BIT_OPTIMIZER_TYPE, "0.9, 0.999, 0.9999"),
            (LORARITE_OPTIMIZER_TYPE, "0.9, 0.999"),
        )
    ],
    "eps": [
        {
            "watch": "optimizer_type",
            "when": selector,
            "set": value,
            "set_if_default": True,
        }
        for selector, value in (
            ("AdamW", "1e-8"),
            ("AdamW8bit", "1e-8"),
            ("PagedAdamW8bit", "1e-8"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, "1e-8"),
            (EMOSENS_OPTIMIZER_TYPE, "1e-8"),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "1e-8"),
            (PRODIGY_OPTIMIZER_TYPE, "1e-8"),
            (PRODIGYPLUS_OPTIMIZER_TYPE, "1e-8"),
            (AUTOMAGIC_OPTIMIZER_TYPE, "1e-30"),
            (MUON_OPTIMIZER_TYPE, "1e-7"),
            (ADAN_OPTIMIZER_TYPE, "1e-8"),
            (ADEMAMIX_OPTIMIZER_TYPE, "1e-8"),
            (ADEMAMIX8BIT_OPTIMIZER_TYPE, "1e-8"),
            (LORARITE_OPTIMIZER_TYPE, "1e-6"),
        )
    ],
    "weight_decay": [
        {
            "watch": "optimizer_type",
            "when": selector,
            "set": value,
            "set_if_default": True,
        }
        for selector, value in (
            ("AdamW", 0.01),
            ("AdamW8bit", 0.01),
            ("PagedAdamW8bit", 0.01),
            ("Lion", 0.0),
            ("Lion8bit", 0.0),
            ("PagedLion8bit", 0.0),
            (PRODIGY_OPTIMIZER_TYPE, 0.0),
            (PRODIGYPLUS_OPTIMIZER_TYPE, 0.0),
            (ADAFACTOR_OPTIMIZER_TYPE, 0.0),
            (CAME_OPTIMIZER_TYPE, 0.0),
            (STABLE_ADAMW_OPTIMIZER_TYPE, 0.0),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, 0.0),
            (AUTOMAGIC_OPTIMIZER_TYPE, 0.0),
            (EMOSENS_OPTIMIZER_TYPE, 0.01),
            (MUON_OPTIMIZER_TYPE, 0.0),
            (ADAN_OPTIMIZER_TYPE, 0.01),
            (ADEMAMIX_OPTIMIZER_TYPE, 0.01),
            (ADEMAMIX8BIT_OPTIMIZER_TYPE, 0.01),
            (LORARITE_OPTIMIZER_TYPE, 0.0),
        )
    ],
}

KREA2_OPTIMIZER_AUTO_VALUES: dict[str, list[dict[str, Any]]] = {
    "learning_rate": [
        {
            "watch": "optimizer_type",
            "when": selector,
            "set": value,
            "set_if_default": True,
        }
        for selector, value in (
            ("bitsandbytes.optim.Lion8bit", "1e-4"),
            ("bitsandbytes.optim.PagedLion8bit", "1e-4"),
            ("pytorch_optimizer.Lion", "1e-4"),
            (CAME_OPTIMIZER_TYPE, "2e-4"),
            (KREA2_PRODIGY_OPTIMIZER_TYPE, "1.0"),
            (KREA2_PRODIGYPLUS_OPTIMIZER_TYPE, "1.0"),
            (KREA2_SCHEDULEFREE_OPTIMIZER_TYPE, "0.0025"),
        )
    ]
}
