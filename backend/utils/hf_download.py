"""HuggingFace 流式下载公共模块。

从 tools/download_anima_model.py 提取的通用 HF 下载核心，供后端多处复用：
  - backend/server/api.py（Anima 模型下载）
  - backend/tagger/tagger_download.py（tagger 模型下载）
  - tools/download_anima_model.py（Anima CLI 薄封装）
  - tools/flash_attention.py / tools/moss_acceleration.py（预编译轮子下载）

特性：
  - requests 流式下载（绕开 hf_hub_download 在 hf 0.34.3 + hf_xet 下拿不到进度的坑）
  - 多分块并发（Range）+ 续传（.partN/.partial）+ 自动端点选路与低速切源回退
  - 进度/速度精确计算，写入外部共享 progress dict（供实时任务快照读取）
  - rich Progress 进度条（朴素 ASCII #/. 风格，经 make_progress_bar() 统一构造）

公共 API：
  - download_url_with_fallback(urls, dest, ...) -> Path
  - download_hf_file(repo_id, hf_path, dest, *, progress, on_log, on_progress, progress_lock, revision) -> Path
  - make_progress_bar(console=None) -> rich.progress.Progress
"""
from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional, Sequence
from urllib.parse import urlsplit

from tools.network_mirror import (
    hf_resolve_urls,
    invalidate_hf_cache,
)


# ── 下载参数 ──────────────────────────────────────────
_CHUNK = 256 * 1024               # 256 KB，弱网时更快落盘并刷新进度
_COPY_BUF = 8 * 1024 * 1024       # 合并分块时的读写缓冲
_CONNECT_TIMEOUT = 2              # 单次连接等待；失败直接换源，不叠加内部重试
_READ_TIMEOUT = 5                 # 连续无数据等待，不限制正常传输的总时长
_HEAD_TIMEOUT = (2, 2)            # 元信息探测也快速失败

# 低速停滞保护（仅在还有备用源时生效）
_MIN_SPEED_BYTES = 50 * 1024      # 50 KB/s
_LOW_SPEED_WINDOW = 10.0          # 连续低速 10s 则保留进度并切换备用源

# 多线程分块下载
_MAX_PARTS = 8                    # 最多 8 个并发分块
_PART_MIN = 32 * 1024 * 1024      # 单分块最小 32MB，文件更小则单线程
_REPORT_INTERVAL = 0.3            # 进度条 / 共享 progress 刷新间隔（秒）


class IntegrityError(IOError):
    """下载内容完整性错误（大小校验失败 / 坏分块 / 内容截断 / 校验值不匹配）。

    与普通网络错误区分：端点切换时遇到 IntegrityError 才清理已下的 .partN/
    .partial（坏数据不能续传），普通网络瞬断则保留以供下个端点跨源续传——
    否则弱网下每个端点都断在半路会反复清零，永远下不完。
    """


class _StallError(IOError):
    """下载速度持续过低，保留已落盘分块并切换到下一个备用源续传。"""


def _auth_headers() -> dict[str, str]:
    """附加 HF token 头（若存在）。"""
    # Range 和磁盘大小均按原始字节计算，不能拿 gzip 长度校验 requests 解压后的内容。
    headers: dict[str, str] = {"Accept-Encoding": "identity"}
    token = None
    try:
        from huggingface_hub import get_token
        token = get_token()
    except Exception:
        pass
    if not token:
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _reject_html_response(response, *, allow_html: bool = False) -> None:
    if allow_html:
        return
    content_type = (response.headers.get("content-type") or "").lower()
    if "text/html" in content_type:
        raise IntegrityError("Unexpected HTML response / 收到非预期 HTML 页面")


def _human_bytes(n: float) -> str:
    """字节数 → 人类可读（保留 2 位，G/M 为主）。"""
    gb = n / (1024 ** 3)
    if gb >= 1:
        return f"{gb:.2f}G"
    mb = n / (1024 ** 2)
    if mb >= 1:
        return f"{mb:.2f}M"
    kb = n / 1024
    return f"{kb:.1f}K"


