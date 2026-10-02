"""Shared byte-to-row normalization for historical and live training logs."""
import re

MAX_SEARCH_MATCHES = 5000
ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
BAR_RE = re.compile(r'^(?P<label>.*?)(?P<pct>\d{1,3})%\|.*\|\s*(?P<suffix>\d+\s*/\s*\d+.*)$')
STEP_RE = re.compile(r'^\s*steps:\s+\d{1,3}%\|.*\|\s*\d+\s*/\s*\d+(?=\s*\[)', re.IGNORECASE)


def compact_bar(text: str, width: int = 10) -> str:
    match = BAR_RE.match(text)
    if not match:
        return text
    percent = max(0, min(100, int(match['pct'])))
    filled = round(width * percent / 100)
    return f"{match['label']}{percent}%|{'#' * filled}{'-' * (width - filled)}| {match['suffix']}"


def record_frames(raw: bytes):
    """Yield original byte offsets and rows from one LF record.

    Retain every steps refresh (including identical ones); other CR output
    keeps terminal overwrite semantics. The first offset includes its prefix.
    """
    parts = raw.removesuffix(b'\n').removesuffix(b'\r').split(b'\r')
    position, first = 0, True
    for index, part in enumerate(parts):
        text = ANSI_RE.sub('', part.decode('utf-8', errors='replace'))
        if STEP_RE.match(text) or index == len(parts) - 1:
            yield 0 if first else position, compact_bar(text)
            first = False
        position += len(part) + 1


def clean_bytes(raw: bytes) -> str:
    return '\n'.join(text for record in raw.split(b'\n') for _, text in record_frames(record))
