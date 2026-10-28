"""Run Krea 2 latent and text-cache commands as one managed task.

The supervisor owns the outer process and log file. This runner deliberately
uses plain Python child processes because musubi's Krea cache scripts do not
need Accelerate and must finish in order.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Krea 2 cache pipeline")
    parser.add_argument("--musubi-root", required=True)
    parser.add_argument("--dataset-config", required=True)
    parser.add_argument("--vae", required=True)
    parser.add_argument("--text-encoder", required=True)
    parser.add_argument("--text-cache-batch-size", type=int, default=1)
    parser.add_argument("--latent-cache-batch-size", type=int, default=1)
    parser.add_argument("--latent-device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--text-device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--num-workers", type=int, default=2)
    parser.add_argument("--vae-tiling", action="store_true")
    parser.add_argument("--request-file")
    return parser


def _run(label: str, command: list[str]) -> None:
    print(f"[Krea 2 cache] {label}", flush=True)
    completed = subprocess.run(command, check=False)
    if completed.returncode:
        raise SystemExit(completed.returncode)


def _stage_dataset(source: Path, stage: str, batch_size: int) -> Path:
    from backend.training import toml_writer

    dataset = tomllib.loads(source.read_text(encoding="utf-8"))
    dataset.setdefault("general", {})["batch_size"] = batch_size
    for subset in dataset.get("datasets", []):
        subset["batch_size"] = batch_size
    target = source.with_name(f"{source.stem}-{stage}.toml")
    target.write_text(toml_writer.dumps(dataset), encoding="utf-8")
    return target


def main() -> None:
    args = _parser().parse_args()
    root = Path(args.musubi_root)
    latent_script = root / "krea2_cache_latents.py"
    text_script = root / "krea2_cache_text_encoder_outputs.py"
    for script in (latent_script, text_script):
        if not script.is_file():
            raise SystemExit(f"musubi Krea cache script not found / 未找到 Krea 缓存脚本: {script}")

    config = json.loads(Path(args.request_file).read_text(encoding="utf-8")) if args.request_file else None
    worker = Path(__file__).with_name("krea2_cache_worker.py")
    for stage, label, device, batch_size, model_flag, model in (
        ("latents", "latent cache / 图像 Latent 缓存", args.latent_device, args.latent_cache_batch_size, "--vae", args.vae),
        ("text_encoder", "text encoder cache / 文本编码缓存", args.text_device, args.text_cache_batch_size, "--text_encoder", args.text_encoder),
    ):
        if config is not None:
            from backend.training.krea2_cache import (
                read_cache_manifest, get_krea2_cache_status, complete_stage, reusable_stages, stage_fingerprints,
            )

            manifest, _ = read_cache_manifest(config["dataset_cache_dir"])
            if reusable_stages(config, manifest, get_krea2_cache_status(config), stage_fingerprints(config))[stage]:
                print(f"[Krea 2 cache] reuse / 复用 {label}", flush=True)
                continue
        dataset_config = _stage_dataset(Path(args.dataset_config), stage, batch_size)
        command = [sys.executable, str(worker), "--stage", stage, "--musubi-root", str(root),
                   "--dataset_config", str(dataset_config), model_flag, model,
                   "--batch_size", str(batch_size), "--num_workers", str(args.num_workers)]
        if device != "auto":
            command += ["--device", device]
        if stage == "latents" and args.vae_tiling:
            command.append("--vae-tiling")
        _run(label, command)
        if config is not None:
            complete_stage(config, stage)
    print("[Krea 2 cache] completed / 缓存完成", flush=True)


if __name__ == "__main__":
    main()
