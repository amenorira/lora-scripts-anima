"""No-op scheduler that reports Automagic's internally adapted LR."""
from __future__ import annotations

from typing import Any


class AutomagicPassthrough:
    """Leave optimizer LR state untouched while exposing it to trainer logs."""

    def __init__(self, optimizer: Any):
        self.optimizer = optimizer
        self._step_count = 0

    def step(self, *args: Any, **kwargs: Any) -> None:
        self._step_count += 1

    def get_last_lr(self) -> list[float]:
        get_learning_rates = getattr(self.optimizer, "get_learning_rates", None)
        if callable(get_learning_rates):
            return [float(value) for value in get_learning_rates()]
        return [float(group["lr"]) for group in self.optimizer.param_groups]

    def state_dict(self) -> dict[str, int]:
        return {"step_count": self._step_count}

    def load_state_dict(self, state_dict: dict[str, Any]) -> None:
        self._step_count = int(state_dict.get("step_count", 0))
