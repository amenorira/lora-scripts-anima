"""HuggingFace 流式下载公共模块。

从 tools/download_anima_model.py 提取的通用 HF 下载核心，供后端多处复用：
  - backend/server/api.py（Anima 模型下载）
  - backend/tagger/tagger_download.py（tagger 模型下载）
  - tools/download_anima_model.py（Anima CLI 薄封装）

特性：
  - requests 流式下载（绕开 hf_hub_download 在 hf 0.34.3 + hf_xet 下拿不到进度的坑）
  - 多分块并发（Range）+ 续传（.partN/.partial）+ 端点回退（主端点失败切 hf-mirror.com）
  - 进度/速度精确计算，写入外部共享 progress dict（供前端轮询）
  - rich Progress 进度条（朴素 ASCII #/. 风格，经 make_progress_bar() 统一构造）

公共 API：
  - download_hf_file(repo_id, hf_path, dest, *, progress, on_log, on_progress, progress_lock, revision) -> Path
  - make_progress_bar(console=None) -> rich.progress.Progress
"""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional


# ── 下载参数 ──────────────────────────────────────────
_CHUNK = 1024 * 1024              # 1 MB / chunk
_COPY_BUF = 8 * 1024 * 1024       # 合并分块时的读写缓冲
_CONNECT_TIMEOUT = 5              # 连接建立超时（5s 够判断通不通，短了快切镜像）
_READ_TIMEOUT = 60
_HEAD_TIMEOUT = (5, 5)            # HEAD/探测请求超时（连接5s，读取5s）
_MAX_RETRIES = 1                  # 单分块网络错误重试次数（端点级切换兜底，分块只需快速失败）
_RETRY_BACKOFF = 1.0              # 重试退避基数（秒）

# 多线程分块下载
_MAX_PARTS = 8                    # 最多 8 个并发分块
_PART_MIN = 32 * 1024 * 1024      # 单分块最小 32MB，文件更小则单线程
_REPORT_INTERVAL = 0.3            # 进度条 / 共享 progress 刷新间隔（秒）


def _hf_endpoint() -> str:
    """读取 HF_ENDPOINT（如 https://hf-mirror.com），默认 huggingface.co。"""
    return os.environ.get("HF_ENDPOINT") or "https://huggingface.co"


# 备用端点：主端点（HF_ENDPOINT 或 huggingface.co）连不上/超时时自动回退。
# hf-mirror.com 是国内常用镜像，对大文件稳定性明显优于直连 huggingface.co。
# 若用户已设 HF_ENDPOINT=hf-mirror.com，则不再重复加入回退列表。
_FALLBACK_ENDPOINTS: list[str] = ["https://hf-mirror.com"]


def _endpoints_for_download() -> list[str]:
    """返回下载端点优先级列表：主端点在前，备用端点去重后追加。"""
    main = _hf_endpoint()
    eps = [main]
    for ep in _FALLBACK_ENDPOINTS:
        if ep.rstrip("/") not in (m.rstrip("/") for m in eps):
            eps.append(ep)
    return eps


def _auth_headers() -> dict[str, str]:
    """附加 HF token 头（若存在）。"""
    headers: dict[str, str] = {}
    token = None
    try:
        from huggingface_hub import HfFolder
        token = HfFolder.get_token()
    except Exception:
        pass
    if not token:
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _resolve_url(repo_id: str, hf_path: str, revision: str = "main",
                 endpoint: Optional[str] = None) -> str:
    """构造 HF resolve 下载地址。endpoint 为空时用 HF_ENDPOINT/默认。"""
    from huggingface_hub import hf_hub_url
    return hf_hub_url(
        repo_id=repo_id, filename=hf_path,
        repo_type="model", revision=revision,
        endpoint=endpoint or _hf_endpoint(),
    )


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
    # total 未知：不画百分比条，只显示已下字节 + 速度
    name = filename if len(filename) <= 24 else filename[:23] + "…"
    return f"{name} {_human_bytes(downloaded)} {speed:5.1f}MB/s"


