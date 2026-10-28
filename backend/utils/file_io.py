"""Atomic replacement and UTF-8 writes with bounded Windows contention retries."""
from __future__ import annotations

import os
from pathlib import Path
import threading
import time
import uuid


def atomic_replace(
    source: Path, target: Path, *, cancel_event: threading.Event | None = None,
) -> None:
    """Keep the old file intact while briefly retrying Windows handle contention."""
    for attempt in range(5):
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")
        try:
            os.replace(source, target)
            return
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 4:
                raise
            delay = .02 * (2 ** attempt)
            if cancel_event is None:
                time.sleep(delay)
            elif cancel_event.wait(delay):
                raise InterruptedError("cancelled") from exc


def atomic_write_text(
    path: Path, text: str, *, cancel_event: threading.Event | None = None, errors: str = "strict",
) -> None:
    def check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    check_cancelled()
    temporary = path.with_name(f".{uuid.uuid4().hex}.tmp")
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
        atomic_replace(temporary, path, cancel_event=cancel_event)
    finally:
        temporary.unlink(missing_ok=True)
