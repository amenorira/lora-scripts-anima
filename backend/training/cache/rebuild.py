"""Find disk caches in the active dataset and handle the rebuild choice."""

import hashlib
import json
import re
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from backend.async_utils import settled_to_thread
from backend.monitor.run_registry import resolve_user_path
from backend.training.datasets.sd_dataset_config import _dreambooth_subsets
from backend.training.execution.preparation import training_error


SD_CACHE_SUFFIXES = {
    "anima-lora": ("_anima.npz", "_anima_te.npz"),
    "sdxl-lora": ("_sdxl.npz", "_te_outputs.npz"),
    "moss-image-lora": ("_moss.npz", "_moss_te.npz"),
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif", ".jxl"}


def _is_legacy_latent(path):
    # SDXL also accepts a plain <image stem>.npz. Check the archive's
    # latent keys so unrelated NumPy files with that name stay untouched.
    try:
        with ZipFile(path) as archive:
            keys = set(archive.namelist())
    except BadZipFile:
        return False
    for key in keys:
        if re.fullmatch(r"latents(_\d+x\d+)?\.npy", key):
            suffix = key.removeprefix("latents")
            if {f"original_size{suffix}", f"crop_ltrb{suffix}"} <= keys:
                return True
    return False


def sd_scripts_cache_files(config, profile_id):
    latents, text = set(), set()
    latent_suffix, text_suffix = SD_CACHE_SUFFIXES[profile_id]
    latent_pattern = re.compile(r".+_\d{4,}x\d{4,}" + re.escape(latent_suffix))
    for key in ("train_data_dir", "reg_data_dir"):
        if not config.get(key):
            continue
        root = Path(config[key]).resolve()
        for subset in _dreambooth_subsets(str(root), is_reg=key == "reg_data_dir"):
            directory = Path(subset["image_dir"])
            if directory.resolve() != directory:
                continue
            files = [path for path in directory.iterdir() if not path.is_symlink() and path.is_file()]
            image_stems = {path.stem for path in files if path.suffix.lower() in IMAGE_SUFFIXES}
            for path in files:
                if path.name.endswith(text_suffix):
                    text.add(path)
                elif latent_pattern.fullmatch(path.name):
                    latents.add(path)
                elif (profile_id == "sdxl-lora" and path.suffix == ".npz"
                      and path.stem in image_stems and _is_legacy_latent(path)):
                    latents.add(path)
    return latents, text


async def prepare_cache_choice(action, scan, *args):
    if action == "keep":
        return set(), None
    latents, text = await settled_to_thread(scan, *args)
    files = latents | text
    if not files:
        return files, None
    # Bind confirmation to the exact paths shown by the first request.
    scope = hashlib.sha256(json.dumps(sorted(map(str, files))).encode("utf-8")).hexdigest()
    if action != scope:
        return set(), training_error(
            "Existing training cache found / 检测到已有训练缓存",
            data={
                "latents": len(latents),
                "text": len(text),
                "directories": sorted({str(path.parent) for path in files}),
                "scope": scope,
            },
            code="trainingCacheFound",
        )
    return files, None


async def clear_cache_files(files):
    def clear():
        errors = []
        for path in sorted(files):
            try:
                if path.is_symlink() or path.parent.resolve() != path.parent:
                    errors.append(f"{path}: cache path changed")
                    continue
                path.unlink(missing_ok=True)
            except OSError as exc:
                errors.append(f"{path}: {exc}")
        return errors

    if files:
        errors = await settled_to_thread(clear)
        if errors:
            return training_error(
                "Could not clear training cache / 无法清理训练缓存",
                code="trainingCacheDeleteFailed",
                details=errors,
            )
    return None


def delete_te_cache(dirs: list[str]) -> tuple[int, list[str]]:
    """Support the legacy text-cache deletion endpoint."""
    suffixes = sorted({text for _, text in SD_CACHE_SUFFIXES.values()})
    deleted = 0
    errors: list[str] = []
    for raw in dirs:
        raw = str(raw or "").strip()
        if not raw:
            continue
        path = resolve_user_path(raw)
        if not path.is_dir():
            errors.append(f"not a directory / 不是目录: {raw}")
            continue
        for suffix in suffixes:
            for npz_path in sorted(path.rglob(f"*{suffix}")):
                try:
                    npz_path.unlink()
                    deleted += 1
                except OSError as exc:
                    errors.append(f"{npz_path.name}: {exc}")
    return deleted, errors
