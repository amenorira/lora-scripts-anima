"""LoRA-Muon: Spectral Steepest Descent on the Low-Rank Manifold.

Reference: Cesista, Crowson, Simal, Biderman, arXiv:2606.12921v1.
https://arxiv.org/abs/2606.12921

This version keeps the LoRA-Muon update rule from Algorithm 1 / Appendix B,
and exposes a normal ``torch.optim.Optimizer`` constructor so it can be used
through sd-scripts' generic ``module.Class`` optimizer loader::

    --optimizer_type=vendor.lora_muon.LoRA_Muon
    --learning_rate=0.1
    --optimizer_args "momentum=0.9" "ns_steps=8"

No modification to sd-scripts' training loop is required.  The optimizer
accepts the ordinary parameter-group dictionaries returned by
``network.prepare_optimizer_params(...)``.

``trainable_params`` may be either:
  * a flat list/iterable of LoRA parameters, or
  * the list of parameter-group dictionaries returned by sd-scripts.

For normal sd-scripts LoRA modules, parameters are registered in the usual
``lora_down`` then ``lora_up`` order.  Consecutive compatible Linear (2-D) or
Conv2d (4-D, with a 1x1 ``lora_up`` kernel) parameters are paired
automatically, with the mathematical convention

    A = lora_up.weight      [out, rank]
    B = lora_down.weight    [rank, in]

Internally the paper's B is therefore ``B.T`` relative to the stored
``lora_down.weight`` tensor. No transposed Parameter/view is registered with
PyTorch; the original Parameters remain optimizer-owned, so state_dict,
Accelerate and LR schedulers work normally.

The optimizer is intentionally specialized for LoRA factor pairs. It rejects
non-paired trainable parameters rather than silently applying ordinary Muon or
Adam-style updates to them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple, Union

import torch
from torch import Tensor
from torch.optim import Optimizer


# Appendix B.3, Table 1: Polar Express matrix-sign coefficients.
MSIGN_COEFFICIENTS: Tuple[Tuple[float, float, float], ...] = (
    (7.2086, -15.5131, 9.0178),
    (3.9623, -2.5813, 0.4542),
    (3.9466, -2.5765, 0.4544),
    (3.8991, -2.5671, 0.4566),
    (3.7186, -2.5308, 0.4653),
    (3.1390, -2.3073, 0.4733),
    (2.1715, -1.5246, 0.3885),
    (1.8648, -1.2224, 0.3577),
)

# Appendix B.4, Table 2: inverse-square-root coefficients.
INV_SQRT_COEFFICIENTS: Tuple[Tuple[float, float, float], ...] = (
    (7.424865680309214, -18.39581635618996, 12.896720413604342),
    (3.4877256051546017, -2.3300436563986993, 0.4404692168431095),
    (2.7766085124882527, -2.070643152532662, 0.46302261050004967),
    (1.9913142104341506, -1.373936700681269, 0.3875934979568538),
    (1.8754637749479246, -1.2505152090010534, 0.37505152463617264),
    (1.874999066623701, -1.2499981332141676, 0.37499906659046633),
    (1.875, -1.25, 0.375),
)


@dataclass(frozen=True)
class LoRAPair:
    """Logical LoRA factor pair in the paper's matrix convention.

    A has shape [out, rank], B has shape [in, rank].
    For sd-scripts' stored parameters, B is represented by
    ``lora_down.weight.T`` while the actual optimizer-owned Parameter remains
    the original [rank, in] tensor.
    """

    A: Tensor
    B: Tensor

    def validate(self) -> None:
        if not isinstance(self.A, torch.Tensor) or not isinstance(self.B, torch.Tensor):
            raise TypeError("LoRAPair expects torch.Tensor objects for A and B")
        if not self.A.requires_grad or not self.B.requires_grad:
            raise ValueError("Both LoRA factors must have requires_grad=True")
        if self.A.ndim != 2 or self.B.ndim != 2:
            raise ValueError(
                f"LoRA-Muon currently requires 2-D factors; got A.ndim={self.A.ndim}, "
                f"B.ndim={self.B.ndim}"
            )
        if self.A.shape[1] != self.B.shape[1]:
            raise ValueError(
                f"A and B must have the same rank; got A.shape={tuple(self.A.shape)}, "
                f"B.shape={tuple(self.B.shape)}"
            )
        if self.A.device != self.B.device:
            raise ValueError("A and B must live on the same device")
        if self.A.dtype != self.B.dtype:
            raise ValueError("A and B must have the same dtype")
        if not self.A.is_floating_point() or not self.B.is_floating_point():
            raise ValueError("A and B must be floating-point tensors")


@dataclass(frozen=True)
class _StoredPair:
    """Pair of actual optimizer Parameters.

    ``up`` is mathematical A [out, rank]. ``down`` is stored B^T [rank, in].
    """

    up: Tensor
    down: Tensor

    @property
    def paper_pair(self) -> LoRAPair:
        if self.up.ndim == 4:
            A = self.up.reshape(self.up.shape[0], self.up.shape[1])
            B = self.down.reshape(self.down.shape[0], -1).transpose(0, 1).contiguous()
        else:
            A = self.up
            B = self.down.transpose(0, 1)
        return LoRAPair(A, B)

    def validate(self) -> None:
        is_linear = self.up.ndim == 2 and self.down.ndim == 2
        is_conv = (
            self.up.ndim == 4
            and self.down.ndim == 4
            and self.up.shape[2:] == (1, 1)
        )
        if not (is_linear or is_conv):
            raise ValueError(
                "LoRA-Muon supports either 2-D Linear or Anima Conv2d factors "
                "(down=[rank,in,kH,kW], up=[out,rank,1,1]); "
                f"got up={tuple(self.up.shape)}, down={tuple(self.down.shape)}"
            )
        if self.down.shape[0] != self.up.shape[1]:
            raise ValueError(
                "LoRA rank mismatch: expected lora_down.shape[0] == "
                f"lora_up.shape[1], got down={tuple(self.down.shape)}, "
                f"up={tuple(self.up.shape)}"
            )
        if self.up.device != self.down.device:
            raise ValueError("LoRA up/down weights must be on the same device")
        if self.up.dtype != self.down.dtype:
            raise ValueError("LoRA up/down weights must have the same dtype")
        if not self.up.is_floating_point() or not self.down.is_floating_point():
            raise ValueError("LoRA up/down weights must be floating-point tensors")
        if not self.up.requires_grad or not self.down.requires_grad:
            raise ValueError("Both LoRA up/down weights must have requires_grad=True")


@dataclass
class _PairStepContext:
    """Per-pair staging record used by the batched update path.

    The candidate EMA buffers are deliberately staged instead of mutating
    optimizer state during preparation.  This keeps a failed step from
    poisoning momentum state; factors are still read again during application
    so gradient/factor copies do not accumulate in the context list.
    """

    down: Tensor
    up: Tensor
    group: dict
    conv: bool
    mA: Tensor
    mB: Tensor
    SA: Tensor
    SB: Tensor
    finite_flags: Tensor
    RA: Optional[Tensor] = None
    RB: Optional[Tensor] = None


@dataclass(frozen=True)
class _FactorStepItem:
    """One paper-space factor update staged for shape-based batching."""

    parameter: Tensor
    momentum: Tensor
    right_root: Tensor
    conv: bool
    transposed_storage: bool
    label: str


def _work_dtype(t: Tensor) -> torch.dtype:
    """Use fp32 for normal training dtypes; retain fp64 for double tensors."""

    if t.dtype == torch.float64:
        return torch.float64
    return torch.float32


@torch.no_grad()
def matrix_sign_newton_schulz(
    M: Tensor,
    *,
    steps: int = 8,
    eps: float = 1e-20,
) -> Tensor:
    """Approximate msign(M) using the paper's Appendix B.3 recurrence."""

    if M.ndim != 2:
        raise ValueError(f"matrix_sign_newton_schulz expects a 2-D tensor, got {M.ndim}-D")
    if not (1 <= steps <= len(MSIGN_COEFFICIENTS)):
        raise ValueError(
            f"steps must be in [1, {len(MSIGN_COEFFICIENTS)}] for the fixed paper coefficients"
        )
    if eps < 0:
        raise ValueError("eps must be non-negative")

    transpose = M.shape[0] > M.shape[1]
    X = M.transpose(0, 1).contiguous() if transpose else M
    denominator = (torch.linalg.vector_norm(X) + eps).clamp_min(torch.finfo(X.dtype).tiny)
    X = X / denominator

    for a, b, c in MSIGN_COEFFICIENTS[:steps]:
        U = X @ X.transpose(0, 1)
        U2 = U @ U
        X = a * X + (b * U + c * U2) @ X

    return X.transpose(0, 1).contiguous() if transpose else X


