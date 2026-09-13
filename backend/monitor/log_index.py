"""Bounded, incremental byte indexes for normalized training-log rows.

Only offsets are retained. The last logical row is re-read on append because
tqdm can replace it, and writers may finish a previously incomplete line.
"""
from array import array
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
import os
import threading


@dataclass
class LogIndex:
    stamp: tuple = ()
    offsets: array = field(default_factory=lambda: array("Q"))
    tail: bytes = b""
    search: tuple = ()
    lock: object = field(default_factory=threading.RLock)


_indexes: OrderedDict[str, LogIndex] = OrderedDict()
_lock = threading.RLock()


def indexed_slice(path: Path, offset: int, limit: int, query: str, tail: bool) -> dict:
    # Local import keeps normalization owned by artifacts, shared with realtime.
    from backend.monitor.artifacts import _clean_log_text, _TQDM_STEP_RE, _LOG_SLICE_MAX_MATCHES

    key = str(path.resolve())
    with _lock:
        index = _indexes.setdefault(key, LogIndex())
        _indexes.move_to_end(key)
        while len(_indexes) > 4:
            _indexes.popitem(last=False)

    with index.lock:
        with path.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            stamp = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if index.stamp != stamp:
                previous = index.stamp
                append = previous and previous[:2] == stamp[:2] and stamp[2] > previous[2]
                if append:
                    handle.seek(max(0, previous[2] - len(index.tail)))
                    append = handle.read(len(index.tail)) == index.tail
                start = index.offsets.pop() if append and index.offsets else 0
                if not append:
                    index.offsets = array("Q")
                handle.seek(start)
                signature = None
                while handle.tell() < stat.st_size:
                    position = handle.tell()
                    raw = handle.readline(stat.st_size - position)
                    if not raw:
                        break
                    line = _clean_log_text(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
                    match = _TQDM_STEP_RE.match(line)
                    current = (match.group("current"), match.group("total")) if match else None
                    if not current or current != signature:
                        index.offsets.append(position)
                    signature = current
                index.stamp = stamp
                handle.seek(max(0, stat.st_size - 128))
                index.tail = handle.read(128)
                index.search = ()

            total = len(index.offsets)
            limit = max(1, limit)
            offset = max(0, total - limit) if tail else max(0, min(offset, total))
            end = min(total, offset + limit)

            def row(number):
                start = index.offsets[number]
                stop = index.offsets[number + 1] if number + 1 < total else stat.st_size
                handle.seek(start)
                # A logical row may contain multiple updates of the same step.
                last = ""
                while handle.tell() < stop:
                    raw = handle.readline(stop - handle.tell())
                    if not raw:
                        break
                    last = _clean_log_text(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
                return last

            lines = [row(n) for n in range(offset, end)]
            matches = []
            truncated = False
            if query and index.search and index.search[0] == query.lower():
                _, matches, truncated = index.search
            elif query:
                needle = query.lower()
                for n in range(total):
                    if needle in row(n).lower():
                        if len(matches) == _LOG_SLICE_MAX_MATCHES:
                            truncated = True
                            break
                        matches.append(n)
                index.search = (needle, matches, truncated)
            return {"total": total, "offset": offset, "limit": limit, "lines": lines,
                    "query": query, "match_indices": matches, "matches_truncated": truncated}
