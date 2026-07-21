"""
EmoPulse Scheduler — loss-driven dynamic LR for any optimizer.

Source: https://github.com/muooon/EmoSens v3.9.1

Two modes:
  - Paired with EmoSens optimizer: pass-through (EmoSens already computes emoPulse
    internally and writes param_groups['lr']; this scheduler does not overwrite it).
  - Paired with any other optimizer (AdamW, etc.): computes emoPulse from loss,
    updates param_groups['lr'] every step.

Usage in TOML:
    lr_scheduler_type = "vendor.emo_optimizer.emopulse_scheduler.EmoPulse"
    lr_scheduler_args = ["stopcoef=0.04"]
"""
import math
import torch

from ._console import safe_print


# ── ECC (emo closure capture) — safely install once ──────────────────────
if not hasattr(torch.optim.Optimizer, "_manual_loss"):
    torch.optim.Optimizer._manual_loss = 0.0

    _old_backward = torch.Tensor.backward

    def _new_backward(self, *args, **kwargs):
        if self.ndim == 0:
            try:
                torch.optim.Optimizer._manual_loss = self.item()
            except Exception:
                pass
        return _old_backward(self, *args, **kwargs)

    torch.Tensor.backward = _new_backward


class EmoPulse:
    """Dynamic LR scheduler powered by emoPulse — emotion-driven loss-to-LR mapping.

    When paired with EmoSens optimizer: acts as a transparent pass-through
    (EmoSens already computes emoPulse and writes group['lr']).

    When paired with any other optimizer: computes emoPulse from loss
    autonomously and updates group['lr'] each step.
    """

    def __init__(self, optimizer, base_lr=1.0, stopcoef=0.04, notify: bool = True):
        self.optimizer = optimizer
        self._init_lr = base_lr
        self.notify = notify
        self.should_stop = False
        self.stopcoef = stopcoef
        self.emoScope = base_lr

        # Detect EmoSens: already computes emoPulse internally → pass-through
        self._is_emosens = "EmoSens" in type(optimizer).__name__

        # emoPulse core parameters (matched to EmoSens v3.9.x)
        self.base_scale, self.max_lim, self.min_lim = 1e-4, 3e-3, 1e-8
        self.dNR_hist, self.noise_est, self.d_est, self.c_est = 1.0, 1.0, 0.02, 0.0
        self.state = {}

    # ── state dict (for resume) ─────────────────────────────────────────
    def state_dict(self):
        return {
            "emo_internal": {
                "emoScope": self.emoScope,
                "dNR_hist": self.dNR_hist,
                "noise_est": self.noise_est,
                "d_est": self.d_est,
                "c_est": self.c_est,
                "should_stop": self.should_stop,
                "stopcoef": self.stopcoef,
            },
            "scheduler_state": self.state,
        }

    def load_state_dict(self, state_dict):
        emo_internal = state_dict.get("emo_internal", None)
        if emo_internal:
            self.emoScope = emo_internal.get("emoScope", self._init_lr)
            self.dNR_hist = emo_internal.get("dNR_hist", 1.0)
            self.noise_est = emo_internal.get("noise_est", 1.0)
            self.d_est = emo_internal.get("d_est", 0.02)
            self.c_est = emo_internal.get("c_est", 0.0)
            self.should_stop = emo_internal.get("should_stop", False)
            self.stopcoef = emo_internal.get("stopcoef", self.stopcoef)
        self.state = state_dict.get("scheduler_state", {})

    # ── logging ─────────────────────────────────────────────────────────
    def get_last_lr(self):
        """Return current LR from optimizer param_groups (for TensorBoard)."""
        return [group["lr"] for group in self.optimizer.param_groups]

    # ── emoPulse internals ──────────────────────────────────────────────
    def _update_ema(self, loss_val):
        ema = self.state.setdefault("ema", {})
        ema["short"] = 0.3 * loss_val + 0.7 * ema.get("short", loss_val)
        ema["medium"] = 0.05 * loss_val + 0.95 * ema.get("medium", loss_val)
        ema["long"] = 0.01 * loss_val + 0.99 * ema.get("long", loss_val)
        return ema

    def _compute_scalar(self, ema):
        scale_base_l = max(ema["long"], 1e-5)
        scale_base_m = max(ema["medium"], 1e-5)
        diff_base = ema["long"] - ema["short"]
        diff_l = diff_base / scale_base_l
        diff_m = diff_base / scale_base_m

        if abs(diff_l) < 0.05:
            res_scalar = math.tanh(diff_l)
        elif abs(diff_m) * scale_base_m < abs(diff_l) * scale_base_l:
            res_scalar = math.tanh(diff_m)
        else:
            res_scalar = math.tanh(diff_l)

        return res_scalar, scale_base_m

    def _compute_emopulse(self, loss_val):
        """Core emoPulse: loss → dynamic LR."""
        ema = self._update_ema(loss_val)
        scalar, scale_base_m = self._compute_scalar(ema)
        trust = math.copysign((1.0 - abs(scalar)), scalar)

        self.noise_est = 0.97 * self.noise_est + 0.03 * abs(scalar)
        self.d_est = 0.97 * self.d_est + 0.03 * abs(trust)
        self.c_est = 0.7 * self.c_est + 0.3 * scalar
        noise = max(self.noise_est, 1e-10)
        d = self.d_est

        Noise_base = abs(scalar - trust) + 0.1
        d_base = abs(noise - d) + 0.1
        dNR_now_val = (d_base / Noise_base) ** 2

        if dNR_now_val >= self.dNR_hist and trust >= 0.5:
            self.dNR_hist = min(dNR_now_val, self.dNR_hist * 1.50)
        elif -0.5 <= trust <= 0.5:
            self.dNR_hist = dNR_now_val * 0.80

        emoChain = self.emoScope * max((100.0 ** self.c_est), 1e-3)
        emoPulse = float(
            max(min(self.dNR_hist * (emoChain * self.base_scale),
                    self.emoScope * self.max_lim), self.min_lim)
        )

        # Early-stop signal
        self.stop_base = self.d_est - self.noise_est
        if self.stop_base >= 0.3 and scale_base_m <= self.stopcoef:
            self.should_stop = True
            if self.notify:
                safe_print("✨[READY TO STOP]✨")
        else:
            self.should_stop = False

        return emoPulse

    # ── step (called by training loop after optimizer.step()) ────────────
    def step(self, loss_val=None):
        """Update LR for the next step.

        - EmoSens optimizer: pass-through (optimizer already set group['lr'] = emoPulse).
        - Other optimizers: compute emoPulse from loss and set group['lr'].
        """
        if self._is_emosens:
            # EmoSens already computed emoPulse and wrote group['lr'].
            # Don't overwrite — just return current value for logging.
            return self.get_last_lr()[0] if self.get_last_lr() else self.emoScope

        # Non-emo optimizer: full emoPulse computation
        if loss_val is None:
            loss_val = getattr(torch.optim.Optimizer, "_manual_loss", 0.0)

        emoPulse = self._compute_emopulse(loss_val)

        for group in self.optimizer.param_groups:
            group["lr"] = emoPulse

        return emoPulse