@torch.no_grad()
def _matrix_sign_newton_schulz_batched(
    M: Tensor,
    *,
    steps: int = 8,
    eps: float = 1e-20,
) -> Tensor:
    """Batched form of the paper's matrix-sign recurrence.

    Every matrix in a batch has the same shape, so the scalar routine's
    orientation decision is shared while normalization remains per matrix.
    """

    if M.ndim != 3:
        raise ValueError(
            "_matrix_sign_newton_schulz_batched expects [batch, rows, cols] tensors; "
            f"got shape={tuple(M.shape)}"
        )
    if not (1 <= steps <= len(MSIGN_COEFFICIENTS)):
        raise ValueError(
            f"steps must be in [1, {len(MSIGN_COEFFICIENTS)}] for the fixed paper coefficients"
        )
    if eps < 0:
        raise ValueError("eps must be non-negative")
    if M.shape[0] == 0:
        return M.clone()

    transpose = M.shape[-2] > M.shape[-1]
    X = M.transpose(-1, -2).contiguous() if transpose else M
    denominator = (
        torch.linalg.vector_norm(X, dim=(-2, -1), keepdim=True) + eps
    ).clamp_min(torch.finfo(X.dtype).tiny)
    X = X / denominator

    for a, b, c in MSIGN_COEFFICIENTS[:steps]:
        U = X @ X.transpose(-1, -2)
        U2 = U @ U
        X = a * X + (b * U + c * U2) @ X

    return X.transpose(-1, -2).contiguous() if transpose else X


@torch.no_grad()
def _inverse_sqrt_eigh(P: Tensor, eps: float) -> Tensor:
    """Return a finite inverse square root for a PSD/singular Gram matrix.

    The paper's Newton-Schulz form assumes a well-conditioned positive
    definite input.  LoRA commonly starts with one factor exactly zero, so a
    small absolute eigenvalue floor is needed for a safe numerical fallback.
    """

    P = 0.5 * (P + P.transpose(0, 1))
    if not torch.isfinite(P).all():
        raise FloatingPointError("LoRA-Muon received a non-finite Gram matrix")

    eigenvalues, eigenvectors = torch.linalg.eigh(P)
    dtype = P.dtype
    finfo = torch.finfo(dtype)
    max_eigenvalue = eigenvalues[-1].clamp_min(0.0)
    scale = torch.maximum(
        max_eigenvalue,
        torch.ones((), dtype=dtype, device=P.device),
    )
    floor = torch.maximum(
        torch.as_tensor(float(eps), dtype=dtype, device=P.device) * scale,
        torch.as_tensor(finfo.eps, dtype=dtype, device=P.device),
    )
    negative_tolerance = floor * 10.0
    if eigenvalues[0] < -negative_tolerance:
        raise FloatingPointError(
            "LoRA-Muon Gram matrix is not positive semidefinite; "
            f"minimum eigenvalue={float(eigenvalues[0]):.3e}"
        )

    # Anima initializes lora_up to zero.  Returning the literal identity for
    # an entirely cold Gram matrix avoids turning the regularization floor
    # (typically 1e-5) into an artificial 316x inverse-root gain.
    if max_eigenvalue <= floor:
        return torch.eye(P.shape[0], dtype=dtype, device=P.device)

    inverse_eigenvalues = torch.rsqrt(eigenvalues.clamp_min(floor))
    result = (eigenvectors * inverse_eigenvalues.unsqueeze(0)) @ eigenvectors.transpose(0, 1)
    result = 0.5 * (result + result.transpose(0, 1))
    if not torch.isfinite(result).all():
        raise FloatingPointError("LoRA-Muon inverse Gram root became non-finite")
    return result


@torch.no_grad()
def inverse_sqrt_newton_schulz(
    P: Tensor,
    *,
    steps: int = 7,
    eps: float = 1e-5,
    gamma: float = 1.001,
) -> Tensor:
    """Approximate P^{-1/2} using the paper's Appendix B.4 recurrence."""

    if P.ndim != 2 or P.shape[0] != P.shape[1]:
        raise ValueError(
            "inverse_sqrt_newton_schulz expects a square 2-D tensor; "
            f"got shape={tuple(P.shape)}"
        )
    if not (1 <= steps <= len(INV_SQRT_COEFFICIENTS)):
        raise ValueError(
            f"steps must be in [1, {len(INV_SQRT_COEFFICIENTS)}] for the fixed paper coefficients"
        )
    if eps < 0:
        raise ValueError("eps must be non-negative")
    if gamma <= 0:
        raise ValueError("gamma must be positive")

    n = P.shape[0]
    if n == 0:
        return P.clone()
    dtype = P.dtype
    device = P.device
    I = torch.eye(n, device=device, dtype=dtype)

    # Gram matrices are symmetric PSD in exact arithmetic.  Inspecting their
    # small rank-by-rank spectrum lets us avoid the paper recurrence when a
    # LoRA factor is zero or nearly rank deficient (the normal path remains
    # Newton-Schulz for well-conditioned matrices).
    P = 0.5 * (P + P.transpose(0, 1))
    try:
        eigenvalues = torch.linalg.eigvalsh(P)
    except RuntimeError as exc:
        raise FloatingPointError("LoRA-Muon failed to inspect a Gram matrix") from exc
    if not torch.isfinite(eigenvalues).all():
        raise FloatingPointError("LoRA-Muon Gram eigenvalues are non-finite")

    finfo = torch.finfo(dtype)
    max_eigenvalue = eigenvalues[-1].clamp_min(0.0)
    scale = torch.maximum(
        max_eigenvalue,
        torch.ones((), dtype=dtype, device=device),
    )
    floor = torch.maximum(
        torch.as_tensor(float(eps), dtype=dtype, device=device) * scale,
        torch.as_tensor(finfo.eps, dtype=dtype, device=device),
    )
    if eigenvalues[0] <= floor:
        return _inverse_sqrt_eigh(P, eps)

    t = torch.linalg.matrix_norm(P, ord="fro")
    if not torch.isfinite(t):
        raise FloatingPointError("LoRA-Muon Gram norm is non-finite")
    # The eigenspectrum guard above handles the zero/near-zero case.  This
    # second floor prevents overflow if a malformed input slips through.
    t_safe = t.clamp_min(finfo.eps)

    Pk = P / t_safe + eps * I
    X = I.clone()

    for a, b, c in INV_SQRT_COEFFICIENTS[:steps]:
        P2 = Pk @ Pk
        W = (a / gamma) * I + (b / (gamma**3)) * Pk + (c / (gamma**5)) * P2
        W2 = W @ W
        X = X @ W
        Pkw2 = Pk @ W2
        Pk = 0.5 * (Pkw2 + Pkw2.transpose(0, 1))

    result = X * torch.rsqrt(t_safe)
    result = 0.5 * (result + result.transpose(0, 1))
    if not torch.isfinite(result).all():
        return _inverse_sqrt_eigh(P, eps)
    return result