def _format_progress_line(filename: str, pct: int, downloaded: int,
                          total: int, speed: float) -> str:
    """构造单行控制台进度条（供 \\r 原地刷新）。纯 ASCII，兼容 Windows cmd。"""
    width = 20
    if total > 0:
        filled = max(0, min(width, int(round(width * pct / 100))))
        bar = "#" * filled + "." * (width - filled)
        pct_s = f"{pct:3d}%"
        return (f"{filename} [{bar}] {pct_s} "
                f"{_human_bytes(downloaded)}/{_human_bytes(total)} {speed:5.1f}MB/s")
    name = filename if len(filename) <= 24 else filename[:23] + "…"
    return f"{name} {_human_bytes(downloaded)} {speed:5.1f}MB/s"


def _head_total(url: str, headers: dict[str, str]) -> int:
    """只探测一次：无长度或不支持 HEAD 时直接 GET，连接失败交给端点回退。"""
    import requests
    with requests.head(url, headers=headers, allow_redirects=True,
                       timeout=_HEAD_TIMEOUT) as h:
        if h.status_code in (405, 501):
            return 0
        h.raise_for_status()
        _reject_html_response(h)
        if h.status_code in (200, 206) and h.headers.get("content-encoding", "identity") == "identity":
            cr = h.headers.get("content-range") or ""
            if "/" in cr:
                try:
                    return int(cr.rsplit("/", 1)[-1])
                except ValueError:
                    pass
            cl = h.headers.get("content-length")
            if cl:
                try:
                    return int(cl)
                except ValueError:
                    pass
    return 0


class _RangeUnsupported(Exception):
    """服务器忽略 Range，应停止分块并切回一次完整 GET。"""


def _range_response(response, start: int, end: int | None = None) -> int:
    """校验续传偏移，避免把不同区间或压缩数据拼进已有文件。"""
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
    if (not match or int(match[1]) != start or int(match[2]) < start
            or int(match[2]) >= int(match[3])
            or (end is not None and int(match[2]) != end)
            or response.headers.get("content-encoding", "identity") != "identity"):
        raise IntegrityError("Invalid download range / 下载续传范围不匹配")
    return int(match[3])