def _head_total(url: str) -> int:
    """取文件总大小（bytes）；失败返回 0。

    优先 HEAD（轻量）；HF 对短时间连续 HEAD 可能限流（返回非 200），
    此时退化为 Range GET bytes=0-0，从 content-range 解析 total——
    Range GET 必返回 content-range，且比 HEAD 更不易被限流。
    超时设短（连接10s/读取8s）：拿不到就快速返回 0，走单连接流式，
    至少能开始下字节，避免长时间卡在"连接中"。
    """
    import requests
    headers = _auth_headers()
    # 1) HEAD
    try:
        h = requests.head(url, headers=headers, allow_redirects=True,
                          timeout=_HEAD_TIMEOUT)
        if h.status_code in (200, 206):
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
    except Exception:
        pass
    # 2) 兜底：Range GET 1 字节
    try:
        rg = dict(headers); rg["Range"] = "bytes=0-0"
        r = requests.get(url, headers=rg, stream=True, allow_redirects=True,
                         timeout=_HEAD_TIMEOUT)
        try:
            cr = r.headers.get("content-range") or ""
            if "/" in cr:
                try:
                    return int(cr.rsplit("/", 1)[-1])
                except ValueError:
                    pass
        finally:
            r.close()
    except Exception:
        pass
    return 0


def _download_part(url: str, part_file: Path, range_start: int, range_end: int,
                   part_index: int, part_size: int, part_bytes: list[int]) -> None:
    """下载一个字节范围到 part_file，支持续传。更新 part_bytes[part_index]。

    part_bytes[part_index] 仅由本分块线程读写（单写者），无需加锁。
    失败重试 _MAX_RETRIES 次（指数退避）；重试时按 part_file 实际大小续传。
    """
    import requests

    def _existing() -> int:
        sz = part_file.stat().st_size if part_file.exists() else 0
        return 0 if sz > part_size else sz  # 超出 part_size 视为损坏，重头下

    last_err: Exception | None = None
    for attempt in range(_MAX_RETRIES + 1):
        done = _existing()
        if done >= part_size:
            part_bytes[part_index] = part_size
            return
        part_bytes[part_index] = done
        start = range_start + done
        headers = dict(_auth_headers())
        headers["Range"] = f"bytes={start}-{range_end}"
        append = done > 0
        try:
            with requests.get(url, headers=headers, stream=True, allow_redirects=True,
                              timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
                if r.status_code == 416:
                    # 范围越界 → 该分块其实已完整
                    part_bytes[part_index] = part_size
                    return
                if r.status_code not in (200, 206):
                    r.raise_for_status()
                # 服务端忽略 Range（200）但本地已有 done → 不能续传，重头覆盖
                if r.status_code == 200 and append:
                    append = False
                    part_bytes[part_index] = 0
                mode = "ab" if append else "wb"
                with open(part_file, mode) as f:
                    for chunk in r.iter_content(chunk_size=_CHUNK):
                        if not chunk:
                            continue
                        f.write(chunk)
                        part_bytes[part_index] += len(chunk)
            got = part_file.stat().st_size
            if got >= part_size:
                part_bytes[part_index] = part_size
                return
            raise IOError(f"part {part_index} short: {got}/{part_size}")
        except Exception as e:
            last_err = e
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BACKOFF * (2 ** attempt))
            else:
                raise
    raise last_err if last_err else RuntimeError("part download failed")


def _split_ranges(total: int, n_parts: int) -> list[tuple[int, int]]:
    """把 [0, total) 均分为 n_parts 个闭区间字节范围。"""
    base = total // n_parts
    ranges = []
    for i in range(n_parts):
        rs = i * base
        re_ = (total - 1) if i == n_parts - 1 else (rs + base - 1)
        ranges.append((rs, re_))
    return ranges


