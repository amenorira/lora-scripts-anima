"""Run focused regressions, isolating caches before importing project modules."""
import os
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT))
    from tools.runtime_paths import configure_test_paths

    configure_test_paths()
    os.chdir(ROOT)
    arguments = sys.argv[1:] or ["discover", "-s", "tests", "-t", "."]
    unittest.main(module=None, argv=[sys.argv[0], *arguments])


if __name__ == "__main__":
    main()
