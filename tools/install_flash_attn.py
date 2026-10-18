"""Install an optional, matching FA2 wheel without changing PyTorch or CUDA."""
from pathlib import Path
import argparse
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import flash_attention


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["auto", "direct", "mirror"], default="auto")
    args = parser.parse_args()
    def emit(**event):
        print(json.dumps(event, ensure_ascii=False), flush=True)
    try:
        flash_attention.install(emit, source=args.source)
        return 0
    except Exception as exc:
        emit(stage="error", message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