@torch.no_grad()
def _inverse_sqrt_newton_schulz_batched(
    P: Tensor,
    *,
    steps: int = 7,
    eps: float = 1e-5,
    gamma: float = 1.001,
) -> Tensor:
    """Batched Gram inverse roots with the scalar routine's safeguards.

    The normal path remains the paper's Newton--Schulz recurrence.  Rows with
    a zero or poorly conditioned spectrum use the same scalar EIGH fallback as
    :func:`inverse_sqrt_newton_schulz`, so batching does not turn a cold-start
    LoRA factor into an artificial large inverse-root gain.
    """

    if P.ndim != 3 or P.shape[1] != P.shape[2]:
        raise ValueError(
            "_inverse_sqrt_newton_schulz_batched expects [batch, n, n] square tensors; "
            f"got shape={tuple(P.shape)}"
        )
    if not (1 <= steps <= len(INV_SQRT_COEFFICIENTS)):
        raise ValueError(
            f"steps must be in [1, {len(INV_SQRT_COEFFICIENTS)}] for the fixed paper coefficients"
        )
    if eps < 0:
        raise ValueError("eps must be non-negative")
    if gamma <= 0:
        raise ValueError("gamma must be positive")

    batch, n, _ = P.shape
    if batch == 0 or n == 0:
        return P.clone()

    dtype = P.dtype
    device = P.device
    P = 0.5 * (P + P.transpose(-1, -2))
    if not torch.isfinite(P).all():
        raise FloatingPointError("LoRA-Muon received a non-finite batched Gram matrix")
    try:
        eigenvalues = torch.linalg.eigvalsh(P)
    except RuntimeError as exc:
        raise FloatingPointError("LoRA-Muon failed to inspect a batched Gram matrix") from exc
    if not torch.isfinite(eigenvalues).all():
        raise FloatingPointError("LoRA-Muon batched Gram eigenvalues are non-finite")

    finfo = torch.finfo(dtype)
    max_eigenvalue = eigenvalues[..., -1].clamp_min(0.0)
    scale = torch.maximum(max_eigenvalue, torch.ones_like(max_eigenvalue))
    floor = torch.maximum(
        torch.as_tensor(float(eps), dtype=dtype, device=device) * scale,
        torch.full_like(max_eigenvalue, finfo.eps),
    )
    negative = eigenvalues[..., 0] < -(floor * 10.0)
    if bool(negative.any()):
        minimum = float(eigenvalues[..., 0][negative].min())
        raise FloatingPointError(
            "LoRA-Muon Gram matrix is not positive semidefinite; "
            f"minimum eigenvalue={minimum:.3e}"
        )

    singular = eigenvalues[..., 0] <= floor
    cold = max_eigenvalue <= floor
    result = torch.empty_like(P)

    # Anima initializes every lora_up factor to zero.  Handle those cold Gram
    # matrices as one cheap identity assignment instead of launching one EIGH
    # decomposition per factor during the first optimizer step.
    cold_indices = torch.nonzero(cold, as_tuple=False).flatten()
    if cold_indices.numel() > 0:
        identity = torch.eye(n, device=device, dtype=dtype)
        result[cold_indices] = identity

    # Keep well-conditioned rows on the paper recurrence and only fall back
    # for exceptional spectra.  This preserves the exact cold Gram identity
    # behavior of the scalar implementation.
    regular_indices = torch.nonzero(~singular, as_tuple=False).flatten()
    if regular_indices.numel() > 0:
        regular = P[regular_indices]
        regular_count = regular.shape[0]
        I = torch.eye(n, device=device, dtype=dtype).expand(regular_count, -1, -1)
        t = torch.linalg.matrix_norm(regular, ord="fro", dim=(-2, -1))
        if not torch.isfinite(t).all():
            raise FloatingPointError("LoRA-Muon batched Gram norm is non-finite")
        t_safe = t.clamp_min(finfo.eps)
        Pk = regular / t_safe[:, None, None] + float(eps) * I
        X = I.clone()

        for a, b, c in INV_SQRT_COEFFICIENTS[:steps]:
            P2 = Pk @ Pk
            W = (
                (a / gamma) * I
                + (b / (gamma**3)) * Pk
                + (c / (gamma**5)) * P2
            )
            W2 = W @ W
            X = X @ W
            Pkw2 = Pk @ W2
            Pk = 0.5 * (Pkw2 + Pkw2.transpose(-1, -2))

        candidates = X * torch.rsqrt(t_safe)[:, None, None]
        candidates = 0.5 * (candidates + candidates.transpose(-1, -2))
        finite_rows = torch.isfinite(candidates).all(dim=(-2, -1))
        if bool(finite_rows.any()):
            result[regular_indices[finite_rows]] = candidates[finite_rows]
        if bool((~finite_rows).any()):
            for index in regular_indices[~finite_rows].tolist():
                result[index] = _inverse_sqrt_eigh(P[index], eps)

    # Rank-deficient but non-cold rows still need the robust eigen fallback.
    # Decompose them as one batch so a mixed regular/singular bucket does not
    # fall back to hundreds of tiny Python-level EIGH calls.
    fallback_indices = torch.nonzero(singular & ~cold, as_tuple=False).flatten()
    if fallback_indices.numel() > 0:
        fallback = P[fallback_indices]
        try:
            fallback_eigenvalues, fallback_eigenvectors = torch.linalg.eigh(fallback)
        except RuntimeError as exc:
            raise FloatingPointError(
                "LoRA-Muon failed to decompose a batched Gram matrix"
            ) from exc
        fallback_floor = floor[fallback_indices]
        inverse_eigenvalues = torch.rsqrt(
            fallback_eigenvalues.clamp_min(fallback_floor[:, None])
        )
        fallback_result = (
            fallback_eigenvectors * inverse_eigenvalues.unsqueeze(-2)
        ) @ fallback_eigenvectors.transpose(-1, -2)
        fallback_result = 0.5 * (
            fallback_result + fallback_result.transpose(-1, -2)
        )
        if not torch.isfinite(fallback_result).all():
            raise FloatingPointError("LoRA-Muon inverse Gram root became non-finite")
        result[fallback_indices] = fallback_result

    return result


