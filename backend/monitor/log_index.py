"""Bounded, incremental byte indexes for normalized training-log rows.

Only offsets are retained. The last two logical rows are re-read on append
to handle incomplete records and terminal separators at the end of the file.
"""
from array import array
from collections import OrderedDict
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path
import os
import threading

from backend.monitor.log_parser import clean_bytes, record_frames, MAX_SEARCH_MATCHES


@dataclass
class LogIndex:
    stamp: tuple = ()
    generation: int = 0
    offsets: array = field(default_factory=lambda: array("Q"))
    tail: bytes = b""
    search: tuple = ()
    lock: object = field(default_factory=threading.RLock)


_indexes: OrderedDict[str, LogIndex] = OrderedDict()
_lock = threading.RLock()
_generations = count(1)


def indexed_slice(path: Path, offset: int, limit: int, query: str, tail: bool) -> dict:
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
                start = 0
                changed_row = 0
                if append and index.offsets:
                    changed_row = max(0, len(index.offsets) - 2)
                    start = index.offsets[changed_row]
                    del index.offsets[changed_row:]
                if not append:
                    index.offsets = array("Q")
                    index.generation = next(_generations)
                handle.seek(start)
                while handle.tell() < stat.st_size:
                    position = handle.tell()
                    raw = handle.readline(stat.st_size - position)
                    if not raw:
                        break
                    for relative, _ in record_frames(raw):
                        index.offsets.append(position + relative)
                index.stamp = stamp
                handle.seek(max(0, stat.st_size - 128))
                index.tail = handle.read(128)
                if append and index.search:
                    needle, matches, truncated, scanned = index.search
                    kept = [n for n in matches if n < changed_row]
                    # A capped result is still complete up to its first omitted
                    # match if the changed tail starts beyond that boundary.
                    if not (truncated and scanned < changed_row):
                        index.search = (needle, kept, False, min(scanned, changed_row))
                else:
                    index.search = ()

            total = len(index.offsets)
            limit = max(1, limit)
            offset = max(0, total - limit) if tail else max(0, min(offset, total))
            end = min(total, offset + limit)

            def row(number):
                start = index.offsets[number]
                stop = index.offsets[number + 1] if number + 1 < total else stat.st_size
                handle.seek(start)
                return clean_bytes(handle.read(stop - start).rstrip(b"\r\n"))

            lines = [row(n) for n in range(offset, end)]
            matches = []
            truncated = False
            if query:
                needle = query.lower()
                scanned = 0
                if index.search and index.search[0] == needle:
                    _, cached, truncated, scanned = index.search
                    matches = list(cached)
                for n in range(scanned, total) if not truncated else ():
                    if needle in row(n).lower():
                        if len(matches) == MAX_SEARCH_MATCHES:
                            truncated = True
                            scanned = n
                            break
                        matches.append(n)
                    scanned = n + 1
                index.search = (needle, matches, truncated, scanned)
            return {"total": total, "offset": offset, "limit": limit, "lines": lines, "generation": index.generation,
                    "query": query, "match_indices": matches, "matches_truncated": truncated}
