"""Apply application cache options before running one Musubi cache stage."""
from __future__ import annotations

import argparse
import sys
from functools import wraps
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--stage", choices=("latents", "text_encoder"), required=True)
    parser.add_argument("--vae-tiling", action="store_true")
    parser.add_argument("--musubi-root", required=True)
    args, native_args = parser.parse_known_args()
    sys.path.insert(0, str(Path(args.musubi_root).resolve() / "src"))
    if args.stage == "latents":
        from musubi_tuner import krea2_cache_latents as worker

        if args.vae_tiling:
            original_load = worker.qwen_image_utils.load_vae

            @wraps(original_load)
            def load_tiled_vae(*values, **kwargs):
                vae = original_load(*values, **kwargs)
                vae.enable_tiling()
                print("[Krea 2 cache] VAE tiling enabled / 已启用 VAE 分块编码", flush=True)
                return vae

            worker.qwen_image_utils.load_vae = load_tiled_vae
    else:
        from musubi_tuner import krea2_cache_text_encoder_outputs as worker
    sys.argv = [sys.argv[0], *native_args]
    worker.main()


if __name__ == "__main__":
    main()