@torch.no_grad()
def _power_iteration_norm(M: Tensor, steps: int = 2) -> Tensor:
    """Small spectral-norm estimate used by optional gauge rebalance."""

    if M.ndim != 2:
        raise ValueError("power iteration expects a matrix")
    if steps < 1:
        raise ValueError("power iteration steps must be >= 1")

    dtype = _work_dtype(M)
    X = M.detach().to(dtype)
    if X.numel() == 0:
        return torch.zeros((), dtype=dtype, device=M.device)

    if X.shape[0] >= X.shape[1]:
        v = torch.ones(X.shape[1], dtype=dtype, device=X.device)
        tiny = torch.finfo(dtype).tiny
        v = v / torch.linalg.vector_norm(v).clamp_min(tiny)
        for _ in range(steps):
            v = X.transpose(0, 1) @ (X @ v)
            v = v / torch.linalg.vector_norm(v).clamp_min(tiny)
        return torch.linalg.vector_norm(X @ v)

    u = torch.ones(X.shape[0], dtype=dtype, device=X.device)
    tiny = torch.finfo(dtype).tiny
    u = u / torch.linalg.vector_norm(u).clamp_min(tiny)
    for _ in range(steps):
        u = X @ (X.transpose(0, 1) @ u)
        u = u / torch.linalg.vector_norm(u).clamp_min(tiny)
    return torch.linalg.vector_norm(X.transpose(0, 1) @ u)


ParamInput = Union[Iterable[Tensor], Sequence[dict]]

_GAUGE_MIN_FACTOR = 1e-2
_GAUGE_MAX_FACTOR = 1e2
_MSIGN_BATCH_WORKSPACE_BYTES = 64 * 2**20
_MSIGN_BATCH_MATRIX_COPIES = 8


