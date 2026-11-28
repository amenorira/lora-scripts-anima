"""Pure-Python O(1)-RAM streaming ZIP / ZIP64 generator for HTTP responses."""
from __future__ import annotations

import os
from pathlib import Path
import struct
import time
from typing import Iterable, Iterator
import urllib.parse
import zipfile
import zlib

from fastapi.responses import StreamingResponse

from backend.utils.file_io import open_read

_ZIP64_LIMIT = 0xFFFFFFFF
_ZIP64_COUNT_LIMIT = 0xFFFF
# Switch to 64-bit data descriptors slightly below 4 GiB in case a file grows slightly during streaming.
_ZIP64_PREEMPTIVE_SIZE = 0xF0000000
_UTF8_AND_DESCRIPTOR_FLAGS = 0x0800 | 0x0008

# Text/config/log extensions benefit strongly from DEFLATE; images and weights stay ZIP_STORED.
COMPRESSIBLE_TEXT_EXTENSIONS = frozenset({
    ".txt", ".json", ".jsonl", ".toml", ".yaml", ".yml", ".log", ".md",
    ".csv", ".tsv", ".xml", ".html", ".css", ".js", ".py", ".sh", ".bat", ".ini", ".cfg",
})


def choose_compression(arcname: str, *, compress_text: bool = True) -> int:
    """Use ZIP_DEFLATED for small text formats when enabled; ZIP_STORED for media/weights."""
    if compress_text and os.path.splitext(arcname)[1].lower() in COMPRESSIBLE_TEXT_EXTENSIONS:
        return zipfile.ZIP_DEFLATED
    return zipfile.ZIP_STORED


