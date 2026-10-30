"""Explicit contracts for the two upstream sampling functions we wrap."""
from __future__ import annotations

import ast
import inspect
from pathlib import Path


MODULES = {"anima": "library.anima_train_utils", "moss_image": "library.moss_image_train_utils"}
REQUIRED = {"accelerator", "args", "epoch", "steps", "dit", "vae", "text_encoder",
            "tokenize_strategy", "text_encoding_strategy"}


class PreviewCompatibilityError(RuntimeError):
    pass


def check_source(architecture, root=None):
    """Preflight without importing torch, CUDA, or the upstream library package."""
    root = Path(root) if root else Path(__file__).resolve().parents[3]
    path = root.resolve() / "vendor" / "sd-scripts" / (MODULES[architecture].replace(".", "/") + ".py")
    try:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "sample_images")
        names = {arg.arg for arg in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
        if not REQUIRED <= names:
            raise ValueError(f"missing sampling parameters: {sorted(REQUIRED - names)}")
    except (OSError, SyntaxError, StopIteration, ValueError) as exc:
        raise PreviewCompatibilityError(
            f"sd-scripts preview interface changed / sd-scripts 预览接口不兼容: {path}: {exc}") from exc


def sampling_signature(function):
    signature = inspect.signature(function)
    if not REQUIRED <= signature.parameters.keys():
        raise PreviewCompatibilityError("sd-scripts sample_images signature changed / 预览函数参数已改变")
    return signature




def sampling_due(args, epoch, steps):
    # Same schedule semantics as the upstream public sampler. Keep this contract
    # covered against the actual functions; it avoids disk/GPU work on each step.
    if steps == 0:
        return bool(getattr(args, "sample_at_first", False))
    epochs = getattr(args, "sample_every_n_epochs", None)
    interval = getattr(args, "sample_every_n_steps", None)
    if epochs is not None:
        return bool(epochs > 0 and epoch is not None and epoch % epochs == 0)
    return bool(interval and interval > 0 and epoch is None and steps % interval == 0)
