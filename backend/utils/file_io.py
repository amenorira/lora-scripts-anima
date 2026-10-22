"""Atomic UTF-8 writes without tempfile's Windows permission-error retries."""
from __future__ import annotations

import os
from pathlib import Path
import threading
import uuid


def atomic_write_text(
    path: Path, text: str, *, cancel_event: threading.Event | None = None, errors: str = "strict",
) -> None:
    def check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    check_cancelled()
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    # Open outside the cleanup block: if creation fails, we do not own the path.
    # In particular, never retry PermissionError or remove a colliding file.
    handle = temporary.open("x", encoding="utf-8", errors=errors, newline="\n")
    try:
        with handle:
            check_cancelled()
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        check_cancelled()
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
