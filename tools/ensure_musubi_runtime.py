#!/usr/bin/env python
"""Verify the shared main-venv requirements used by musubi Krea 2.

Launchers call the metadata-only mode before invoking pip. A healthy
environment returns zero, so normal startups do not download, uninstall,
overwrite packages, or import the full Krea 2 stack.
"""
from __future__ import annotations

import argparse
import json

from backend.training.musubi_runtime import shared_runtime_status


def main() -> int:
    parser = argparse.ArgumentParser(description="Check shared musubi Krea 2 runtime")
    parser.add_argument("--check", action="store_true", help="kept for launcher readability")
    parser.add_argument(
        "--verify-imports",
        action="store_true",
        help="also import Krea 2's native and Qwen3-VL dependencies",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="do not print the healthy status (errors are still shown)",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable status")
    args = parser.parse_args()

    status = shared_runtime_status(verify_imports=args.verify_imports)
    if args.json:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    elif status["ok"]:
        if not args.quiet:
            print(
                "[Krea 2] Shared training runtime is ready"
                f" ({'full import verification' if args.verify_imports else 'fast metadata check'}): "
                f"transformers={status['versions'].get('transformers')}, "
                f"torch={status['versions'].get('torch')}",
                flush=True,
            )
    else:
        print("[Krea 2] Shared training runtime needs synchronization:", flush=True)
        for error in status["errors"]:
            print(f"  - {error}", flush=True)
    return 0 if status["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
