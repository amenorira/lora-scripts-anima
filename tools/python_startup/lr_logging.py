"""Optimizer-aware learning-rate reporting for sd-scripts training runs.

The trainer APIs expose a scheduler to logging code, but several optimizers
own their effective scalar learning rate. This module keeps that distinction
out of the UI and provides a small registry for optimizer-specific reporters.
"""
from __future__ import annotations

import builtins
import math
import sys
from dataclasses import dataclass
from typing import Any, Callable, Sequence


LrMatcher = Callable[[Any], bool]
LrReader = Callable[[Any], Sequence[float]]


@dataclass(frozen=True)
class LearningRateReporter:
    """Read the effective scalar LR for one optimizer implementation."""

    name: str
    matches: LrMatcher
    read: LrReader
    owns_schedule: bool = False


_REPORTERS: list[LearningRateReporter] = []
_OPTIMIZER_PATCH_FLAG = "_lora_scripts_true_lr_logging"
_NETWORK_PATCH_FLAG = "_lora_scripts_true_lr_logging"
_IMPORT_HOOK_FLAG = "_lora_scripts_true_lr_import_hook"
_PATCH_ERROR_REPORTED = False


def register_learning_rate_reporter(
    reporter: LearningRateReporter,
    *,
    prepend: bool = False,
) -> None:
    """Register a reporter; earlier reporters take precedence."""

    if any(existing.name == reporter.name for existing in _REPORTERS):
        raise ValueError(f"learning-rate reporter already registered: {reporter.name}")
    if prepend:
        _REPORTERS.insert(0, reporter)
    else:
        _REPORTERS.append(reporter)


def registered_learning_rate_reporters() -> tuple[LearningRateReporter, ...]:
    return tuple(_REPORTERS)


def _optimizer_chain(optimizer: Any):
    current = optimizer
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        nested = getattr(current, "optimizer", None)
        if nested is current:
            break
        current = nested


def _optimizer_names(optimizer: Any) -> tuple[str, str]:
    cls = type(optimizer)
    return cls.__name__.lower(), f"{cls.__module__}.{cls.__qualname__}".lower()


def _named(*names: str) -> LrMatcher:
    normalized = {name.lower() for name in names}

    def matches(optimizer: Any) -> bool:
        simple, qualified = _optimizer_names(optimizer)
        return simple in normalized or qualified in normalized

    return matches


def _name_starts_with(*prefixes: str) -> LrMatcher:
    normalized = tuple(prefix.lower() for prefix in prefixes)

    def matches(optimizer: Any) -> bool:
        simple, _ = _optimizer_names(optimizer)
        return simple.startswith(normalized)

    return matches


def _name_ends_with(*suffixes: str) -> LrMatcher:
    normalized = tuple(suffix.lower() for suffix in suffixes)

    def matches(optimizer: Any) -> bool:
        simple, _ = _optimizer_names(optimizer)
        return simple.endswith(normalized)

    return matches


def _read_param_groups(optimizer: Any) -> list[float]:
    return [group["lr"] for group in optimizer.param_groups]


def _read_public_method(optimizer: Any) -> list[float]:
    return list(optimizer.get_learning_rates())


def _read_schedule_free(optimizer: Any) -> list[float]:
    return [group.get("scheduled_lr", group["lr"]) for group in optimizer.param_groups]


def _read_prodigy_plus(optimizer: Any) -> list[float]:
    return [optimizer.get_dlr(group) for group in optimizer.param_groups]


def _read_prodigy(optimizer: Any) -> list[float]:
    values: list[float] = []
    for group in optimizer.param_groups:
        value = group["d"] * group["lr"]
        if group.get("use_bias_correction"):
            beta1, beta2 = group["betas"]
            step = max(int(group.get("k", 0)), 1)
            value *= math.sqrt(1.0 - beta2**step) / (1.0 - beta1**step)
        values.append(value)
    return values


def _read_d_adaptation(optimizer: Any) -> list[float]:
    values: list[float] = []
    for group in optimizer.param_groups:
        lr = group.get("effective_lr", group["lr"])
        value = group["d"] * lr

        if group.get("use_bias_correction"):
            beta1, beta2 = group["betas"]
            step = int(group.get("k", 0)) + 1
            value *= math.sqrt(1.0 - beta2**step) / (1.0 - beta1**step)
        values.append(value)
    return values


def _read_adafactor(optimizer: Any) -> list[float]:
    values: list[float] = []
    for group in optimizer.param_groups:
        value = None
        for parameter in group["params"]:
            state = optimizer.state.get(parameter, {})
            if "step" in state and "RMS" in state:
                # Adafactor may have a per-tensor LR. TensorBoard has one scalar
                # per group, so use the same representative tensor as HF's
                # AdafactorSchedule while still working after zero_grad().
                value = optimizer._get_lr(group, state)
                break
        if value is None:
            value = group.get("lr")
        values.append(value)
    return values


