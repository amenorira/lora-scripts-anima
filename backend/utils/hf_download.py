"""HuggingFace 流式下载公共模块。

从 tools/download_anima_model.py 提取的通用 HF 下载核心，供后端多处复用：
  - backend/server/api.py（Anima 模型下载）
  - backend/tagger/tagger_download.py（tagger 模型下载）
  - tools/download_anima_model.py（Anima CLI 薄封装）

特性：
  - requests 流式下载（绕开 hf_hub_download 在 hf 0.34.3 + hf_xet 下拿不到进度的坑）
  - 多分块并发（Range）+ 续传（.partN/.partial）+ 端点回退（主端点失败切 hf-mirror.com）
  - 进度/速度精确计算，写入外部共享 progress dict（供实时任务快照读取）
  - rich Progress 进度条（朴素 ASCII #/. 风格，经 make_progress_bar() 统一构造）

公共 API：
  - download_hf_file(repo_id, hf_path, dest, *, progress, on_log, on_progress, progress_lock, revision) -> Path
  - make_progress_bar(console=None) -> rich.progress.Progress
"""
from __future__ import annotations

import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit


# ── 下载参数 ──────────────────────────────────────────
_CHUNK = 256 * 1024               # 256 KB，弱网时更快落盘并刷新进度
_COPY_BUF = 8 * 1024 * 1024       # 合并分块时的读写缓冲
_CONNECT_TIMEOUT = 2             # 单次连接等待；失败直接换源，不叠加内部重试
_READ_TIMEOUT = 5                # 连续无数据等待，不限制正常传输的总时长
_HEAD_TIMEOUT = (2, 2)           # 元信息探测也快速失败

# 多线程分块下载
_MAX_PARTS = 8                    # 最多 8 个并发分块
_PART_MIN = 32 * 1024 * 1024      # 单分块最小 32MB，文件更小则单线程
_REPORT_INTERVAL = 0.3            # 进度条 / 共享 progress 刷新间隔（秒）


class IntegrityError(IOError):
    """下载内容完整性错误（大小校验失败 / 坏分块 / 内容截断）。

    与普通网络错误区分：端点切换时遇到 IntegrityError 才清理已下的 .partN/
    .partial（坏数据不能续传），普通网络瞬断则保留以供下个端点跨源续传——
    否则弱网下每个端点都断在半路会反复清零，永远下不完。
    """


def _hf_endpoint() -> str:
    """读取 HF_ENDPOINT（如 https://hf-mirror.com），默认 huggingface.co。"""
    return os.environ.get("HF_ENDPOINT") or "https://huggingface.co"


