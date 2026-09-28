"""Keep application-managed TensorBoard events directly in each run's log/."""
from __future__ import annotations

import builtins
import functools
import os
import sys


def install_import_hook() -> None:
    """Patch only the TensorBoard tracker, after Accelerate finishes importing.

    Engines may add timestamp and tracker-name directories. The supervisor's
    explicit destination overrides both without changing other tracker backends
    or standalone trainer invocations. No files are moved after writer creation.
    """
    destination = os.environ.get("ANIMA_TENSORBOARD_DIR")
    if not destination or getattr(builtins, "_anima_tb_layout_hook", False):
        return
    original_import = builtins.__import__
    patched = False

    def patch_tracker():
        nonlocal patched
        module = sys.modules.get("accelerate.tracking")
        tracker = getattr(module, "TensorBoardTracker", None)
        if tracker is None:
            return
        original_init = tracker.__init__
        original_start = tracker.start

        @functools.wraps(original_init)
        def init_in_run_log(self, run_name, logging_dir, **kwargs):
            original_init(self, "", destination, **kwargs)
            self.run_name = run_name

        @functools.wraps(original_start)
        def start_in_run_log(self, *args, **kwargs):
            # Accelerate 1.15 defers writer creation from __init__ to start.
            # Hide the tracker suffix while it resolves the event directory,
            # then keep the original name for get_tracker and other consumers.
            run_name = self.run_name
            self.run_name = ""
            try:
                return original_start(self, *args, **kwargs)
            finally:
                self.run_name = run_name

        tracker.__init__ = init_in_run_log
        tracker.start = start_in_run_log
        patched = True

    @functools.wraps(original_import)
    def import_with_layout(*args, **kwargs):
        result = original_import(*args, **kwargs)
        if not patched:
            patch_tracker()
        return result

    builtins.__import__ = import_with_layout
    builtins._anima_tb_layout_hook = True
    patch_tracker()
