"""Configure the read-only dependency bridge for the musubi core venv.

The Krea 2 runtime needs a newer transformers stack than sd-scripts, but it
must use the main project venv's CUDA-enabled PyTorch build.  A normal nested
venv cannot inherit packages from its parent venv, so this helper writes one
.pth entry into the musubi venv.  Python resolves musubi's own site-packages
first and appends the host site-packages afterwards, preserving dependency
isolation while reusing torch and torchvision without duplicating CUDA wheels.
"""
from __future__ import annotations

import argparse
import site
import sys
from pathlib import Path


def _core_site_packages() -> Path:
    prefix = Path(sys.prefix).resolve()
    for entry in site.getsitepackages():
        candidate = Path(entry).resolve()
        try:
            candidate.relative_to(prefix)
        except ValueError:
            continue
        return candidate
    raise RuntimeError(f"Could not locate site-packages inside core venv: {prefix}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host-site-packages", required=True)
    args = parser.parse_args()

    host_site = Path(args.host_site_packages).expanduser().resolve()
    if not host_site.is_dir():
        parser.error(f"Host site-packages does not exist: {host_site}")

    core_site = _core_site_packages()
    if not core_site.is_dir():
        raise RuntimeError(f"Core site-packages does not exist: {core_site}")

    overlay_file = core_site / "anima_host_venv.pth"
    overlay_file.write_text(f"{host_site}\n", encoding="utf-8")
    print(f"Configured musubi dependency overlay: {overlay_file}")


if __name__ == "__main__":
    main()