def _verify_and_promote(
    partial: Path,
    dest: Path,
    *,
    expected_size: int | None,
    expected_sha256: str | None,
    stream_total: int,
    filename: str,
) -> int:
    """校验大小与可选 SHA-256，全部通过后原子替换目标文件。"""
    got = partial.stat().st_size
    target_size = expected_size if expected_size is not None else stream_total
    if target_size > 0 and got != target_size:
        raise IntegrityError(f"{filename}: size mismatch / 大小不匹配 {got} != {target_size}")
    if expected_sha256:
        with open(partial, "rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest.lower() != expected_sha256.lower():
            raise IntegrityError(f"{filename}: sha256 mismatch / 校验值不匹配")
    os.replace(partial, dest)
    return got


def _download_part(url: str, part_file: Path, range_start: int, range_end: int,
                   part_index: int, part_size: int, part_bytes: list[int],
                   stop: threading.Event, expected_total: int, headers: dict[str, str]) -> None:
    """每块仅尝试一次；失败由端点层续传，其他线程收到停止信号即退出。"""
    import requests
    if stop is not None and stop.is_set():
        raise RuntimeError("Download cancelled after another part failed")
    done = part_file.stat().st_size if part_file.exists() else 0
    if done > part_size:
        done = 0
    part_bytes[part_index] = done
    if done == part_size:
        return
    start = range_start + done
    range_headers = {**headers, "Range": f"bytes={start}-{range_end}"}
    with requests.get(url, headers=range_headers, stream=True, allow_redirects=True,
                      timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
        if r.status_code == 416:
            raise IntegrityError("Download range rejected / 下载范围已失效")
        r.raise_for_status()
        _reject_html_response(r)
        if r.status_code == 200:
            raise _RangeUnsupported()
        actual_total = _range_response(r, start, range_end)
        if expected_total is not None and actual_total != expected_total:
            raise IntegrityError("Download size changed between HEAD and GET / 下载文件大小已变化")
        with open(part_file, "ab" if done else "wb") as f:
            for chunk in r.iter_content(chunk_size=_CHUNK):
                if stop is not None and stop.is_set():
                    raise RuntimeError("Download cancelled after another part failed")
                if not chunk:
                    continue
                if part_bytes[part_index] + len(chunk) > part_size:
                    raise IntegrityError("Download part exceeds requested size")
                f.write(chunk)
                part_bytes[part_index] += len(chunk)
    got = part_file.stat().st_size
    if got != part_size:
        raise IntegrityError(f"part {part_index} short: {got}/{part_size}")


def _split_ranges(total: int, n_parts: int) -> list[tuple[int, int]]:
    """把 [0, total) 均分为 n_parts 个闭区间字节范围。"""
    base = total // n_parts
    ranges = []
    for i in range(n_parts):
        rs = i * base
        re_ = (total - 1) if i == n_parts - 1 else (rs + base - 1)
        ranges.append((rs, re_))
    return ranges


def _below_speed_window(samples: deque[tuple[float, int]], now: float, downloaded: int) -> bool:
    """Use cumulative bytes over a full window so chunk boundaries do not reset the timer."""
    samples.append((now, downloaded))
    cutoff = now - _LOW_SPEED_WINDOW
    while len(samples) > 1 and samples[1][0] <= cutoff:
        samples.popleft()
    start, previous = samples[0]
    return start <= cutoff and downloaded - previous < _MIN_SPEED_BYTES * (now - start)


def _download_single_stream(url: str, dest: Path, partial: Path,
                            progress: dict, lock: threading.Lock,
                            filename: str, file_index: int, file_total: int,
                            on_log: Optional[Callable[[str], None]],
                            on_progress: Optional[Callable[[str], None]],
                            *,
                            headers: dict[str, str],
                            allow_stall_abort: bool = False,
                            expected_size: Optional[int] = None,
                            expected_sha256: Optional[str] = None) -> Path:
    """小文件或不支持分块时单连接下载；失败保留 partial，交给下一端点续传。"""
    import requests

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    existing = partial.stat().st_size if partial.exists() else 0
    if existing > 0:
        headers = {**headers, "Range": f"bytes={existing}-"}

    with requests.get(url, headers=headers, stream=True, allow_redirects=True,
                      timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
        # 416 表示续传范围已失效。文件大小或版本变化时也会触发这个错误。
        if r.status_code == 416:
            raise IntegrityError("Download resume rejected / 本地续传范围已失效")
        r.raise_for_status()
        _reject_html_response(r, allow_html=dest.suffix.lower() in (".html", ".htm"))
        if r.status_code == 206:
            stream_total = _range_response(r, existing)
        else:
            existing = 0  # 服务端忽略续传，完整响应必须覆盖写入
            try:
                stream_total = int(r.headers.get("content-length", 0))
            except ValueError:
                stream_total = 0
            if r.headers.get("content-encoding", "identity") != "identity":
                stream_total = 0
        if expected_size is not None and stream_total > 0 and stream_total != expected_size:
            raise IntegrityError(f"{filename}: size mismatch / 大小不匹配 {stream_total} != {expected_size}")
        downloaded = existing
        last_rep = time.monotonic()
        last_bytes = downloaded
        samples = deque([(last_rep, downloaded)])
        effective_total = stream_total or (expected_size or 0)
        with lock:
            progress.update({"downloaded": downloaded, "total": effective_total,
                             "speed": 0.0, "phase": "downloading"})
        with open(partial, "ab" if existing else "wb") as f:
            for chunk in r.iter_content(chunk_size=_CHUNK):
                if not chunk:
                    continue
                if effective_total > 0 and downloaded + len(chunk) > effective_total:
                    raise IntegrityError(f"{filename}: download exceeds expected size")
                f.write(chunk)
                downloaded += len(chunk)
                now = time.monotonic()
                dt = now - last_rep
                if dt >= _REPORT_INTERVAL:
                    speed_bps = (downloaded - last_bytes) / max(dt, 1e-6)
                    speed = speed_bps / (1024 ** 2)
                    with lock:
                        progress.update({"downloaded": downloaded, "speed": round(speed, 2)})
                    if on_progress:
                        try:
                            pct = int(downloaded * 100 / effective_total) if effective_total > 0 else -1
                            on_progress(_format_progress_line(filename, pct, downloaded, effective_total, speed))
                        except Exception:
                            pass
                    if (allow_stall_abort and downloaded != effective_total
                            and _below_speed_window(samples, now, downloaded)):
                        raise _StallError(f"{filename}: sustained low speed")
                    last_rep, last_bytes = now, downloaded

    got = _verify_and_promote(
        partial, dest,
        expected_size=expected_size,
        expected_sha256=expected_sha256,
        stream_total=stream_total,
        filename=filename,
    )
    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": got, "total": effective_total or got,
                         "speed": 0.0, "phase": "file_done"})
    _log(f"{filename}: 100% | {_human_bytes(got)}/{_human_bytes(effective_total or got)} [Done / 完成]")
    return dest


def download_url_with_fallback(
    urls: Sequence[str],
    dest: Path,
    *,
    progress: dict | None = None,
    lock: Optional[threading.Lock] = None,
    on_log: Optional[Callable[[str], None]] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    file_index: int = 0,
    file_total: int = 1,
    label: Optional[str] = None,
    expected_size: Optional[int] = None,
    expected_sha256: Optional[str] = None,
    on_source_fail: Optional[Callable[[str, Exception], None]] = None,
    headers: dict[str, str] | None = None,
) -> Path:
    """按序尝试多个 URL 下载同一文件（多分块并发 + 续传 + 低速切源 + 进度上报）。"""
    if not urls:
        raise ValueError("urls must not be empty / urls 不能为空")

    lock = lock if lock is not None else threading.Lock()
    progress = progress if progress is not None else {}
    label = label or dest.name
    request_headers = {"Accept-Encoding": "identity", **(headers or {})}

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    last_err: Exception | None = None
    for u_idx, url in enumerate(urls):
        is_last = u_idx == len(urls) - 1
        source = urlsplit(url).netloc or url
        with lock:
            progress.update({"source": source, "source_index": u_idx + 1,
                             "source_total": len(urls), "phase": "connecting"})
        _log(f"{label}: connecting to {source} / 正在连接 {source} ({u_idx + 1}/{len(urls)})")
        try:
            result = _download_one_endpoint(
                url, dest, progress, lock, on_log, on_progress,
                file_index=file_index, file_total=file_total,
                headers=request_headers,
                allow_stall_abort=not is_last,
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            )
            cleanup_temp(dest)
            return result
        except IntegrityError as e:
            last_err = e
            cleanup_temp(dest)
            if on_source_fail:
                try: on_source_fail(url, e)
                except Exception: pass
            if is_last:
                raise
            _log(f"{label}: source {source} integrity error, cleared and restarting from next source / 源 {source} 完整性错误，已清理并切换重下...")
            continue
        except Exception as e:
            last_err = e
            if on_source_fail:
                try: on_source_fail(url, e)
                except Exception: pass
            if is_last:
                raise
            _log(f"{label}: source {source} interrupted ({type(e).__name__}), keeping progress and resuming from next source / 源 {source} 中断（{type(e).__name__}），保留进度切换备用源续传...")
    raise last_err if last_err else RuntimeError("download failed")


def download_hf_file(repo_id: str, hf_path: str, dest: Path, *,
                     progress: dict | None = None,
                     lock: Optional[threading.Lock] = None,
                     on_log: Optional[Callable[[str], None]] = None,
                     on_progress: Optional[Callable[[str], None]] = None,
                     revision: str = "main",
                     file_index: int = 0, file_total: int = 1,
                     repo_type: str = "model",
                     expected_size: Optional[int] = None,
                     expected_sha256: Optional[str] = None) -> Path:
    """下载单个 HF 文件（自动选路 + 多分块并发 + 续传 + 低速切源 + 进度上报）。"""
    urls = hf_resolve_urls(
        repo_id, hf_path, revision=revision, repo_type=repo_type
    )
    return download_url_with_fallback(
        urls, dest,
        progress=progress, lock=lock,
        on_log=on_log, on_progress=on_progress,
        file_index=file_index, file_total=file_total,
        label=hf_path,
        headers=_auth_headers(),
        expected_size=expected_size,
        expected_sha256=expected_sha256,
        on_source_fail=lambda _url, _err: invalidate_hf_cache(),
    )


def _download_one_endpoint(url: str, dest: Path, progress: dict, lock: threading.Lock,
                           on_log, on_progress, *,
                           file_index: int, file_total: int,
                           headers: dict[str, str],
                           allow_stall_abort: bool = False,
                           expected_size: Optional[int] = None,
                           expected_sha256: Optional[str] = None) -> Path:
    """对单个 URL 执行下载（多分块并发 + 续传 + 进度上报线程）。"""
    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    filename = dest.name
    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": 0, "total": 0,
                         "speed": 0.0, "phase": "connecting"})
    total = _head_total(url, headers)
    if expected_size is not None and total > 0 and total != expected_size:
        raise IntegrityError(f"{filename}: size mismatch / 大小不匹配 {total} != {expected_size}")
    partial = dest.with_suffix(dest.suffix + ".partial")

    if total < _PART_MIN:
        return _download_single_stream(
            url, dest, partial, progress, lock,
            filename, file_index, file_total, on_log, on_progress,
            headers=headers,
            allow_stall_abort=allow_stall_abort,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )

    n_parts = 1 if total < _PART_MIN else min(_MAX_PARTS, max(1, total // _PART_MIN))
    ranges = _split_ranges(total, n_parts)
    part_sizes = [re_ - rs + 1 for rs, re_ in ranges]
    part_files = [dest.with_suffix(dest.suffix + f".part{i}") for i in range(n_parts)]
    part_bytes: list[int] = [0] * n_parts

    for i, pf in enumerate(part_files):
        if pf.exists():
            sz = pf.stat().st_size
            part_bytes[i] = 0 if sz > part_sizes[i] else min(sz, part_sizes[i])

    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": sum(part_bytes),
                         "total": total, "speed": 0.0, "phase": "downloading"})

    stop = threading.Event()
    stall_err: list[Exception] = []

    def _report():
        last_bytes = sum(part_bytes)
        last_ts = time.monotonic()
        samples = deque([(last_ts, last_bytes)])
        while not stop.wait(_REPORT_INTERVAL):
            now = time.monotonic()
            cur = sum(part_bytes)
            dt = now - last_ts
            speed_bps = (cur - last_bytes) / max(dt, 1e-6)
            speed = speed_bps / (1024 ** 2)
            pct = int(cur * 100 / total) if total > 0 else 0
            with lock:
                progress.update({"filename": filename, "file_index": file_index,
                                 "file_total": file_total, "downloaded": cur, "total": total,
                                 "speed": round(speed, 2), "phase": "downloading"})
            if on_progress:
                try:
                    on_progress(_format_progress_line(filename, pct, cur, total, speed))
                except Exception:
                    pass
            if allow_stall_abort and cur < total and _below_speed_window(samples, now, cur):
                stall_err.append(_StallError(f"{filename}: sustained low speed"))
                stop.set()
                break
            last_bytes = cur
            last_ts = now

    reporter = threading.Thread(target=_report, daemon=True)
    reporter.start()

    try:
        with ThreadPoolExecutor(max_workers=n_parts) as ex:
            futs = [
                ex.submit(
                    _download_part, url, part_files[i], rs, re_,
                    i, part_sizes[i], part_bytes, stop, total, headers,
                )
                for i, (rs, re_) in enumerate(ranges)
            ]
            try:
                for f in as_completed(futs):
                    f.result()
            except Exception:
                stop.set()
                _log(f"{filename}: stopping remaining parts / 正在停止其余分块连接")
                for f in futs:
                    f.cancel()
                if stall_err:
                    raise stall_err[0]
                raise
        if stall_err:
            raise stall_err[0]
        stop.set()
        reporter.join(timeout=2)

        with lock:
            progress.update({"downloaded": total, "speed": 0.0, "phase": "assembling"})
        with open(partial, "wb") as out:
            for pf in part_files:
                with open(pf, "rb") as inp:
                    while True:
                        buf = inp.read(_COPY_BUF)
                        if not buf:
                            break
                        out.write(buf)
                try:
                    os.unlink(pf)
                except Exception:
                    pass
        got = _verify_and_promote(
            partial, dest,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
            stream_total=total,
            filename=filename,
        )
        with lock:
            progress.update({"downloaded": got, "speed": 0.0, "phase": "file_done"})
        if on_progress:
            try:
                on_progress(_format_progress_line(filename, 100, got, total, 0.0))
            except Exception:
                pass
        _log(f"{filename}: 100% | {_human_bytes(got)}/{_human_bytes(total)} [Done / 完成]")
        return dest
    except _RangeUnsupported:
        stop.set()
        reporter.join(timeout=2)
        _log(f"{filename}: range unsupported, using one connection / 源不支持分块，改用单连接")
        result = _download_single_stream(
            url, dest, partial, progress, lock,
            filename, file_index, file_total, on_log, on_progress,
            headers=headers,
            allow_stall_abort=allow_stall_abort,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )
        cleanup_temp(dest)
        return result
    except Exception:
        stop.set()
        reporter.join(timeout=2)
        raise


