"""Console output helpers for Windows code pages."""
from __future__ import annotations

import sys


def safe_print(message: object) -> None:
    """Print Unicode text without failing on legacy Windows consoles."""
    stream = sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    text = str(message).encode(encoding, errors="replace").decode(encoding)
    print(text, file=stream)
