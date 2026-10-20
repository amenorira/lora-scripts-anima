"""Focused regression tests; prefer tools/dev/run_tests.py in the project venv."""

import sys

sys.dont_write_bytecode = True

from tools.runtime_paths import configure_test_paths

configure_test_paths()
