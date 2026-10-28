"""Windows handles for shared readers and POSIX-style atomic replacement."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import msvcrt
import os
from pathlib import Path


_DELETE = 0x00010000
_GENERIC_READ = 0x80000000
_SHARE_READ_WRITE_DELETE = 0x00000007
_OPEN_EXISTING = 3
_OPEN_REPARSE_POINT_AND_DIRECTORY = 0x02200000
_FILE_RENAME_INFO_EX = 22
_REPLACE_IF_EXISTS_AND_POSIX = 0x00000003
_UNSUPPORTED = {1, 50, 87, 120}
_INVALID_HANDLE = ctypes.c_void_p(-1).value

_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel.CreateFileW.argtypes = (
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
)
_kernel.CreateFileW.restype = wintypes.HANDLE
_kernel.SetFileInformationByHandle.argtypes = (
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
)
_kernel.SetFileInformationByHandle.restype = wintypes.BOOL
_kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
_kernel.CloseHandle.restype = wintypes.BOOL


class _RenameInfo(ctypes.Structure):
    # The first member is the DWORD arm of FILE_RENAME_INFO's union.
    _fields_ = [
        ("Flags", wintypes.DWORD), ("RootDirectory", wintypes.HANDLE),
        ("FileNameLength", wintypes.DWORD), ("FileName", wintypes.WCHAR * 1),
    ]


def _absolute_name(path: Path) -> str:
    name = os.fspath(path)
    if "\0" in name:
        raise ValueError("embedded null character")
    name = os.path.abspath(name)
    if name.startswith("\\\\?\\"):
        return name
    if name.startswith("\\\\"):
        return "\\\\?\\UNC\\" + name[2:]
    return "\\\\?\\" + name


def _error(code: int, source: Path, target: Path | None = None) -> OSError:
    error = ctypes.WinError(code)
    error.filename = os.fspath(source)
    if target is not None:
        error.filename2 = os.fspath(target)
    return error


def open_read_fd(path: Path) -> int:
    """Let a writer replace the name while this reader retains the old file."""
    handle = _kernel.CreateFileW(
        _absolute_name(path), _GENERIC_READ, _SHARE_READ_WRITE_DELETE,
        None, _OPEN_EXISTING, 0, None,
    )
    if handle == _INVALID_HANDLE:
        raise _error(ctypes.get_last_error(), path)
    try:
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        _kernel.CloseHandle(handle)
        raise


def try_atomic_replace(source: Path, target: Path) -> bool:
    """Replace without waiting for delete-shared readers; False means unsupported.

    FILE_RENAME_FLAG_POSIX_SEMANTICS preserves existing readers' old handles.
    Read-only attributes and access permissions are still enforced.
    """
    handle = _kernel.CreateFileW(
        _absolute_name(source), _DELETE, _SHARE_READ_WRITE_DELETE, None,
        _OPEN_EXISTING, _OPEN_REPARSE_POINT_AND_DIRECTORY, None,
    )
    if handle == _INVALID_HANDLE:
        raise _error(ctypes.get_last_error(), source, target)
    try:
        name = _absolute_name(target).encode("utf-16-le", errors="surrogatepass")
        size = max(ctypes.sizeof(_RenameInfo), _RenameInfo.FileName.offset + len(name) + 2)
        buffer = ctypes.create_string_buffer(size)
        info = _RenameInfo.from_buffer(buffer)
        info.Flags = _REPLACE_IF_EXISTS_AND_POSIX
        info.FileNameLength = len(name)
        ctypes.memmove(ctypes.addressof(buffer) + _RenameInfo.FileName.offset, name, len(name))
        if _kernel.SetFileInformationByHandle(handle, _FILE_RENAME_INFO_EX, buffer, size):
            return True
        code = ctypes.get_last_error()
        if code in _UNSUPPORTED:
            return False
        raise _error(code, source, target)
    finally:
        _kernel.CloseHandle(handle)