def _download_single_stream(url: str, dest: Path, partial: Path,
                            progress: dict, lock: threading.Lock,
                            filename: str, file_index: int, file_total: int,
                            on_log: Optional[Callable[[str], None]],
                            on_progress: Optional[Callable[[str], None]]) -> Path:
    """total 未知时的单连接流式下载兜底。"""
    import requests

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    existing = partial.stat().st_size if partial.exists() else 0
    headers = dict(_auth_headers())
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    last_err = None
    for attempt in range(_MAX_RETRIES + 1):
        try:
            existing = partial.stat().st_size if partial.exists() else 0
            headers = dict(_auth_headers())
            append = False
            if existing > 0:
                headers["Range"] = f"bytes={existing}-"
                append = True
            with requests.get(url, headers=headers, stream=True, allow_redirects=True,
                              timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
                if r.status_code == 416 and existing > 0:
                    os.replace(str(partial), str(dest))
                    with lock:
                        progress.update({"filename": filename, "file_index": file_index,
                                         "file_total": file_total, "downloaded": existing,
                                         "total": existing, "speed": 0.0, "phase": "file_done"})
                    return dest
                if r.status_code not in (200, 206):
                    r.raise_for_status()
                if r.status_code == 200 and append:
                    existing = 0
                    append = False
                # 从 GET 响应头补全 total（HEAD 没拿到时这里通常能拿到）：
                #   206 → content-range: bytes <s>-<e>/<total>
                #   200 → content-length = total
                stream_total = 0
                if r.status_code == 206:
                    cr = r.headers.get("content-range") or ""
                    if "/" in cr:
                        try: stream_total = int(cr.rsplit("/", 1)[-1])
                        except ValueError: pass
                if stream_total <= 0:
                    cl = r.headers.get("content-length")
                    if cl:
                        try: stream_total = int(cl) + (existing if r.status_code == 206 else 0)
                        except ValueError: pass
                downloaded = existing
                t0 = time.time()
                last_rep = t0
                last_bytes = downloaded
                with open(partial, "ab" if append else "wb") as f:
                    for chunk in r.iter_content(chunk_size=_CHUNK):
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        now = time.time()
                        if now - last_rep >= _REPORT_INTERVAL:
                            dt = now - t0
                            speed = (downloaded - existing) / max(dt, 1e-6) / (1024 ** 2)
                            with lock:
                                progress.update({"filename": filename, "file_index": file_index,
                                                 "file_total": file_total, "downloaded": downloaded,
                                                 "total": stream_total, "speed": round(speed, 2),
                                                 "phase": "downloading"})
                            if on_progress:
                                try: on_progress(_format_progress_line(filename, -1, downloaded, stream_total, speed))
                                except Exception: pass
                            last_rep = now
                            last_bytes = downloaded
            os.replace(str(partial), str(dest))
            got = dest.stat().st_size
            with lock:
                progress.update({"filename": filename, "file_index": file_index,
                                 "file_total": file_total, "downloaded": got, "total": stream_total or got,
                                 "speed": 0.0, "phase": "file_done"})
            _log(f"{filename}: 100% | {_human_bytes(got)}/{_human_bytes(stream_total or got)} [完成 / Done]")
            return dest
        except Exception as e:
            last_err = e
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BACKOFF * (2 ** attempt))
            else:
                raise
    raise last_err if last_err else RuntimeError("download failed")


def download_hf_file(repo_id: str, hf_path: str, dest: Path, *,
                     progress: dict | None = None,
                     lock: Optional[threading.Lock] = None,
                     on_log: Optional[Callable[[str], None]] = None,
                     on_progress: Optional[Callable[[str], None]] = None,
                     revision: str = "main",
                     file_index: int = 0, file_total: int = 1) -> Path:
    """下载单个 HF 文件（多分块并发 + 续传 + 进度上报 + 端点回退）。

    主端点（HF_ENDPOINT/huggingface.co）连不上/超时时自动切 hf-mirror.com 重试。
    total 已知 → 多分块；未知 → 单连接兜底（从 GET 响应头补全 total）。
    进度写入共享 progress dict（线程安全），供前端轮询。

    参数:
        repo_id: HF 仓库 id（如 circlestone-labs/Anima）
        hf_path: 仓库内文件路径
        dest: 落盘目标路径
        progress: 线程间共享的进度 dict；每次更新原地覆盖
        lock: 保护 progress 的锁（可传入后端共享锁，使读取端与之互斥）
        on_log: 事件日志回调（开始/完成/失败/端点切换），换行打印
        on_progress: 单行进度回调（百分比+速度），供控制台 \\r 或 rich Progress
        revision: HF revision，默认 main
        file_index/file_total: 批量下载时的序号/总数，写入 progress 供前端显示

    返回最终落盘 Path；失败抛异常。
    """
    lock = lock if lock is not None else threading.Lock()
    progress = progress if progress is not None else {}

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    endpoints = _endpoints_for_download()
    last_err: Exception | None = None
    for ep_idx, endpoint in enumerate(endpoints):
        url = _resolve_url(repo_id, hf_path, revision=revision, endpoint=endpoint)
        is_last = ep_idx == len(endpoints) - 1
        try:
            return _download_one_endpoint(
                url, dest, progress, lock, on_log, on_progress,
                file_index=file_index, file_total=file_total,
            )
        except Exception as e:
            last_err = e
            # 清理本端点尝试留下的临时分块，避免下个端点续传坏数据
            cleanup_temp(dest)
            if is_last:
                raise
            _log(f"{hf_path}: 端点 / Endpoint {endpoint} 失败 / failed ({type(e).__name__}), 切换备用源 / switching to fallback...")
    raise last_err if last_err else RuntimeError("download failed")