def _has_public_reader(optimizer: Any) -> bool:
    return callable(getattr(optimizer, "get_learning_rates", None))


def _resolve_reporter(optimizer: Any) -> tuple[Any, LearningRateReporter | None]:
    for candidate in _optimizer_chain(optimizer):
        for reporter in _REPORTERS:
            if reporter.matches(candidate):
                return candidate, reporter
    return optimizer, None


def optimizer_from_scheduler(scheduler: Any) -> Any | None:
    """Find the optimizer behind plain, dummy, or Accelerate schedulers."""

    if scheduler is None:
        return None
    optimizers = getattr(scheduler, "optimizers", None)
    if optimizers:
        return optimizers[-1]
    optimizer = getattr(scheduler, "optimizer", None)
    if optimizer is not None:
        return optimizer
    inner = getattr(scheduler, "scheduler", None)
    if inner is not None and inner is not scheduler:
        return optimizer_from_scheduler(inner)
    return None


def _finite_floats(values: Sequence[Any]) -> list[float]:
    result: list[float] = []
    for value in values:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"non-finite learning rate: {number}")
        result.append(number)
    if not result:
        raise ValueError("optimizer returned no learning rates")
    return result


def read_learning_rates(
    optimizer: Any | None = None,
    scheduler: Any | None = None,
) -> list[float]:
    """Return effective scalar LRs, falling back to standard scheduler state."""

    if optimizer is None:
        optimizer = optimizer_from_scheduler(scheduler)
    if optimizer is not None:
        candidate, reporter = _resolve_reporter(optimizer)
        if reporter is not None:
            try:
                return _finite_floats(reporter.read(candidate))
            except Exception:
                # LR reporting is observational and must never abort training.
                pass

        for candidate in _optimizer_chain(optimizer):
            groups = getattr(candidate, "param_groups", None)
            if groups:
                try:
                    return _finite_floats([group["lr"] for group in groups])
                except Exception:
                    continue

    if scheduler is not None:
        try:
            return _finite_floats(scheduler.get_last_lr())
        except Exception:
            pass
    return []


def optimizer_owns_schedule(optimizer: Any) -> bool:
    _, reporter = _resolve_reporter(optimizer)
    return bool(reporter and reporter.owns_schedule)


class EffectiveLrNoOpScheduler:
    """No-op scheduler that reports the optimizer's effective learning rate."""

    def __init__(self, optimizer: Any):
        self.optimizer = optimizer

    def step(self, *args: Any, **kwargs: Any) -> None:
        return None

    def get_last_lr(self) -> list[float]:
        return read_learning_rates(optimizer=self.optimizer)

    def state_dict(self) -> dict[str, Any]:
        return {}

    def load_state_dict(self, state_dict: dict[str, Any]) -> None:
        return None


def _append_d_adaptation_diagnostics(
    logs: dict[str, Any],
    optimizer: Any | None,
    names: Sequence[str],
) -> None:
    if optimizer is None:
        return
    candidate, reporter = _resolve_reporter(optimizer)
    if reporter is None or reporter.name not in {"d-adaptation", "prodigy", "prodigy-plus"}:
        return

    for name, group in zip(names, candidate.param_groups):
        try:
            logs[f"lr/d*lr/{name}"] = float(group["d"] * group["lr"])
            if "effective_lr" in group:
                logs[f"lr/d*eff_lr/{name}"] = float(group["d"] * group["effective_lr"])
        except (KeyError, TypeError, ValueError):
            continue


def _patch_optimizer_module(module: Any) -> None:
    if getattr(module, _OPTIMIZER_PATCH_FLAG, False):
        return
    if not callable(getattr(module, "get_scheduler_fix", None)):
        return

    original_get_scheduler_fix = module.get_scheduler_fix

    def get_scheduler_fix(args: Any, optimizer: Any, num_processes: int):
        if optimizer_owns_schedule(optimizer):
            return EffectiveLrNoOpScheduler(optimizer)
        return original_get_scheduler_fix(args, optimizer, num_processes)

    def append_lr_to_logs_with_names(
        logs: dict[str, Any],
        lr_scheduler: Any,
        optimizer_type: str,
        names: Sequence[str],
    ) -> None:
        optimizer = optimizer_from_scheduler(lr_scheduler)
        learning_rates = read_learning_rates(optimizer=optimizer, scheduler=lr_scheduler)
        for name, learning_rate in zip(names, learning_rates):
            logs[f"lr/{name}"] = learning_rate
        _append_d_adaptation_diagnostics(logs, optimizer, names)

    get_scheduler_fix.__wrapped__ = original_get_scheduler_fix
    module.get_scheduler_fix = get_scheduler_fix
    if callable(getattr(module, "append_lr_to_logs_with_names", None)):
        module.append_lr_to_logs_with_names = append_lr_to_logs_with_names
    setattr(module, _OPTIMIZER_PATCH_FLAG, True)