class LoRAMuon(Optimizer):
    """LoRA-Muon with a standard ``torch.optim`` / sd-scripts interface.

    Parameters
    ----------
    params:
        Standard PyTorch optimizer input. In sd-scripts this is normally the
        ``trainable_params`` returned by ``network.prepare_optimizer_params``.
        Each parameter group must contain ordinary Linear (2-D) or Anima
        Conv2d (4-D) LoRA down/up Parameters. Consecutive compatible parameters are paired as
        ``down -> up``. The stored tensors remain untouched; only the math uses
        the paper's transposed B convention.

        The optimizer accepts ordinary tensor lists and parameter-group
        dictionaries.  Logical paper-space pairs must be represented by the
        stored ``lora_down``/``lora_up`` tensors in those groups; transposed
        pair tuples are intentionally not registered as optimizer parameters.

    lr:
        Learning rate / total spectral trust-region radius. Paper reference
        experiments used 0.1 as ``lr_linear``; this is not a claim of an
        optimal Anima value.
    momentum:
        EMA coefficient beta for first moments.
    weight_decay:
        Split decoupled weight decay coefficient lambda.
    ns_steps:
        Polar-Express Newton-Schulz steps for matrix sign.
    inv_sqrt_steps:
        Newton-Schulz steps for Gram inverse square root.
    msign_eps:
        Frobenius-normalization epsilon for matrix sign.
    inv_sqrt_eps:
        Diagonal regularization epsilon for Gram inverse square root.
    inv_sqrt_gamma:
        Damping scale gamma for the inverse square root iteration.
    gauge_rebalance:
        Optional scalar gauge conditioning from Appendix B.1/B.2.
    gauge_rebalance_alpha:
        Damping exponent alpha in (0, 1].
    gauge_rebalance_interval:
        Apply gauge rebalancing every N optimizer steps.
    gauge_power_steps:
        Power-iteration steps for the spectral norm estimate used by gauge
        rebalancing.
    """

    def __init__(
        self,
        params: ParamInput,
        lr: float = 0.1,
        momentum: float = 0.9,
        weight_decay: float = 0.0,
        ns_steps: int = 8,
        inv_sqrt_steps: int = 7,
        msign_eps: float = 1e-20,
        inv_sqrt_eps: float = 1e-5,
        inv_sqrt_gamma: float = 1.001,
        gauge_rebalance: bool = False,
        gauge_rebalance_alpha: float = 1.0,
        gauge_rebalance_interval: int = 1,
        gauge_power_steps: int = 2,
    ) -> None:
        self._validate_hyperparameters(
            lr=lr,
            momentum=momentum,
            weight_decay=weight_decay,
            ns_steps=ns_steps,
            inv_sqrt_steps=inv_sqrt_steps,
            msign_eps=msign_eps,
            inv_sqrt_eps=inv_sqrt_eps,
            inv_sqrt_gamma=inv_sqrt_gamma,
            gauge_rebalance_alpha=gauge_rebalance_alpha,
            gauge_rebalance_interval=gauge_rebalance_interval,
            gauge_power_steps=gauge_power_steps,
            context="global optimizer options",
        )

        groups = self._normalize_param_groups(params, default_lr=lr)

        defaults = dict(
            lr=lr,
            momentum=momentum,
            weight_decay=weight_decay,
            ns_steps=ns_steps,
            inv_sqrt_steps=inv_sqrt_steps,
            msign_eps=msign_eps,
            inv_sqrt_eps=inv_sqrt_eps,
            inv_sqrt_gamma=inv_sqrt_gamma,
            gauge_rebalance=gauge_rebalance,
            gauge_rebalance_alpha=gauge_rebalance_alpha,
            gauge_rebalance_interval=gauge_rebalance_interval,
            gauge_power_steps=gauge_power_steps,
        )

        # Validate and attach pair metadata before the optimizer owns the groups.
        # sd-scripts passes ordinary parameter groups here.  For standard LoRA,
        # each LoRAModule registers lora_down before lora_up, so the parameter
        # order inside a group is down -> up -> down -> up ... .
        for group_idx, group in enumerate(groups):
            try:
                pair_indices = self._infer_group_pairs(group["params"])
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"LoRA-Muon cannot use sd-scripts parameter group {group_idx}: {exc}"
                ) from exc
            if not pair_indices:
                raise ValueError(
                    f"LoRA-Muon parameter group {group_idx} contains no complete LoRA factor pair"
                )
            group["pair_indices"] = tuple(pair_indices)

            group_lr = float(group.get("lr", lr))
            group_decay = float(group.get("weight_decay", weight_decay))
            self._validate_hyperparameters(
                lr=group_lr,
                momentum=group.get("momentum", momentum),
                weight_decay=group_decay,
                ns_steps=group.get("ns_steps", ns_steps),
                inv_sqrt_steps=group.get("inv_sqrt_steps", inv_sqrt_steps),
                msign_eps=group.get("msign_eps", msign_eps),
                inv_sqrt_eps=group.get("inv_sqrt_eps", inv_sqrt_eps),
                inv_sqrt_gamma=group.get("inv_sqrt_gamma", inv_sqrt_gamma),
                gauge_rebalance_alpha=group.get(
                    "gauge_rebalance_alpha", gauge_rebalance_alpha
                ),
                gauge_rebalance_interval=group.get(
                    "gauge_rebalance_interval", gauge_rebalance_interval
                ),
                gauge_power_steps=group.get("gauge_power_steps", gauge_power_steps),
                context=f"parameter group {group_idx}",
            )

        super().__init__(groups, defaults)

    @staticmethod
    def _validate_hyperparameters(
        *,
        lr: float,
        momentum: float,
        weight_decay: float,
        ns_steps: int,
        inv_sqrt_steps: int,
        msign_eps: float,
        inv_sqrt_eps: float,
        inv_sqrt_gamma: float,
        gauge_rebalance_alpha: float,
        gauge_rebalance_interval: int,
        gauge_power_steps: int,
        context: str,
    ) -> None:
        try:
            lr_value = float(lr)
            momentum_value = float(momentum)
            decay_value = float(weight_decay)
            msign_eps_value = float(msign_eps)
            inv_sqrt_eps_value = float(inv_sqrt_eps)
            gamma_value = float(inv_sqrt_gamma)
            alpha_value = float(gauge_rebalance_alpha)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"{context}: numeric optimizer option is invalid") from exc

        if not math.isfinite(lr_value) or lr_value < 0.0:
            raise ValueError(f"{context}: lr must be finite and non-negative")
        if not math.isfinite(decay_value) or decay_value < 0.0:
            raise ValueError(f"{context}: weight_decay must be finite and non-negative")
        if not 0.0 <= momentum_value < 1.0:
            raise ValueError(f"{context}: momentum must satisfy 0 <= momentum < 1")
        if not math.isfinite(msign_eps_value) or msign_eps_value < 0.0:
            raise ValueError(f"{context}: msign_eps must be finite and non-negative")
        if not math.isfinite(inv_sqrt_eps_value) or inv_sqrt_eps_value < 0.0:
            raise ValueError(
                f"{context}: inv_sqrt_eps must be finite and non-negative"
            )
        if not math.isfinite(gamma_value) or gamma_value <= 0.0:
            raise ValueError(f"{context}: inv_sqrt_gamma must be finite and positive")
        if not 0.0 < alpha_value <= 1.0:
            raise ValueError(f"{context}: gauge_rebalance_alpha must be in (0, 1]")

        def as_integer(value: object, name: str) -> int:
            if isinstance(value, bool):
                raise ValueError(f"{context}: {name} must be an integer")
            try:
                numeric = float(value)
                parsed = int(value)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError(f"{context}: {name} must be an integer") from exc
            if not math.isfinite(numeric) or numeric != parsed:
                raise ValueError(f"{context}: {name} must be an integer")
            return parsed

        ns_steps_value = as_integer(ns_steps, "ns_steps")
        inv_sqrt_steps_value = as_integer(inv_sqrt_steps, "inv_sqrt_steps")
        interval_value = as_integer(gauge_rebalance_interval, "gauge_rebalance_interval")
        power_steps_value = as_integer(gauge_power_steps, "gauge_power_steps")
        if not 1 <= ns_steps_value <= len(MSIGN_COEFFICIENTS):
            raise ValueError(
                f"{context}: ns_steps must be in [1, {len(MSIGN_COEFFICIENTS)}]"
            )
        if not 1 <= inv_sqrt_steps_value <= len(INV_SQRT_COEFFICIENTS):
            raise ValueError(
                f"{context}: inv_sqrt_steps must be in [1, {len(INV_SQRT_COEFFICIENTS)}]"
            )
        if interval_value < 1:
            raise ValueError(f"{context}: gauge_rebalance_interval must be >= 1")
        if power_steps_value < 1:
            raise ValueError(f"{context}: gauge_power_steps must be >= 1")
        if lr_value * decay_value >= 1.0:
            raise ValueError(
                f"{context}: split weight decay requires lr * weight_decay < 1"
            )

    @staticmethod
    def _normalize_param_groups(params: ParamInput, default_lr: float) -> List[dict]:
        """Accept ordinary PyTorch params or sd-scripts parameter-group dicts."""

        if isinstance(params, torch.Tensor):
            params = [params]

        params_list = list(params)
        if not params_list:
            raise ValueError("LoRAMuon received an empty parameter list")

        is_grouped = all(isinstance(x, dict) for x in params_list)
        if any(isinstance(x, dict) for x in params_list) and not is_grouped:
            raise TypeError("LoRAMuon params must be all tensors or all parameter-group dicts")
        if any(isinstance(x, (tuple, list)) for x in params_list):
            raise TypeError(
                "LoRAMuon does not accept transposed (A, B) pair tuples; "
                "pass stored lora_down/lora_up tensors or parameter-group dicts"
            )

        if is_grouped:
            groups: List[dict] = []
            for idx, source_group in enumerate(params_list):
                if "params" not in source_group:
                    raise KeyError(f"parameter group {idx} is missing the 'params' entry")
                group_params = list(source_group["params"])
                if not group_params:
                    continue
                group = dict(source_group)
                group["params"] = group_params
                group.setdefault("lr", default_lr)
                groups.append(group)
            if not groups:
                raise ValueError("LoRAMuon received no non-empty parameter groups")
            return groups

        if not all(isinstance(p, torch.Tensor) for p in params_list):
            raise TypeError("LoRAMuon params must contain torch.Tensor objects")
        return [{"params": params_list, "lr": default_lr}]

    @staticmethod
    def _infer_group_pairs(params: Sequence[Tensor]) -> List[Tuple[int, int]]:
        """Infer sd-scripts LoRA down/up pairs from the normal module order.

        sd-scripts' standard LoRA module registers ``lora_down`` before
        ``lora_up``.  Its optimizer parameter group therefore contains
        complete factor pairs in this order:

            down=[rank,in] / [rank,in,kH,kW], up=[out,rank] / [out,rank,1,1]

        A group containing only one factor (for example the ``plus`` group
        produced by LoRA+) cannot be reconstructed safely because sd-scripts
        passes Parameters, not their original module/name metadata, to the
        optimizer.
        """

        pairs: List[Tuple[int, int]] = []
        i = 0
        while i < len(params):
            p0 = params[i]
            if not isinstance(p0, torch.Tensor):
                raise TypeError(f"parameter {i} is not a torch.Tensor")
            if i + 1 >= len(params):
                raise ValueError(
                    "the parameter group has an unpaired final tensor. "
                    "Standard sd-scripts LoRA requires consecutive lora_down -> lora_up tensors."
                )
            p1 = params[i + 1]
            if not isinstance(p1, torch.Tensor):
                raise ValueError(
                    f"parameters at indices {i}, {i+1} cannot form a LoRA pair; "
                    "expected lora_down followed by lora_up."
                )

            down = p0
            up = p1
            pair = _StoredPair(up=up, down=down)
            pair.validate()
            pairs.append((i, i + 1))
            i += 2
        return pairs

    @staticmethod
    def _stored_pair(params: Sequence[Tensor], a_idx: int, b_idx: int) -> _StoredPair:
        # Pair metadata is stored as down index, up index for sd-scripts mode.
        pair = _StoredPair(up=params[b_idx], down=params[a_idx])
        pair.validate()
        return pair

    @property
    def lora_pairs(self) -> Tuple[LoRAPair, ...]:
        """Return all pairs in the paper's A/B convention."""

        result: List[LoRAPair] = []
        for group in self.param_groups:
            params = group["params"]
            for down_idx, up_idx in group["pair_indices"]:
                result.append(self._stored_pair(params, down_idx, up_idx).paper_pair)
        return tuple(result)

    @torch.no_grad()
    def _prepare_pair_step(
        self,
        down: Tensor,
        up: Tensor,
        group: dict,
    ) -> Optional[_PairStepContext]:
        if down.grad is None or up.grad is None:
            # A missing factor gradient means the coupled pair cannot be updated.
            return None
        if down.grad.is_sparse or up.grad.is_sparse:
            raise RuntimeError("LoRAMuon does not support sparse gradients")

        # Mathematical convention:
        #   A = up [out, r]
        #   B = down.T [in, r]
        # Conv2d factors are flattened over input channels and kernel area.
        work_dtype = _work_dtype(up)
        conv = up.ndim == 4
        if conv:
            A = up.detach().reshape(up.shape[0], up.shape[1]).to(work_dtype)
            B = down.detach().reshape(down.shape[0], -1).transpose(0, 1).contiguous().to(work_dtype)
            gA = up.grad.detach().reshape(up.shape[0], up.shape[1]).to(work_dtype)
            gB = down.grad.detach().reshape(down.shape[0], -1).transpose(0, 1).contiguous().to(work_dtype)
        else:
            A = up.detach().to(work_dtype)
            B = down.detach().transpose(0, 1).contiguous().to(work_dtype)
            gA = up.grad.detach().to(work_dtype)
            gB = down.grad.detach().transpose(0, 1).contiguous().to(work_dtype)

        state_A = self.state.get(up)
        state_B = self.state.get(down)
        previous_mA = state_A.get("momentum_buffer") if state_A else None
        previous_mB = state_B.get("momentum_buffer") if state_B else None
        for label, previous, expected in (
            ("A", previous_mA, A),
            ("B", previous_mB, B),
        ):
            if previous is not None and (
                previous.shape != expected.shape
                or previous.dtype != expected.dtype
                or previous.device != expected.device
            ):
                raise RuntimeError(
                    f"LoRA-Muon stored {label} momentum shape/dtype/device does not match "
                    "the current factor"
                )

        # Validate all source tensors before constructing a candidate EMA.  The
        # result is staged and committed only after the complete update passes.
        source_flags = torch.stack(
            [torch.isfinite(tensor).all() for tensor in (A, B, gA, gB)]
        )
        if previous_mA is None:
            mA = torch.zeros_like(A)
        else:
            mA = previous_mA.detach().clone()
        if previous_mB is None:
            mB = torch.zeros_like(B)
        else:
            mB = previous_mB.detach().clone()
        beta = float(group["momentum"])

        # Algorithm 1, line 2: EMA first moments.
        mA.mul_(beta).add_(gA, alpha=1.0 - beta)
        mB.mul_(beta).add_(gB, alpha=1.0 - beta)
        finite_flags = torch.stack(
            [
                source_flags[0],
                source_flags[1],
                source_flags[2],
                source_flags[3],
                torch.isfinite(mA).all(),
                torch.isfinite(mB).all(),
            ]
        )

        # Algorithm 1, line 3: Gram matrices.
        SA = A.transpose(0, 1) @ A
        SB = B.transpose(0, 1) @ B
        finite_flags = torch.cat(
            (finite_flags, torch.stack((torch.isfinite(SA).all(), torch.isfinite(SB).all())))
        )

        return _PairStepContext(
            down=down,
            up=up,
            group=group,
            conv=conv,
            mA=mA,
            mB=mB,
            SA=SA,
            SB=SB,
            finite_flags=finite_flags,
        )

    @staticmethod
    def _validate_prepared_contexts(contexts: Sequence[_PairStepContext]) -> None:
        if not contexts:
            return
        flags = torch.stack([context.finite_flags for context in contexts], dim=0)
        if bool(flags.all()):
            return
        pair_index, value_index = torch.nonzero(~flags, as_tuple=False)[0].tolist()
        label = (
            "A",
            "B",
            "gA",
            "gB",
            "mA",
            "mB",
            "SA",
            "SB",
        )[value_index]
        raise FloatingPointError(
            f"LoRA-Muon received non-finite {label} values in pair {pair_index}"
        )

    @staticmethod
    def _copy_checked(parameter: Tensor, value: Tensor, label: str) -> None:
        if not torch.isfinite(value).all():
            raise FloatingPointError(f"LoRA-Muon {label} update is non-finite")
        if parameter.dtype.is_floating_point:
            dtype_max = torch.finfo(parameter.dtype).max
            if value.detach().abs().max() > dtype_max:
                raise FloatingPointError(
                    f"LoRA-Muon {label} update exceeds {parameter.dtype} range"
                )
        parameter.copy_(value.to(dtype=parameter.dtype))

    @staticmethod
    def _paper_factor(item: _FactorStepItem) -> Tensor:
        parameter = item.parameter
        if item.transposed_storage:
            if item.conv:
                value = (
                    parameter.detach()
                    .reshape(parameter.shape[0], -1)
                    .transpose(0, 1)
                    .contiguous()
                )
            else:
                value = parameter.detach().transpose(0, 1).contiguous()
        elif item.conv:
            value = parameter.detach().reshape(parameter.shape[0], parameter.shape[1])
        else:
            value = parameter.detach()
        return value.to(item.momentum.dtype)

    @staticmethod
    def _stored_factor_value(item: _FactorStepItem, value: Tensor) -> Tensor:
        if item.transposed_storage:
            stored = value.transpose(0, 1)
            if item.conv:
                stored = stored.reshape_as(item.parameter)
        else:
            stored = value.reshape_as(item.parameter) if item.conv else value
        return stored

    @classmethod
    def _store_paper_factor(cls, item: _FactorStepItem, value: Tensor) -> None:
        stored = cls._stored_factor_value(item, value)
        cls._copy_checked(item.parameter, stored, item.label)

    def _commit_context_momenta(
        self, contexts: Sequence[_PairStepContext]
    ) -> None:
        """Publish staged EMA buffers after all numerical checks succeed."""

        for context in contexts:
            state_A = self.state.setdefault(context.up, {})
            state_B = self.state.setdefault(context.down, {})
            previous_A = state_A.get("momentum_buffer")
            previous_B = state_B.get("momentum_buffer")
            if previous_A is None:
                state_A["momentum_buffer"] = context.mA
            else:
                previous_A.copy_(context.mA)
            if previous_B is None:
                state_B["momentum_buffer"] = context.mB
            else:
                previous_B.copy_(context.mB)

    @staticmethod
    def _matrix_sign_chunk_size(rows: int, cols: int, dtype: torch.dtype) -> int:
        element_size = torch.empty((), dtype=dtype).element_size()
        matrix_bytes = rows * cols * element_size
        root_bytes = cols * cols * element_size
        per_item_bytes = max(
            1,
            _MSIGN_BATCH_MATRIX_COPIES * matrix_bytes + 4 * root_bytes,
        )
        return max(1, _MSIGN_BATCH_WORKSPACE_BYTES // per_item_bytes)

    @torch.no_grad()
    def _apply_pair_step(self, context: _PairStepContext) -> None:
        """Apply one prepared pair after its inverse roots are available."""

        if context.RA is None or context.RB is None:
            raise RuntimeError("LoRA-Muon pair update is missing Gram inverse roots")

        down = context.down
        up = context.up
        group = context.group
        conv = context.conv
        mA = context.mA
        mB = context.mB
        RA = context.RA
        RB = context.RB

        # Re-read the factors after root computation.  No other writer can
        # touch them between the staging and application loops, and this keeps
        # hundreds of Anima pairs from retaining duplicate fp32 factor copies.
        work_dtype = _work_dtype(up)
        if conv:
            A = up.detach().reshape(up.shape[0], up.shape[1]).to(work_dtype)
            B = down.detach().reshape(down.shape[0], -1).transpose(0, 1).contiguous().to(work_dtype)
        else:
            A = up.detach().to(work_dtype)
            B = down.detach().transpose(0, 1).contiguous().to(work_dtype)

        # Algorithm 1, lines 5-6: eta/2 trust-region split.
        eta = float(group["lr"])
        yA = mA @ RB
        yB = mB @ RA
        zA = matrix_sign_newton_schulz(
            yA,
            steps=int(group["ns_steps"]),
            eps=float(group["msign_eps"]),
        )
        zB = matrix_sign_newton_schulz(
            yB,
            steps=int(group["ns_steps"]),
            eps=float(group["msign_eps"]),
        )
        dA = -0.5 * eta * (zA @ RB)
        dB = -0.5 * eta * (zB @ RA)

        # Algorithm 1, lines 7-9: split decoupled weight decay.
        decay = float(group["weight_decay"])
        one_minus = 1.0 - eta * decay
        if one_minus <= 0.0:
            raise RuntimeError(
                "Encountered invalid split weight decay: 1 - lr * weight_decay <= 0. "
                "Reduce lr or weight_decay."
            )
        s = one_minus**0.5

        A_new = s * A + dA / s
        B_new = s * B + dB / s

        if not torch.isfinite(A_new).all() or not torch.isfinite(B_new).all():
            raise FloatingPointError(
                "LoRA-Muon produced a non-finite factor update; "
                "check rank, lr, and Gram conditioning"
            )

        # A is stored directly as lora_up.weight; B is stored transposed.
        self._copy_checked(up, A_new.reshape_as(up) if conv else A_new, "lora_up")
        down_value = B_new.transpose(0, 1)
        if conv:
            down_value = down_value.reshape_as(down)
        self._copy_checked(down, down_value, "lora_down")

    @torch.no_grad()
    def _apply_batched_pair_steps(
        self,
        contexts: Sequence[_PairStepContext],
        group: dict,
    ) -> list[tuple[_FactorStepItem, Tensor]]:
        """Apply prepared pair updates in exact-shape matrix-sign buckets."""

        items: list[_FactorStepItem] = []
        for context in contexts:
            if context.RA is None or context.RB is None:
                raise RuntimeError("LoRA-Muon pair update is missing Gram inverse roots")
            items.extend(
                (
                    _FactorStepItem(
                        parameter=context.up,
                        momentum=context.mA,
                        right_root=context.RB,
                        conv=context.conv,
                        transposed_storage=False,
                        label="lora_up",
                    ),
                    _FactorStepItem(
                        parameter=context.down,
                        momentum=context.mB,
                        right_root=context.RA,
                        conv=context.conv,
                        transposed_storage=True,
                        label="lora_down",
                    ),
                )
            )

        buckets: dict[
            tuple[torch.device, torch.dtype, torch.dtype, int, int],
            list[_FactorStepItem],
        ] = {}
        for item in items:
            rows, cols = item.momentum.shape
            key = (
                item.momentum.device,
                item.momentum.dtype,
                item.parameter.dtype,
                rows,
                cols,
            )
            buckets.setdefault(key, []).append(item)

        eta = float(group["lr"])
        decay = float(group["weight_decay"])
        one_minus = 1.0 - eta * decay
        if one_minus <= 0.0:
            raise RuntimeError(
                "Encountered invalid split weight decay: 1 - lr * weight_decay <= 0. "
                "Reduce lr or weight_decay."
            )
        scale = one_minus**0.5
        ns_steps = int(group["ns_steps"])
        msign_eps = float(group["msign_eps"])
        pending_updates: list[tuple[_FactorStepItem, Tensor]] = []

        for (_, dtype, parameter_dtype, rows, cols), bucket in buckets.items():
            chunk_size = self._matrix_sign_chunk_size(rows, cols, dtype)
            for start in range(0, len(bucket), chunk_size):
                chunk = bucket[start : start + chunk_size]
                momenta = torch.stack([item.momentum for item in chunk], dim=0)
                roots = torch.stack([item.right_root for item in chunk], dim=0)
                factors = torch.stack(
                    [self._paper_factor(item) for item in chunk], dim=0
                )
                signed = _matrix_sign_newton_schulz_batched(
                    torch.bmm(momenta, roots),
                    steps=ns_steps,
                    eps=msign_eps,
                )
                deltas = torch.bmm(signed, roots).mul_(-0.5 * eta)
                factor_updates = scale * factors + deltas / scale
                if not bool(torch.isfinite(factor_updates).all()):
                    raise FloatingPointError(
                        "LoRA-Muon produced a non-finite factor update; "
                        "check rank, lr, and Gram conditioning"
                    )
                dtype_max = torch.finfo(parameter_dtype).max
                if bool(factor_updates.detach().abs().max() > dtype_max):
                    raise FloatingPointError(
                        f"LoRA-Muon factor update exceeds {parameter_dtype} range"
                    )
                for index, item in enumerate(chunk):
                    pending_updates.append((item, factor_updates[index]))

        return pending_updates

    @torch.no_grad()
    def _step_pair(
        self,
        down: Tensor,
        up: Tensor,
        group: dict,
    ) -> None:
        """Prepare and apply one pair using the scalar root path."""

        context = self._prepare_pair_step(down, up, group)
        if context is None:
            return
        self._validate_prepared_contexts((context,))
        context.RA = inverse_sqrt_newton_schulz(
            context.SA,
            steps=int(group["inv_sqrt_steps"]),
            eps=float(group["inv_sqrt_eps"]),
            gamma=float(group["inv_sqrt_gamma"]),
        )
        context.RB = inverse_sqrt_newton_schulz(
            context.SB,
            steps=int(group["inv_sqrt_steps"]),
            eps=float(group["inv_sqrt_eps"]),
            gamma=float(group["inv_sqrt_gamma"]),
        )
        self._apply_pair_step(context)
        self._commit_context_momenta((context,))

    @staticmethod
    @torch.no_grad()
    def _assign_batched_inverse_roots(
        contexts: Sequence[_PairStepContext],
        group: dict,
    ) -> None:
        """Compute inverse roots in rank-compatible buckets within one group."""

        buckets: dict[tuple[torch.device, torch.dtype, int], list[_PairStepContext]] = {}
        for context in contexts:
            key = (
                context.SA.device,
                context.SA.dtype,
                int(context.SA.shape[0]),
            )
            buckets.setdefault(key, []).append(context)

        steps = int(group["inv_sqrt_steps"])
        eps = float(group["inv_sqrt_eps"])
        gamma = float(group["inv_sqrt_gamma"])
        for bucket in buckets.values():
            if len(bucket) == 1:
                context = bucket[0]
                context.RA = inverse_sqrt_newton_schulz(
                    context.SA, steps=steps, eps=eps, gamma=gamma
                )
                context.RB = inverse_sqrt_newton_schulz(
                    context.SB, steps=steps, eps=eps, gamma=gamma
                )
                continue

            # A and B roots have the same rank but different Gram values.  A
            # single call lets PyTorch use batched eigenspectrum/GEMM kernels.
            gram_batch = torch.stack(
                [context.SA for context in bucket]
                + [context.SB for context in bucket],
                dim=0,
            )
            roots = _inverse_sqrt_newton_schulz_batched(
                gram_batch,
                steps=steps,
                eps=eps,
                gamma=gamma,
            )
            split = len(bucket)
            for index, context in enumerate(bucket):
                context.RA = roots[index]
                context.RB = roots[split + index]

    @torch.no_grad()
    def _gauge_rebalance_pair(
        self,
        down: Tensor,
        up: Tensor,
        m_down: Tensor,
        m_up: Tensor,
        alpha: float,
        power_steps: int,
    ) -> None:
        """Appendix B.1/B.2 scalar gauge rebalancing with moment transport."""

        # Use the paper's A=up, B=down.T convention.
        conv = up.ndim == 4
        A = up.reshape(up.shape[0], up.shape[1]) if conv else up
        B = down.reshape(down.shape[0], -1).transpose(0, 1) if conv else down.transpose(0, 1)

        norm_A = _power_iteration_norm(A, steps=power_steps)
        norm_B = _power_iteration_norm(B, steps=power_steps)
        eps = torch.finfo(norm_A.dtype).eps
        if (
            not torch.isfinite(norm_A)
            or not torch.isfinite(norm_B)
            or norm_A <= eps
            or norm_B <= eps
        ):
            # A zero-initialized lora_up is expected during Anima cold start;
            # do not turn its clamped norm into a huge gauge multiplier.
            return
        c = (norm_B / norm_A).pow(0.5 * alpha)
        c = torch.nan_to_num(
            c,
            nan=1.0,
            posinf=_GAUGE_MAX_FACTOR,
            neginf=_GAUGE_MIN_FACTOR,
        ).clamp_(_GAUGE_MIN_FACTOR, _GAUGE_MAX_FACTOR)
        if not torch.isfinite(c):
            return

        A.mul_(c.to(dtype=A.dtype))
        B.mul_(c.reciprocal().to(dtype=B.dtype))

        # Factor gradients transform contragrediently under the gauge action:
        # A/up *= c, B/down.T *= c^-1, but gA/mA /= c and gB/mB *= c.
        # Keeping this opposite transport is what makes the EMA commute with
        # scalar reparameterization (paper Appendix B.2, Algorithm 2).
        m_up.mul_(c.to(dtype=m_up.dtype).reciprocal())
        m_down.mul_(c.to(dtype=m_down.dtype))

    @torch.no_grad()
    def step(self, closure=None):  # type: ignore[override]
        """Perform one LoRA-Muon optimizer step."""

        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()

        prepared_groups: list[
            tuple[dict, list[_PairStepContext], list[tuple[_FactorStepItem, Tensor]]]
        ] = []
        for group in self.param_groups:
            params = group["params"]
            contexts: List[_PairStepContext] = []
            for down_idx, up_idx in group["pair_indices"]:
                context = self._prepare_pair_step(
                    params[down_idx], params[up_idx], group
                )
                if context is not None:
                    contexts.append(context)

            self._validate_prepared_contexts(contexts)
            self._assign_batched_inverse_roots(contexts, group)
            pending_updates = self._apply_batched_pair_steps(contexts, group)
            prepared_groups.append((group, contexts, pending_updates))

        # All groups are numerically validated before publishing either factors
        # or momentum state, so an exception cannot leave a partial optimizer
        # step behind.
        for _, _, pending_updates in prepared_groups:
            for item, value in pending_updates:
                stored = self._stored_factor_value(item, value)
                item.parameter.copy_(stored.to(dtype=item.parameter.dtype))
        for _, contexts, _ in prepared_groups:
            self._commit_context_momenta(contexts)

        # Per-group step counters make checkpoint/debug state explicit while
        # remaining ordinary optimizer param-group metadata.
        for group in self.param_groups:
            group["step"] = int(group.get("step", 0)) + 1

            if group["gauge_rebalance"]:
                step_count = int(group["step"])
                interval = int(group["gauge_rebalance_interval"])
                if step_count % interval == 0:
                    alpha = float(group["gauge_rebalance_alpha"])
                    power_steps = int(group["gauge_power_steps"])
                    params = group["params"]
                    for down_idx, up_idx in group["pair_indices"]:
                        down = params[down_idx]
                        up = params[up_idx]
                        if down not in self.state or up not in self.state:
                            continue
                        m_down = self.state[down].get("momentum_buffer")
                        m_up = self.state[up].get("momentum_buffer")
                        if m_down is None or m_up is None:
                            continue
                        self._gauge_rebalance_pair(
                            down, up, m_down, m_up, alpha, power_steps
                        )

        return loss


# Exact class name used by the suggested sd-scripts optimizer selector.
# Keep LoRAMuon as the Python-friendly alias for direct imports.
class LoRA_Muon(LoRAMuon):
    """sd-scripts-facing alias for :class:`LoRAMuon`."""

    pass


__all__ = [
    "LoRAPair",
    "LoRAMuon",
    "LoRA_Muon",
    "MSIGN_COEFFICIENTS",
    "INV_SQRT_COEFFICIENTS",
    "matrix_sign_newton_schulz",
    "inverse_sqrt_newton_schulz",
]