def _download_one_endpoint(url: str, dest: Path, progress: dict, lock: threading.Lock,
                           on_log, on_progress, *,
                           file_index: int, file_total: int) -> Path:
    """对单个 URL 执行下载（多分块并发 + 续传 + 进度上报线程）。

    total 已知 → 多分块；未知 → 单连接兜底。返回最终落盘 Path；失败抛异常。
    """
    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    # filename 用于 progress 显示，取 dest 文件名
    filename = dest.name
    total = _head_total(url)
    partial = dest.with_suffix(dest.suffix + ".partial")

    # total 未知 → 单连接
    if total <= 0:
        return _download_single_stream(url, dest, partial, progress, lock,
                                       filename, file_index, file_total, on_log, on_progress)

    # 决定分块数
    n_parts = 1 if total < _PART_MIN else min(_MAX_PARTS, max(1, total // _PART_MIN))
    ranges = _split_ranges(total, n_parts)
    part_sizes = [re_ - rs + 1 for rs, re_ in ranges]
    part_files = [dest.with_suffix(dest.suffix + f".part{i}") for i in range(n_parts)]
    part_bytes: list[int] = [0] * n_parts

    # 从已存在的 part 文件恢复进度（续传）
    for i, pf in enumerate(part_files):
        if pf.exists():
            sz = pf.stat().st_size
            part_bytes[i] = 0 if sz > part_sizes[i] else min(sz, part_sizes[i])

    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": sum(part_bytes),
                         "total": total, "speed": 0.0, "phase": "downloading"})

    # 进度上报线程：聚合各分块字节 → 更新共享 progress + 控制台进度
    stop = threading.Event()

    def _report():
        last_bytes = sum(part_bytes)
        last_ts = time.time()
        while not stop.wait(_REPORT_INTERVAL):
            now = time.time()
            cur = sum(part_bytes)
            dt = now - last_ts
            speed = (cur - last_bytes) / max(dt, 1e-6) / (1024 ** 2)
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
            last_bytes = cur
            last_ts = now

    reporter = threading.Thread(target=_report, daemon=True)
    reporter.start()

    try:
        with ThreadPoolExecutor(max_workers=n_parts) as ex:
            futs = [ex.submit(_download_part, url, part_files[i], rs, re_,
                              i, part_sizes[i], part_bytes)
                    for i, (rs, re_) in enumerate(ranges)]
            for f in as_completed(futs):
                f.result()  # 任意分块失败即抛出
        stop.set()
        reporter.join(timeout=2)

        # 最终上报 100%
        cur = sum(part_bytes)
        with lock:
            progress.update({"filename": filename, "file_index": file_index,
                             "file_total": file_total, "downloaded": cur, "total": total,
                             "speed": 0.0, "phase": "file_done"})
        if on_progress:
            try:
                on_progress(_format_progress_line(filename, 100, cur, total, 0.0))
            except Exception:
                pass

        # 合并分块 → dest（边合并边删 part，控制峰值磁盘占用）
        with open(dest, "wb") as out:
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
        # 清理可能残留的旧 .partial
        try:
            if partial.exists():
                os.unlink(partial)
        except Exception:
            pass

        got = dest.stat().st_size
        if got != total:
            raise IOError(f"大小不匹配: {got} != {total}")
        _log(f"{filename}: 100% | {_human_bytes(got)}/{_human_bytes(total)} [完成 / Done]")
        return dest
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
    from rich.progress import (BarColumn, Progress, ProgressColumn,
                               TextColumn, TransferSpeedColumn)
    from rich.text import Text
    from rich import filesize

    class _PlainBarColumn(BarColumn):
        """纯 ASCII 进度条：# 已完成 / . 待下载，无彩色填充。"""
        def render(self, task):
            if task.total is None or task.total == 0:
                return Text("." * 24, style="dim")
            pct = max(0.0, min(1.0, task.completed / task.total))
            filled = int(round(24 * pct))
            return Text("#" * filled + "." * (24 - filled), style="dim")

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
        console=console,
        transient=True,    # 完成后自动清除进度条，由日志行承接最终状态
        expand=False,
    )
