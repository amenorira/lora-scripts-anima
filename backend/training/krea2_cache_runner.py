"""Run Krea 2 latent and text-cache commands as one managed task.

The supervisor owns the outer process and log file. This runner deliberately
uses plain Python child processes because musubi's Krea cache scripts do not
need Accelerate and must finish in order.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Krea 2 cache pipeline")
    parser.add_argument("--musubi-root", required=True)
    parser.add_argument("--dataset-config", required=True)
    parser.add_argument("--vae", required=True)
    parser.add_argument("--text-encoder", required=True)
    parser.add_argument("--text-cache-batch-size", type=int, default=1)
    return parser


def _run(label: str, command: list[str]) -> None:
    print(f"[Krea 2 cache] {label}", flush=True)
    completed = subprocess.run(command, check=False)
    if completed.returncode:
        raise SystemExit(completed.returncode)


def main() -> None:
    args = _parser().parse_args()
    root = Path(args.musubi_root)
    latent_script = root / "krea2_cache_latents.py"
    text_script = root / "krea2_cache_text_encoder_outputs.py"
    for script in (latent_script, text_script):
        if not script.is_file():
            raise SystemExit(f"musubi Krea cache script not found: {script}")

    _run(
        "latent cache",
        [
            sys.executable,
            str(latent_script),
            "--dataset_config",
            args.dataset_config,
            "--vae",
            args.vae,
        ],
    )
    _run(
        "text encoder cache",
        [
            sys.executable,
            str(text_script),
            "--dataset_config",
            args.dataset_config,
            "--text_encoder",
            args.text_encoder,
            "--batch_size",
            str(args.text_cache_batch_size),
        ],
    )
    print("[Krea 2 cache] completed", flush=True)


if __name__ == "__main__":
    main()
