"""Explicit contracts for the two upstream sampling functions we wrap."""
from __future__ import annotations

import ast
import inspect
from pathlib import Path


MODULES = {"anima": "library.anima_train_utils", "moss_image": "library.moss_image_train_utils"}
REQUIRED = {"accelerator", "args", "epoch", "steps", "dit", "vae", "text_encoder",
            "tokenize_strategy", "text_encoding_strategy"}
KERNELS = {
    "anima": ("do_sample", {"height", "width", "seed", "dit", "crossattn_emb", "steps", "dtype", "device",
                            "guidance_scale", "flow_shift", "neg_crossattn_emb"}),
    "moss_image": ("generate_latents", {"dit", "prompt_embeds", "prompt_mask", "negative_embeds", "negative_mask",
                                       "height", "width", "steps", "guidance_scale", "flow_shift",
                                       "uncond_skip_layers", "seed", "device", "show_progress"}),
}


class PreviewCompatibilityError(RuntimeError):
    pass


def check_source(architecture, root=None, *, custom_sampling=False):
    """Preflight without importing torch, CUDA, or the upstream library package."""
    root = Path(root) if root else Path(__file__).resolve().parents[3]
    path = root.resolve() / "vendor" / "sd-scripts" / (MODULES[architecture].replace(".", "/") + ".py")
    try:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "sample_images")
        names = {arg.arg for arg in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
        if not REQUIRED <= names:
            raise ValueError(f"missing sampling parameters: {sorted(REQUIRED - names)}")
        if custom_sampling:
            name, expected = KERNELS[architecture]
            kernel = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
            actual = {arg.arg for arg in [*kernel.args.posonlyargs, *kernel.args.args, *kernel.args.kwonlyargs]}
            if actual != expected or kernel.args.vararg or kernel.args.kwarg:
                raise ValueError(f"{name} parameters changed: {sorted(actual ^ expected)}")
            inference = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_sample_image_inference")
            if not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == name
                       for node in ast.walk(inference)):
                raise ValueError(f"_sample_image_inference no longer calls {name}")
    except (OSError, SyntaxError, StopIteration, ValueError) as exc:
        raise PreviewCompatibilityError(
            f"sd-scripts preview interface changed / sd-scripts 预览接口不兼容: {path}: {exc}") from exc


def sampling_signature(function):
    signature = inspect.signature(function)
    if not REQUIRED <= signature.parameters.keys():
        raise PreviewCompatibilityError("sd-scripts sample_images signature changed / 预览函数参数已改变")
    return signature


def kernel_signature(function, architecture):
    signature = inspect.signature(function)
    if set(signature.parameters) != KERNELS[architecture][1] or any(
            parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD) for parameter in signature.parameters.values()):
        raise PreviewCompatibilityError(f"sd-scripts {KERNELS[architecture][0]} signature changed / 去噪接口参数已改变")
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
