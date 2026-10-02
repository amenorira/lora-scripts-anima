"""Readable training records and process-safe writes to the shared run log."""
from __future__ import annotations

from contextlib import contextmanager
import errno
import logging
import os
from pathlib import Path
import sys
import threading
import time


class _OutputLock:
    def __init__(self, path):
        self.path = path
        self.local = threading.RLock()
        self.pid = None
        self.fd = None

    @contextmanager
    def hold(self):
        with self.local:
            # Open separately in each process, including forked workers.
            if self.pid != os.getpid():
                if self.fd is not None:
                    os.close(self.fd)
                self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
                self.pid = os.getpid()
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                while True:
                    try:
                        msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EDEADLK):
                            raise
                        time.sleep(0.01)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(self.fd, fcntl.LOCK_UN)


def install(path: str) -> None:
    from rich.logging import RichHandler

    if getattr(RichHandler.emit, "_anima_training_logging", False):
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    lock = _OutputLock(path)
    _install_step_logging(lock)

    if hasattr(os, "register_at_fork"):
        def after_fork():
            lock.local = threading.RLock()
        os.register_at_fork(after_in_child=after_fork)

    original_emit = RichHandler.emit
    clock = logging.Formatter(datefmt="%Y-%m-%d %H:%M:%S")

    def emit(self, record):
        stream = self.console.file
        if stream is not sys.stdout and stream is not sys.stderr:
            return original_emit(self, record)
        try:
            # Store the message, not Rich's width-constrained terminal rendering.
            # The web viewer positions the source at the right edge.
            prefix = f"{clock.formatTime(record, clock.datefmt)} {record.levelname:<8} "
            lines = self.format(record).split("\n")
            source = f"  {record.filename}:{record.lineno}" if self._log_render.show_path else ""
            text = prefix + lines[0] + source + "\n"
            text += "".join(" " * len(prefix) + line + "\n" for line in lines[1:])
            # Redirected steps and logging records share this write lock.
            with lock.hold():
                stream.write(text)
                stream.flush()
        except Exception:
            self.handleError(record)

    emit._anima_training_logging = True
    RichHandler.emit = emit


def _install_step_logging(lock) -> None:
    """Write every steps refresh to redirected output; leave terminal tqdm alone."""
    from tqdm.std import tqdm

    if getattr(tqdm.display, "_anima_step_logging", False):
        return
    original_display = tqdm.display

    def file_steps(bar):
        return (str(getattr(bar, "desc", "")).rstrip(": ").lower() == "steps"
                and not getattr(bar.fp, "isatty", lambda: False)())

    def display(self, msg=None, pos=None):
        if file_steps(self):
            # Empty messages only clear a terminal row. Every actual rendering,
            # including repeated step numbers and identical text, is history.
            if msg != "":
                with lock.hold():
                    self.fp.write((str(self) if msg is None else msg) + "\n")
                    self.fp.flush()
            return True
        return original_display(self, msg=msg, pos=pos)

    display._anima_step_logging = True
    tqdm.display = display
