"""Record sample PNG parameters and sidecars without changing sampling or RNG state."""
from __future__ import annotations

import builtins
from contextvars import ContextVar
import functools
import inspect
import json
import logging
from multiprocessing.sharedctypes import SynchronizedBase
import os
from pathlib import Path
import sys

from backend.monitor.sample_metadata import SCHEMA_VERSION, parse_sample_filename, sample_item_record, write_prepared_sample_batch
from .compat import sampling_due


logger = logging.getLogger(__name__)
_BATCH = ContextVar("anima_sample_batch", default=None)
_IMAGE = ContextVar("anima_sample_image", default=None)
_COUNTERS = {}
_FLAG = "_anima_sample_metadata_hook"
_ROOT = Path(__file__).resolve().parents[3]
_TRAINING_FRAMES = {
    "anima": ("train_network.py", "train", (_ROOT / "vendor" / "sd-scripts" / "train_network.py").resolve()),
    "moss_image": ("train_network.py", "train", (_ROOT / "vendor" / "sd-scripts" / "train_network.py").resolve()),
    "krea2": ("trainer_base.py", "_run_training_loop", (_ROOT / "vendor" / "musubi-tuner" / "src" / "musubi_tuner" / "training" / "trainer_base.py").resolve()),
}


def _current_training_epoch(trainer_args, accelerator, steps, architecture):
    """Read the live trainer's shared epoch for a step trigger, or leave it unknown.

    The sampler receives epoch=None for step events. Read the actual shared
    counter only from a known synchronous training frame with the same call
    arguments and global step. Never infer epochs from configured step counts.
    """
    target = _TRAINING_FRAMES.get(architecture)
    if target is None or type(steps) is not int or steps <= 0:
        return None
    frame = None
    try:
        frame = sys._getframe(1)
        while frame is not None:
            code = frame.f_code
            if code.co_name == target[1] and Path(code.co_filename).name == target[0] and Path(code.co_filename).resolve() == target[2]:
                values = frame.f_locals
                global_step = values.get("global_step")
                if values.get("args") is not trainer_args or values.get("accelerator") is not accelerator or type(global_step) is not int or global_step != steps:
                    return None
                source = values.get("current_epoch")
                if not isinstance(source, SynchronizedBase):
                    return None
                epoch = source.value
                return epoch if type(epoch) is int and epoch > 0 else None
            frame = frame.f_back
    except Exception:
        # Observation must never interfere with training when internals differ.
        return None
    finally:
        del frame
    return None


def record_parameters(*, verified=False, **params):
    """Called at the denoiser boundary, where effective CFG/seed are available."""
    image = _IMAGE.get()
    if image is not None:
        image["params"].update(params)
        image["verified"] |= verified


def _flush(batch):
    if batch["batch"]["expected"] is None or batch["batch"]["expected"] == 0:
        return
    try:
        write_prepared_sample_batch(batch["root"], batch["batch"], batch["items"], process_index=batch["rank"], num_processes=batch["processes"])
    except Exception:
        logger.warning("Sample metadata could not be saved / 无法保存采样参数记录", exc_info=True)


def _weight_identity(path):
    if not path:
        return None
    result = {"path": str(path)}
    try:
        stat = Path(path).stat()
        result.update(size=stat.st_size, mtime_ns=stat.st_mtime_ns)
    except OSError:
        pass
    return result


def _preview_settings(args, architecture, document=None):
    settings = {"architecture": architecture, "loras": [], "sampler": "euler", "scheduler": "native"}
    model = getattr(args, "dit", None) or getattr(args, "pretrained_model_name_or_path", None)
    if model:
        settings["base_model"] = _weight_identity(model)
    config = os.environ.get("ANIMA_PREVIEW_LORAS_CONFIG")
    if document is not None or config:
        doc = document if document is not None else json.loads(Path(config).read_text(encoding="utf-8"))
        if doc.get("architecture") == architecture:
            settings.update(sampler=doc.get("sampler", "euler"), scheduler=doc.get("scheduler", "native"))
            settings["loras"] = [{**(_weight_identity(row.get("path")) or {}), "multiplier": row.get("multiplier", 1)} for row in doc.get("loras", []) if row.get("multiplier", 1) != 0]
    return settings