def _dos_datetime(timestamp: float) -> tuple[int, int]:
    dt = time.localtime(timestamp)
    year = max(1980, min(2107, dt.tm_year))
    dos_time = (dt.tm_hour << 11) | (dt.tm_min << 5) | (dt.tm_sec // 2)
    dos_date = ((year - 1980) << 9) | (dt.tm_mon << 5) | dt.tm_mday
    return dos_time, dos_date


def _normalize_arcname(arcname: Path | str) -> str:
    text = str(arcname).replace("\\", "/").lstrip("/")
    return text or "file"


def iter_zip_chunks(
    entries: Iterable[tuple[Path | str, Path | str]],
    *,
    compress_text: bool = True,
    chunk_size: int = 256 * 1024,
    compress_level: int = 6,
    force_zip64: bool = False,
) -> Iterator[bytes]:
    """Stream a valid ZIP / ZIP64 archive in O(1) RAM without temporary files.

    Each entry is ``(source_path, arcname)``. Files that vanish before opening
    are skipped cleanly without corrupting the archive.
    """
    central_directory: list[bytes] = []
    offset = 0

    for source_raw, arcname_raw in entries:
        source = Path(source_raw)
        arcname = _normalize_arcname(arcname_raw)
        name_bytes = arcname.encode("utf-8")
        method = choose_compression(arcname, compress_text=compress_text)

        try:
            st = source.stat()
            stream = open_read(source)
        except FileNotFoundError:
            continue

        dos_time, dos_date = _dos_datetime(st.st_mtime)
        use_zip64_dd = force_zip64 or st.st_size >= _ZIP64_PREEMPTIVE_SIZE
        lfh_version = 45 if use_zip64_dd else 20
        lfh_extra = struct.pack("<HHQQ", 0x0001, 16, 0, 0) if use_zip64_dd else b""

        entry_offset = offset
        lfh = struct.pack(
            "<4sHHHHHIIIHH",
            b"PK\x03\x04",
            lfh_version,
            _UTF8_AND_DESCRIPTOR_FLAGS,
            method,
            dos_time,
            dos_date,
            0,  # crc32 in data descriptor
            0,  # compressed size in data descriptor
            0,  # uncompressed size in data descriptor
            len(name_bytes),
            len(lfh_extra),
        ) + name_bytes + lfh_extra
        yield lfh
        offset += len(lfh)

        crc = 0
        uncomp_size = 0
        comp_size = 0
        compressor = (
            zlib.compressobj(compress_level, zlib.DEFLATED, -zlib.MAX_WBITS)
            if method == zipfile.ZIP_DEFLATED
            else None
        )

        with stream:
            while True:
                data = stream.read(chunk_size)
                if not data:
                    break
                uncomp_size += len(data)
                crc = zlib.crc32(data, crc)
                if compressor is not None:
                    out = compressor.compress(data)
                    if out:
                        comp_size += len(out)
                        offset += len(out)
                        yield out
                else:
                    comp_size += len(data)
                    offset += len(data)
                    yield data

        if compressor is not None:
            tail = compressor.flush()
            if tail:
                comp_size += len(tail)
                offset += len(tail)
                yield tail

        crc &= 0xFFFFFFFF
        if use_zip64_dd:
            dd = struct.pack("<4sIQQ", b"PK\x07\x08", crc, comp_size, uncomp_size)
        else:
            dd = struct.pack("<4sIII", b"PK\x07\x08", crc, comp_size, uncomp_size)
        yield dd
        offset += len(dd)

        # Build Central Directory header (with ZIP64 extra field whenever required).
        need_uncomp64 = force_zip64 or uncomp_size >= _ZIP64_LIMIT
        need_comp64 = force_zip64 or comp_size >= _ZIP64_LIMIT
        need_offset64 = force_zip64 or entry_offset >= _ZIP64_LIMIT

        cd_extra_values: list[int] = []
        if need_uncomp64:
            cd_extra_values.append(uncomp_size)
        if need_comp64:
            cd_extra_values.append(comp_size)
        if need_offset64:
            cd_extra_values.append(entry_offset)

        if cd_extra_values:
            cd_extra = struct.pack(
                "<HH" + "Q" * len(cd_extra_values),
                0x0001,
                8 * len(cd_extra_values),
                *cd_extra_values,
            )
            cd_version = 45
        else:
            cd_extra = b""
            cd_version = 20

        cd_header = struct.pack(
            "<4sHHHHHHIIIHHHHHII",
            b"PK\x01\x02",
            (3 << 8) | cd_version,  # version made by: Unix + spec version
            cd_version,
            _UTF8_AND_DESCRIPTOR_FLAGS,
            method,
            dos_time,
            dos_date,
            crc,
            _ZIP64_LIMIT if need_comp64 else comp_size,
            _ZIP64_LIMIT if need_uncomp64 else uncomp_size,
            len(name_bytes),
            len(cd_extra),
            0,  # file comment length
            0,  # disk number start
            0,  # internal file attributes
            0o100644 << 16,  # regular file permissions
            _ZIP64_LIMIT if need_offset64 else entry_offset,
        ) + name_bytes + cd_extra
        central_directory.append(cd_header)

    cd_offset = offset
    cd_size = 0
    for header in central_directory:
        yield header
        cd_size += len(header)
    offset += cd_size

    entry_count = len(central_directory)
    need_zip64_eocd = (
        force_zip64
        or entry_count >= _ZIP64_COUNT_LIMIT
        or cd_size >= _ZIP64_LIMIT
        or cd_offset >= _ZIP64_LIMIT
    )
    if need_zip64_eocd:
        zip64_eocd_offset = offset
        zip64_eocd = struct.pack(
            "<4sQHHIIQQQQ",
            b"PK\x06\x06",
            44,  # size of remaining ZIP64 EOCD record
            (3 << 8) | 45,
            45,
            0,  # disk number
            0,  # disk with central directory
            entry_count,
            entry_count,
            cd_size,
            cd_offset,
        )
        yield zip64_eocd
        offset += len(zip64_eocd)

        zip64_locator = struct.pack(
            "<4sIQI",
            b"PK\x06\x07",
            0,  # disk with ZIP64 EOCD
            zip64_eocd_offset,
            1,  # total number of disks
        )
        yield zip64_locator
        offset += len(zip64_locator)

    eocd = struct.pack(
        "<4sHHHHIIH",
        b"PK\x05\x06",
        0,
        0,
        _ZIP64_COUNT_LIMIT if need_zip64_eocd else entry_count,
        _ZIP64_COUNT_LIMIT if need_zip64_eocd else entry_count,
        _ZIP64_LIMIT if need_zip64_eocd else cd_size,
        _ZIP64_LIMIT if need_zip64_eocd else cd_offset,
        0,
    )
    yield eocd


def content_disposition_attachment(filename: str) -> str:
    """Build an RFC 5987 Content-Disposition header with safe ASCII fallback."""
    clean = filename.replace("\r", "").replace("\n", "").replace('"', "_") or "archive.zip"
    ascii_fallback = "".join(c if 32 <= ord(c) < 127 and c not in '\\/"' else "_" for c in clean) or "archive.zip"
    encoded = urllib.parse.quote(clean, safe="")
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'


def streaming_zip_response(
    entries: Iterable[tuple[Path | str, Path | str]],
    filename: str,
    *,
    compress_text: bool = True,
    chunk_size: int = 256 * 1024,
) -> StreamingResponse:
    """Create a StreamingResponse that streams ZIP bytes immediately with O(1) RAM."""
    return StreamingResponse(
        iter_zip_chunks(entries, compress_text=compress_text, chunk_size=chunk_size),
        media_type="application/zip",
        headers={
            "Content-Disposition": content_disposition_attachment(filename),
            "X-Accel-Buffering": "no",
        },
    )
