"""Install an optional, matching FA2 wheel without changing PyTorch or CUDA."""
import argparse
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import flash_attention


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()

    def emit(**event):
        print(json.dumps(event, ensure_ascii=False), flush=True)
    try:
        flash_attention.install(emit)
        return 0
    except Exception as exc:
        emit(stage="error", message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