def cleanup_temp(dest: Path) -> None:
    """删除某文件的所有临时分块 / .partial（失败收尾，避免孤儿文件）。"""
    try:
        partial = dest.with_suffix(dest.suffix + ".partial")
        if partial.exists():
            os.unlink(partial)
        for i in range(_MAX_PARTS):
            pf = dest.with_suffix(dest.suffix + f".part{i}")
            if pf.exists():
                os.unlink(pf)
    except Exception:
        pass


# ── rich Progress 进度条（朴素 ASCII 风格，统一构造）──────────
def make_progress_bar(console=None):
    """返回配好朴素 ASCII 列的 rich Progress 实例。

    列：描述 | #/. 进度条(24格) | 百分比 | 已下/总量 | 速度
    total 未知时百分比留空、已下/总量只显示已下（避免 /? 占位）。
    api.py 和 tagger_download.py 共用此工厂，消除重复的列类定义。
    """
    from backend.log import COLORS, console as app_console
    from rich.progress import (BarColumn, Progress, ProgressColumn,
                               TextColumn, TransferSpeedColumn)
    from rich.text import Text
    from rich import filesize

    class _PlainBarColumn(BarColumn):
        """纯 ASCII 进度条：# 已完成 / . 待下载，无彩色填充。"""
        def render(self, task):
            if task.total is None or task.total == 0:
                return Text("." * 24, style=COLORS["muted"])
            pct = max(0.0, min(1.0, task.completed / task.total))
            filled = int(round(24 * pct))
            return Text("#" * filled + "." * (24 - filled), style=COLORS["muted"])

    class _PlainDownloadColumn(ProgressColumn):
        """已下载/总大小；total 未知时只显示已下载，避免 437.3/? 的丑占位。"""
        def render(self, task):
            completed = int(task.completed)
            base = int(task.total) if task.total else completed
            unit, suffix = filesize.pick_unit_and_suffix(
                base, ["bytes", "kB", "MB", "GB", "TB"], 1000)
            precision = 0 if unit == 1 else 1
            done_str = f"{completed / unit:,.{precision}f}"
            if task.total:
                total_str = f"{int(task.total) / unit:,.{precision}f}"
                return Text(f"{done_str}/{total_str} {suffix}", style="progress.download")
            return Text(f"{done_str} {suffix}", style="progress.download")

    class _PlainPctColumn(ProgressColumn):
        """百分比；total 未知时留空（避免 --% 花哨）。"""
        def render(self, task):
            if task.total is None or task.total == 0:
                return Text("   ", style="progress.percentage")
            pct = max(0, min(100, int(task.completed * 100 / task.total)))
            return Text(f"{pct:3d}%", style="progress.percentage")

    return Progress(
        TextColumn("{task.description}"),
        _PlainBarColumn(bar_width=24),
        _PlainPctColumn(),
        _PlainDownloadColumn(),
        TransferSpeedColumn(),
        console=console or app_console,
        transient=True,    # 完成后自动清除进度条，由日志行承接最终状态
        expand=False,
    )