def _native_params(values, architecture):
    args = values["args"]
    prompt = values.get("prompt_dict", values.get("sample_parameter", {}))
    replacement = values.get("prompt_replacement")
    positive, negative = prompt.get("prompt", ""), prompt.get("negative_prompt", "")
    if replacement:
        positive = positive.replace(replacement[0], replacement[1])
        if negative:
            negative = negative.replace(replacement[0], replacement[1])
    params = {**_BATCH.get()["settings"], "prompt": positive, "negative_prompt": negative or "",
              "seed": prompt.get("seed"), "steps": prompt.get("sample_steps", 50 if architecture == "moss_image" else 30),
              "cfg_scale": prompt.get("scale", 3.0 if architecture == "moss_image" else 7.5),
              "flow_shift": prompt.get("flow_shift", 5.0 if architecture == "moss_image" else 3.0)}
    if architecture == "krea2":
        params.pop("flow_shift")
    return {"params": params, "prompt_index": prompt.get("enum"), "prompt_label": prompt.get("name") or prompt.get("label"), "verified": False}


def _wrap_image(function, architecture):
    if getattr(function, "_anima_sample_image_metadata", False):
        return function
    signature = inspect.signature(function)

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        if _BATCH.get() is None:
            return function(*args, **kwargs)
        try:
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            image = _native_params(bound.arguments, architecture)
        except Exception:
            logger.warning("Sample parameters could not be observed / 无法记录当前采样参数", exc_info=True)
            return function(*args, **kwargs)
        token = _IMAGE.set(image)
        try:
            return function(*args, **kwargs)
        finally:
            _IMAGE.reset(token)

    wrapped._anima_sample_image_metadata = True
    return wrapped


def _wrap_kernel(function, architecture):
    if getattr(function, "_anima_sample_kernel_metadata", False):
        return function
    signature = inspect.signature(function)

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        try:
            values = signature.bind(*args, **kwargs)
            values.apply_defaults()
            v = values.arguments
            scale = v.get("guidance_scale", 1)
            negative = v.get("neg_crossattn_emb") if architecture == "anima" else v.get("negative_embeds")
            cfg_enabled = negative is not None and (scale > 1 if architecture == "anima" else scale != 1)
            actual = {"width": v["width"], "height": v["height"], "steps": v["steps"], "cfg_scale": scale if cfg_enabled else 1.0}
            actual["flow_shift"] = v["flow_shift"]
            if architecture == "moss_image":
                actual["uncond_skip_layers"] = list(v["uncond_skip_layers"] or [])
            record_parameters(verified=True, **actual)
        except Exception:
            logger.warning("Effective sample parameters are unavailable / 无法记录实际采样参数", exc_info=True)
        return function(*args, **kwargs)

    wrapped._anima_sample_kernel_metadata = True
    return wrapped


def _wrap_krea_inference(function):
    if getattr(function, "_anima_sample_krea_metadata", False):
        return function
    signature = inspect.signature(function)

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        try:
            values = signature.bind(*args, **kwargs)
            values.apply_defaults()
            v, trainer_args = values.arguments, values.arguments["args"]
            cfg = v["cfg_scale"] if v["cfg_scale"] is not None else 5.5
            turbo_dit, turbo_lora = getattr(trainer_args, "turbo_dit", None), getattr(trainer_args, "turbo_lora", None)
            record_parameters(verified=True, seed=int(v["generator"].initial_seed()), steps=v["sample_steps"],
                              cfg_scale=cfg if v["do_classifier_free_guidance"] and cfg > 1 else 1.0,
                              sampler="euler", scheduler="krea2_turbo_mu" if turbo_dit or turbo_lora else "krea2_raw_mu",
                              model_variant={"turbo_dit": _weight_identity(turbo_dit), "turbo_lora": _weight_identity(turbo_lora),
                                             "turbo_lora_multiplier": getattr(trainer_args, "turbo_lora_multiplier", 1.0)})
        except Exception:
            logger.warning("Krea sample parameters are unavailable / 无法记录 Krea 实际采样参数", exc_info=True)
        return function(*args, **kwargs)

    wrapped._anima_sample_krea_metadata = True
    return wrapped


def _sampling_due(args, epoch, steps, architecture="anima"):
    if architecture != "krea2":
        return sampling_due(args, epoch, steps)
    if steps == 0:
        return bool(getattr(args, "sample_at_first", False))
    epochs, interval = getattr(args, "sample_every_n_epochs", None), getattr(args, "sample_every_n_steps", None)
    return bool((interval and interval > 0 and steps % interval == 0) or
                (epochs and epochs > 0 and epoch is not None and epoch % epochs == 0))