def _patch_network_trainer_module(module: Any) -> None:
    trainer_class = getattr(module, "NetworkTrainer", None)
    if trainer_class is None or getattr(trainer_class, _NETWORK_PATCH_FLAG, False):
        return

    original_generate_step_logs = trainer_class.generate_step_logs

    def generate_step_logs(self: Any, *args: Any, **kwargs: Any):
        logs = original_generate_step_logs(self, *args, **kwargs)
        lr_scheduler = kwargs.get("lr_scheduler")
        if lr_scheduler is None and len(args) > 3:
            lr_scheduler = args[3]
        if lr_scheduler is None:
            return logs

        optimizer = kwargs.get("optimizer")
        if optimizer is None and len(args) > 5:
            optimizer = args[5]
        learning_rates = read_learning_rates(optimizer=optimizer, scheduler=lr_scheduler)
        primary_keys = [
            key
            for key in logs
            if key.startswith("lr/") and not key.startswith("lr/d*")
        ]
        for key, learning_rate in zip(primary_keys, learning_rates):
            logs[key] = learning_rate
        return logs

    generate_step_logs.__wrapped__ = original_generate_step_logs
    trainer_class.generate_step_logs = generate_step_logs
    setattr(trainer_class, _NETWORK_PATCH_FLAG, True)


def _patch_loaded_modules() -> None:
    optimizer_module = sys.modules.get("library.optimizer")
    if optimizer_module is not None:
        _patch_optimizer_module(optimizer_module)
    network_module = sys.modules.get("train_network")
    if network_module is not None:
        _patch_network_trainer_module(network_module)


def install_import_hook() -> None:
    """Patch sd-scripts modules after their normal imports complete."""

    _patch_loaded_modules()
    if getattr(builtins, _IMPORT_HOOK_FLAG, False):
        return

    original_import = builtins.__import__

    def import_with_lr_logging(*args: Any, **kwargs: Any):
        global _PATCH_ERROR_REPORTED
        imported = original_import(*args, **kwargs)
        try:
            _patch_loaded_modules()
        except Exception as exc:  # pragma: no cover - defensive startup fallback
            if not _PATCH_ERROR_REPORTED:
                print(f"warning: failed to install true-LR logging / 真实学习率日志注入失败: {exc}", file=sys.stderr)
                _PATCH_ERROR_REPORTED = True
        return imported

    import_with_lr_logging.__wrapped__ = original_import
    builtins.__import__ = import_with_lr_logging
    setattr(builtins, _IMPORT_HOOK_FLAG, True)


register_learning_rate_reporter(
    LearningRateReporter(
        "automagic",
        _named("Automagic3", "vendor.automagic_optimizer.integration.Automagic3"),
        _read_public_method,
        owns_schedule=True,
    )
)
register_learning_rate_reporter(
    LearningRateReporter(
        "emosens",
        _named("EmoSens", "vendor.emo_optimizer.emosens.EmoSens"),
        _read_param_groups,
        owns_schedule=True,
    )
)
register_learning_rate_reporter(
    LearningRateReporter(
        "prodigy-plus",
        _named("ProdigyPlusScheduleFree", "prodigyplus.ProdigyPlusScheduleFree"),
        _read_prodigy_plus,
        owns_schedule=True,
    )
)
register_learning_rate_reporter(
    LearningRateReporter(
        "schedule-free",
        _name_ends_with("ScheduleFree"),
        _read_schedule_free,
        owns_schedule=True,
    )
)
register_learning_rate_reporter(
    LearningRateReporter(
        "prodigy",
        _named("Prodigy", "prodigyopt.prodigy.Prodigy"),
        _read_prodigy,
    )
)
register_learning_rate_reporter(
    LearningRateReporter(
        "d-adaptation",
        _name_starts_with("DAdapt"),
        _read_d_adaptation,
    )
)
register_learning_rate_reporter(
    LearningRateReporter("adafactor", _named("Adafactor"), _read_adafactor)
)
register_learning_rate_reporter(
    LearningRateReporter("public-method", _has_public_reader, _read_public_method)
)


__all__ = [
    "EffectiveLrNoOpScheduler",
    "LearningRateReporter",
    "install_import_hook",
    "optimizer_from_scheduler",
    "optimizer_owns_schedule",
    "read_learning_rates",
    "register_learning_rate_reporter",
    "registered_learning_rate_reporters",
]
