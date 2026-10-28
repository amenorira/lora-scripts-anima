"""训练日志定位、尾部读取与索引分页。"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from backend.constants import OUTPUT_DIR
from backend.monitor.log_parser import clean_bytes, record_frames
from backend.monitor.log_index import indexed_slice


# ── 训练日志读取 ──────────────────────────────────────────

# 日志 tail 读取的最大字节数（实时快照读取用，约 20000+ 行）
_LOG_TAIL_BYTES = 2 * 1024 * 1024  # 2 MiB

def _normalized_log_lines(log_path: Path):
    """Yield every cleaned frame, including repeated renderings of one step."""
    with open(log_path, "rb") as handle:
        for raw_line in handle:
            for _, line in record_frames(raw_line):
                yield line


def read_clean_log_lines(path: Path) -> list[str]:
    """Read the same normalized rows used by full-log pagination."""
    return list(_normalized_log_lines(path))


def _tail_file(path: Path, max_bytes: int = _LOG_TAIL_BYTES) -> list[str]:
    """高效读取文件尾部内容（不加载整个文件到内存），并清理终端控制字符"""
    try:
        size = path.stat().st_size
        if size == 0:
            return []
        with open(path, "rb") as f:
            if size <= max_bytes:
                f.seek(0)
                raw = f.read()
            else:
                f.seek(size - max_bytes)
                # 丢弃第一行（可能是不完整的行）
                raw = f.read()
                first_newline = raw.find(b"\n")
                if first_newline >= 0:
                    raw = raw[first_newline + 1:]
        content = clean_bytes(raw)
        lines = content.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return lines
    except OSError:
        return []


_log_file_cache: dict[str, tuple[float, Path]] = {}
_log_file_cache_lock = threading.Lock()
_LOG_FILE_CACHE_TTL = 10.0
_LOG_FILE_CACHE_MAX = 50  # 防止无限增长


def find_train_log_path(task_id: str, output_dir: Path | None = None) -> Path | None:
    """查找训练日志文件路径（不读取内容）。
    优先从指定 output_dir 查找，否则扫描 output/ 子目录。结果写入路径缓存。"""
    now = time.time()
    task_id_short = task_id[:8]

    def _cache_log_path(tid: str, log_file: Path):
        """写入路径缓存（调用方需持有 _log_file_cache_lock）"""
        _log_file_cache[tid] = (now, log_file)
        if len(_log_file_cache) > _LOG_FILE_CACHE_MAX:
            oldest_key = min(_log_file_cache, key=lambda k: _log_file_cache[k][0])
            del _log_file_cache[oldest_key]

    # 先查缓存
    with _log_file_cache_lock:
        if task_id in _log_file_cache:
            cache_time, cached_path = _log_file_cache[task_id]
            if now - cache_time < _LOG_FILE_CACHE_TTL and cached_path.exists():
                return cached_path

    # 在指定目录查找
    if output_dir and output_dir.exists():
        for log_file in sorted(output_dir.glob(f"train_{task_id_short}*.log"),
                               key=lambda p: p.stat().st_mtime, reverse=True):
            if log_file.stat().st_size > 0:
                with _log_file_cache_lock:
                    _cache_log_path(task_id, log_file)
                return log_file

    # 回退：扫描所有运行子目录
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.iterdir(),
                              key=lambda p: p.stat().st_mtime if p.is_dir() else 0,
                              reverse=True):
            if not run_dir.is_dir():
                continue
            for log_file in sorted(run_dir.glob(f"train_{task_id_short}*.log"),
                                   key=lambda p: p.stat().st_mtime, reverse=True):
                if log_file.stat().st_size > 0:
                    with _log_file_cache_lock:
                        _cache_log_path(task_id, log_file)
                    return log_file

    return None


def find_run_log_path(run_dir_path: Path) -> Path | None:
    """在历史训练目录中查找最新的训练日志文件（不读取内容）。"""
    try:
        log_files = list(run_dir_path.glob("train_*.log"))
        if log_files:
            return max(log_files, key=lambda p: p.stat().st_mtime)
    except Exception:
        pass
    return None


def read_log_slice(log_path: Path, offset: int = 0, limit: int = 1000,
                   query: str = "", tail: bool = False) -> dict:
    """读取日志文件的指定行区间（分页）+ 可选全文件搜索。

    磁盘文件是完整日志的真相源：使用换行字节偏移索引定位页面，仅读取当前页
    内容；搜索按行流式扫描，避免大日志被整体载入内存。

    返回 {total, offset, limit, lines, query, match_indices}：
      - total: 文件总行数
      - lines: [offset, offset+limit) 区间的行
      - match_indices: query 非空时，全文件匹配行的索引（上限由日志解析模块定义），
        供前端「上一/下一匹配」跳转。
      - tail: 为 True 时定位到文件末尾（offset = max(0, total-limit)）；用于实时任务
        首次进入完整日志模式（此时前端未知 total，无法自行计算尾部 offset）。
    """
    empty = {"total": 0, "offset": offset, "limit": limit, "generation": 0,
             "lines": [], "query": query, "match_indices": []}
    try:
        if not log_path or not log_path.exists() or log_path.stat().st_size == 0:
            return empty
        return indexed_slice(log_path, offset, limit, query, tail)
    except FileNotFoundError:
        return empty