def _wrap_batch(function, architecture):
    if getattr(function, "_anima_sample_batch_metadata", False):
        return function
    signature = inspect.signature(function)

    def prepare(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        values, trainer_args = bound.arguments, bound.arguments["args"]
        gate = getattr(function, "__globals__", {}).get("should_sample_images") if architecture == "krea2" else None
        due = gate(trainer_args, values["steps"], values["epoch"]) if callable(gate) else _sampling_due(trainer_args, values["epoch"], values["steps"], architecture)
        if not due:
            return None
        parameters = values.get("sample_parameters")
        if architecture == "krea2" and parameters is None:
            return None
        if architecture != "krea2" and not Path(getattr(trainer_args, "sample_prompts", "")).is_file():
            return None
        accelerator = values["accelerator"]
        ordinal = _COUNTERS.get(architecture, 0) + 1
        _COUNTERS[architecture] = ordinal
        rank, processes = int(getattr(accelerator, "process_index", 0)), int(getattr(accelerator, "num_processes", 1))
        session = os.environ.get("ANIMA_SAMPLE_SESSION", "0")
        current_epoch = (_current_training_epoch(trainer_args, accelerator, values["steps"], architecture)
                         if values["epoch"] is None else None)
        return {"root": Path(trainer_args.output_dir).resolve(), "rank": rank, "processes": processes,
                "settings": _preview_settings(trainer_args, architecture, getattr(function, "_anima_preview_document", None)), "items": {},
                "batch": {"id": f"{os.environ.get('ANIMA_TASK_ID', 'training')}:{session}:{architecture}:{values['epoch']}:{values['steps']}:{ordinal}",
                          "order": int(session) // 1000 + ordinal, "step": values["steps"], "epoch": values["epoch"],
                          "current_epoch": current_epoch,
                          "expected": len(parameters) if parameters is not None else None, "status": "running"}}

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        if _BATCH.get() is not None:
            return function(*args, **kwargs)
        try:
            batch = prepare(*args, **kwargs)
        except Exception:
            logger.warning("Sampling batch could not be observed / 无法记录采样批次", exc_info=True)
            batch = None
        if batch is None:
            return function(*args, **kwargs)
        token = _BATCH.set(batch)
        _flush(batch)
        completed = False
        try:
            result = function(*args, **kwargs)
            completed = True
            return result
        finally:
            expected = batch["batch"]["expected"]
            local_expected = len(range(batch["rank"], expected, batch["processes"])) if expected is not None else None
            batch["batch"]["status"] = "complete" if completed and local_expected is not None and len(batch["items"]) >= local_expected else "failed"
            _flush(batch)
            _BATCH.reset(token)

    wrapped._anima_sample_batch_metadata = True
    return wrapped


def _sample_png_info(batch, item, existing=None):
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    if existing is not None:
        info.chunks.extend(existing.chunks)
    info.add_text("parameters", json.dumps(item["params"], ensure_ascii=False, allow_nan=False))
    payload = {"schema_version": SCHEMA_VERSION, **item,
               "batch": {key: batch["batch"].get(key) for key in ("id", "epoch", "current_epoch", "step")}}
    info.add_itxt("anima_sample", json.dumps(payload, ensure_ascii=False, allow_nan=False))
    return info


def _patch_save_and_loader(image_module, sampling_module=None):
    original = image_module.Image.save
    if not getattr(original, "_anima_sample_save_metadata", False):
        @functools.wraps(original)
        def save(image, fp, *args, **kwargs):
            batch, active = _BATCH.get(), _IMAGE.get()
            item = None
            options = kwargs
            if batch is not None and active is not None and isinstance(fp, (str, Path)):
                try:
                    path = Path(fp).resolve()
                    parsed = parse_sample_filename(path.name, frame_suffix=active["params"]["architecture"] == "krea2")
                    if parsed and path.is_relative_to(batch["root"]) and parsed["prompt_index"] == active["prompt_index"]:
                        params = {**active["params"], "width": image.size[0], "height": image.size[1]}
                        # A negative seed is a request for randomization, never an actual seed.
                        if parsed["seed"] is not None and parsed["seed"] >= 0:
                            params["seed"] = parsed["seed"]
                        if not isinstance(params.get("seed"), int) or params["seed"] < 0:
                            params["seed"] = None
                        item = {
                            "params": params, "prompt_index": active["prompt_index"], "prompt_label": active["prompt_label"],
                            "params_complete": active["verified"]}
                except Exception:
                    logger.warning("Sample save parameters are unavailable / 无法记录当前样图的保存参数", exc_info=True)
            if item is not None:
                image_format = kwargs.get("format") or (args[0] if args else None)
                is_png = str(image_format).upper() == "PNG" if image_format else path.suffix.lower() == ".png"
                if is_png:
                    try:
                        options = {**kwargs, "pnginfo": _sample_png_info(batch, item, kwargs.get("pnginfo"))}
                    except Exception:
                        # Metadata observation must not prevent the original save.
                        logger.warning("Sample PNG metadata is unavailable / 无法写入样图 PNG 参数", exc_info=True)
            result = original(image, fp, *args, **options)
            if item is not None:
                try:
                    batch["items"][path.relative_to(batch["root"]).as_posix()] = sample_item_record(path, item)
                    _flush(batch)
                except Exception:
                    logger.warning("Saved sample metadata is unavailable / 无法记录已保存样图的参数", exc_info=True)
            return result
        save._anima_sample_save_metadata = True
        image_module.Image.save = save
    if sampling_module is not None:
        loader = sampling_module.load_prompts
        if not getattr(loader, "_anima_sample_loader_metadata", False):
            @functools.wraps(loader)
            def load(*args, **kwargs):
                prompts = loader(*args, **kwargs)
                batch = _BATCH.get()
                if batch is not None:
                    batch["batch"]["expected"] = len(prompts)
                    _flush(batch)
                return prompts
            load._anima_sample_loader_metadata = True
            sampling_module.load_prompts = load


def install_import_hook():
    """Install only in explicitly enabled project training child processes."""
    if getattr(builtins, _FLAG, False):
        return
    original_import = builtins.__import__
    installing = False
    patched = set()
    targets = {"library.anima_train_utils": "anima", "library.moss_image_train_utils": "moss_image", "musubi_tuner.krea2_train_network": "krea2"}

    def patch_loaded():
        nonlocal installing
        if installing:
            return
        installing = True
        try:
            for name, architecture in targets.items():
                module = sys.modules.get(name)
                if name in patched or module is None or getattr(getattr(module, "__spec__", None), "_initializing", False):
                    continue
                if architecture != "krea2":
                    # Adapter wrappers need the vendor function's globals. Let
                    # their hook install first, then wrap their public entry.
                    candidate = getattr(module, "sample_images", None)
                    if os.environ.get("ANIMA_PREVIEW_LORAS_CONFIG") and callable(candidate) and not getattr(candidate, "_anima_preview_loras", False):
                        continue
                # A ready but incompatible module is attempted only once. Build
                # all wrappers before mutation, so failed probing cannot nest
                # another public sampler wrapper on every subsequent import.
                patched.add(name)
                try:
                    if architecture == "krea2":
                        trainer = module.Krea2NetworkTrainer
                        batch_wrapper = _wrap_batch(trainer.sample_images, architecture)
                        image_wrapper = _wrap_image(trainer.sample_image_inference, architecture)
                        inference_wrapper = _wrap_krea_inference(trainer.do_inference)
                        image_module = sys.modules["PIL.Image"]
                        if not callable(image_module.Image.save):
                            raise TypeError("PIL save interface changed")
                        trainer.sample_images = batch_wrapper
                        trainer.sample_image_inference = image_wrapper
                        trainer.do_inference = inference_wrapper
                        _patch_save_and_loader(image_module)
                    else:
                        kernel = "do_sample" if architecture == "anima" else "generate_latents"
                        batch_wrapper = _wrap_batch(module.sample_images, architecture)
                        image_wrapper = _wrap_image(module._sample_image_inference, architecture)
                        kernel_wrapper = _wrap_kernel(getattr(module, kernel), architecture)
                        if not callable(module.Image.Image.save) or not callable(module.sampling.load_prompts):
                            raise TypeError("Sample save/loader interface changed")
                        module.sample_images = batch_wrapper
                        module._sample_image_inference = image_wrapper
                        setattr(module, kernel, kernel_wrapper)
                        _patch_save_and_loader(module.Image, module.sampling)
                except Exception:
                    logger.warning("Sample metadata hook is unavailable / 采样参数记录未能启用: %s", name, exc_info=True)
        except Exception:
            logger.warning("Sample metadata hook is unavailable / 采样参数记录未能启用", exc_info=True)
        finally:
            installing = False

    @functools.wraps(original_import)
    def import_with_metadata(*args, **kwargs):
        result = original_import(*args, **kwargs)
        patch_loaded()
        return result

    builtins.__import__ = import_with_metadata
    setattr(builtins, _FLAG, True)
    patch_loaded()