# 首选端点不变，镜像和官方均可回退；自定义端点之后也会尝试这两个源。
_FALLBACK_ENDPOINTS: list[str] = ["https://hf-mirror.com", "https://huggingface.co"]


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
    # Range 和磁盘大小均按原始字节计算，不能拿 gzip 长度校验 requests 解压后的内容。
    headers: dict[str, str] = {"Accept-Encoding": "identity"}
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
                 endpoint: Optional[str] = None, repo_type: str = "model") -> str:
    """构造 HF resolve 下载地址。endpoint 为空时用 HF_ENDPOINT/默认。

    repo_type 决定地址里是否有 /datasets/ 前缀：模型仓库用 "model"（默认），
    数据集仓库必须传 "dataset"，否则会 404。"""
    from huggingface_hub import hf_hub_url
    return hf_hub_url(
        repo_id=repo_id, filename=hf_path,
        repo_type=repo_type, revision=revision,
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
    """只探测一次：无长度或不支持 HEAD 时直接 GET，连接失败交给端点回退。"""
    import requests
    with requests.head(url, headers=_auth_headers(), allow_redirects=True,
                       timeout=_HEAD_TIMEOUT) as h:
        if h.status_code in (405, 501):
            return 0
        h.raise_for_status()
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


def _download_part(url: str, part_file: Path, range_start: int, range_end: int,
                   part_index: int, part_size: int, part_bytes: list[int],
                   stop: threading.Event | None = None, expected_total: int | None = None) -> None:
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
    headers = _auth_headers()
    headers["Range"] = f"bytes={start}-{range_end}"
    with requests.get(url, headers=headers, stream=True, allow_redirects=True,
                      timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
        if r.status_code == 416:
            raise IntegrityError("Download range rejected / 下载范围已失效")
        r.raise_for_status()
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


def _download_single_stream(url: str, dest: Path, partial: Path,
                            progress: dict, lock: threading.Lock,
                            filename: str, file_index: int, file_total: int,
                            on_log: Optional[Callable[[str], None]],
                            on_progress: Optional[Callable[[str], None]]) -> Path:
    """小文件或不支持分块时单连接下载；失败保留 partial，交给下一端点续传。"""
    import requests

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    existing = partial.stat().st_size if partial.exists() else 0
    headers = dict(_auth_headers())
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    with requests.get(url, headers=headers, stream=True, allow_redirects=True,
                      timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
        # 416 不能证明本地文件完整；大小或版本变化都可能导致范围越界。
        if r.status_code == 416:
            raise IntegrityError("Download resume rejected / 本地续传范围已失效")
        r.raise_for_status()
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
        downloaded = existing
        last_rep = time.monotonic()
        last_bytes = downloaded
        with lock:
            progress.update({"downloaded": downloaded, "total": stream_total,
                             "speed": 0.0, "phase": "downloading"})
        with open(partial, "ab" if existing else "wb") as f:
            for chunk in r.iter_content(chunk_size=_CHUNK):
                if not chunk:
                    continue
                if stream_total > 0 and downloaded + len(chunk) > stream_total:
                    raise IntegrityError(f"{filename}: download exceeds expected size")
                f.write(chunk)
                downloaded += len(chunk)
                now = time.monotonic()
                if now - last_rep >= _REPORT_INTERVAL:
                    speed = (downloaded - last_bytes) / max(now - last_rep, 1e-6) / (1024 ** 2)
                    with lock:
                        progress.update({"downloaded": downloaded, "speed": round(speed, 2)})
                    if on_progress:
                        try:
                            pct = int(downloaded * 100 / stream_total) if stream_total > 0 else -1
                            on_progress(_format_progress_line(filename, pct, downloaded, stream_total, speed))
                        except Exception:
                            pass
                    last_rep, last_bytes = now, downloaded
    got = partial.stat().st_size
    if stream_total > 0 and got != stream_total:
        raise IntegrityError(f"{filename}: size mismatch / 大小不匹配 {got} != {stream_total}")
    os.replace(partial, dest)
    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": got, "total": stream_total or got,
                         "speed": 0.0, "phase": "file_done"})
    _log(f"{filename}: 100% | {_human_bytes(got)}/{_human_bytes(stream_total or got)} [Done / 完成]")
    return dest


def download_url_with_fallback(urls: list[str], dest: Path, *,
                               progress: dict | None = None,
                               lock: Optional[threading.Lock] = None,
                               on_log: Optional[Callable[[str], None]] = None,
                               on_progress: Optional[Callable[[str], None]] = None,
                               file_index: int = 0, file_total: int = 1,
                               label: Optional[str] = None) -> Path:
    """按序尝试多个 URL 下载同一文件（多分块并发 + 续传 + 进度上报）。

    urls: 按优先级排序的下载候选 URL 列表（端点回退 / 镜像代理变体均可）。
    前一个 URL 失败时按错误类型分别处理：
      - 网络瞬断 → 保留 .partN/.partial，下个端点跨源续传（弱网鲁棒性关键）；
      - 完整性错误 → 清理坏分块后从下个端点重头下（避免坏数据污染最终文件）。
    最后一个 URL 失败才抛异常。
    内部复用 _download_one_endpoint（URL 通用，非 HF 专属）。
    进度写入共享 progress dict（线程安全），供实时任务快照读取。

    参数:
        urls: 候选 URL 列表（至少 1 个）
        dest: 落盘目标路径
        progress: 线程间共享的进度 dict；每次更新原地覆盖
        lock: 保护 progress 的锁（可传入后端共享锁，使读取端与之互斥）
        on_log: 事件日志回调（开始/完成/失败/端点切换），换行打印
        on_progress: 单行进度回调（百分比+速度），供控制台 \\r 或 rich Progress
        file_index/file_total: 批量下载时的序号/总数，写入 progress 供前端显示
        label: 切换日志里显示的文件标识；默认取 dest.name

    返回最终落盘 Path；失败抛异常。
    """
    if not urls:
        raise ValueError("urls must not be empty / urls 不能为空")

    lock = lock if lock is not None else threading.Lock()
    progress = progress if progress is not None else {}
    label = label or dest.name

    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    last_err: Exception | None = None
    for u_idx, url in enumerate(urls):
        is_last = u_idx == len(urls) - 1
        source = urlsplit(url).netloc
        with lock:
            progress.update({"source": source, "source_index": u_idx + 1,
                             "source_total": len(urls), "phase": "connecting"})
        _log(f"{label}: connecting to {source} / 正在连接 {source} ({u_idx + 1}/{len(urls)})")
        try:
            result = _download_one_endpoint(
                url, dest, progress, lock, on_log, on_progress,
                file_index=file_index, file_total=file_total,
            )
            cleanup_temp(dest)
            return result
        except IntegrityError as e:
            # 坏数据：必须清理 .partN/.partial，否则下个端点会接着坏分块续传导致最终文件损坏
            last_err = e
            cleanup_temp(dest)
            if is_last:
                raise
            _log(f"{label}: source {url} integrity error, cleared and restarting from next source / 源 {url} 完整性错误，已清理并切换重下...")
            continue
        except Exception as e:
            last_err = e
            # 普通网络瞬断：保留 .partN/.partial，下个端点可跨源续传（弱网鲁棒性关键）——
            # 临时文件不绑定 URL，下一端点从已落盘的偏移继续，并校验返回区间。
            if is_last:
                raise
            _log(f"{label}: source {url} network error ({type(e).__name__}), keeping progress and resuming from next source / 源 {url} 网络中断（{type(e).__name__}），保留进度切换备用源续传...")
    raise last_err if last_err else RuntimeError("download failed")


def download_hf_file(repo_id: str, hf_path: str, dest: Path, *,
                     progress: dict | None = None,
                     lock: Optional[threading.Lock] = None,
                     on_log: Optional[Callable[[str], None]] = None,
                     on_progress: Optional[Callable[[str], None]] = None,
                     revision: str = "main",
                     file_index: int = 0, file_total: int = 1,
                     repo_type: str = "model") -> Path:
    """下载单个 HF 文件（多分块并发 + 续传 + 进度上报 + 端点回退）。

    首选 HF_ENDPOINT，失败后在官方和镜像之间回退，不在单个端点内部重试。
    大文件 → 多分块；小文件或未知大小 → 单连接（从 GET 响应头读取 total）。
    进度写入共享 progress dict（线程安全），供实时任务快照读取。

    本函数是 download_url_with_fallback 的 HF 专属薄封装：把 HF 端点列表解析成
    URL 列表后委托通用入口执行，端点回退语义不变。

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
        repo_type: "model"（默认）或 "dataset"，决定地址里是否有 /datasets/ 前缀

    返回最终落盘 Path；失败抛异常。
    """
    # HF 端点列表 → resolve URL 列表，交给通用下载入口（端点回退语义不变）
    urls = [
        _resolve_url(repo_id, hf_path, revision=revision, endpoint=endpoint, repo_type=repo_type)
        for endpoint in _endpoints_for_download()
    ]
    return download_url_with_fallback(
        urls, dest,
        progress=progress, lock=lock,
        on_log=on_log, on_progress=on_progress,
        file_index=file_index, file_total=file_total,
        label=hf_path,
    )


def _download_one_endpoint(url: str, dest: Path, progress: dict, lock: threading.Lock,
                           on_log, on_progress, *,
                           file_index: int, file_total: int) -> Path:
    """对单个 URL 执行下载（多分块并发 + 续传 + 进度上报线程）。

    大文件多分块，小文件或不支持 Range 时单连接。返回最终落盘 Path。
    """
    def _log(m):
        if on_log:
            try: on_log(m)
            except Exception: pass

    # filename 用于 progress 显示，取 dest 文件名
    filename = dest.name
    with lock:
        progress.update({"filename": filename, "file_index": file_index,
                         "file_total": file_total, "downloaded": 0, "total": 0,
                         "speed": 0.0, "phase": "connecting"})
    total = _head_total(url)
    partial = dest.with_suffix(dest.suffix + ".partial")

    # 小文件或 total 未知 → 单连接，以 GET 响应为准，避免旧 HEAD 缓存影响小 CSV。
    if total < _PART_MIN:
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
        last_ts = time.monotonic()
        while not stop.wait(_REPORT_INTERVAL):
            now = time.monotonic()
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
                              i, part_sizes[i], part_bytes, stop, total)
                    for i, (rs, re_) in enumerate(ranges)]
            try:
                for f in as_completed(futs):
                    f.result()
            except Exception:
                # 必须在退出 executor 等待线程之前通知停止，避免其他分块继续整份下载。
                stop.set()
                _log(f"{filename}: stopping remaining parts / 正在停止其余分块连接")
                for f in futs:
                    f.cancel()
                raise
        stop.set()
        reporter.join(timeout=2)

        with lock:
            progress.update({"downloaded": total, "speed": 0.0, "phase": "assembling"})
        # 合并到临时文件，校验通过后才替换正式文件。
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
        got = partial.stat().st_size
        if got != total:
            raise IntegrityError(f"Size mismatch / 大小不匹配: {got} != {total}")
        os.replace(partial, dest)
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
        result = _download_single_stream(url, dest, partial, progress, lock,
                                         filename, file_index, file_total, on_log, on_progress)
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
