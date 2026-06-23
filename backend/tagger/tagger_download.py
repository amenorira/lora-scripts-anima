"""Tagger 模型下载辅助——带 rich 进度条的可视化下载。

背景：tagger 的 ONNX 模型（750MB~1.4GB）用 huggingface_hub.hf_hub_download 下载时，
在 hf 0.34.3 + 装 hf_xet 的环境下拿不到任何进度（hf_hub_download 无 tqdm 参数，
xet 走 Rust 直写 fd 2 绕过 Python），控制台只有 "Loading xxx model file from repo" 一行后
长时间静默，用户体验差。

本模块复用 backend.utils.hf_download 的 requests 流式下载核心（多分块 + 续传 +
端点回退 + rich Progress），把文件落到 HF 缓存的 snapshots 布局，返回与 hf_hub_download
一致的快照路径，供 interrogator 直接使用。

对外只暴露一个函数：
    tagger_hub_download(repo_id, filename, cache_dir=None, repo_type='model') -> Path
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from backend.log import log
from backend.utils.hf_download import download_hf_file, make_progress_bar


def _snapshot_path(repo_id: str, filename: str, cache_dir: Optional[str],
                   repo_type: str) -> Path:
    """构造 HF 缓存的 snapshot 文件路径（与 hf_hub_download 返回路径一致）。

    布局：<cache_dir>/models--<org>--<repo>/snapshots/<rev>/<filename>
    """
    from huggingface_hub.file_download import repo_folder_name
    from huggingface_hub import constants
    cache = cache_dir or constants.HF_HUB_CACHE
    folder = repo_folder_name(repo_id=repo_id, repo_type=repo_type)
    rev = "main"  # 默认 revision
    return Path(cache) / folder / "snapshots" / rev / filename


def tagger_hub_download(
    repo_id: str,
    filename: str,
    cache_dir: Optional[str] = None,
    repo_type: str = "model",
) -> Path:
    """下载单个 HF 文件到缓存 snapshots 布局，带 rich 进度条。

    与 hf_hub_download(repo_id, filename, cache_dir, repo_type) 等价返回路径，
    但下载过程在控制台显示 Anima 同款朴素进度条（多分块 + 续传 + 端点回退）。
    文件已存在则直接返回（跳过下载）。
    """
    dest = _snapshot_path(repo_id, filename, cache_dir, repo_type)
    if dest.exists() and dest.is_file() and dest.stat().st_size > 0:
        log.info(f"[tagger-dl] {filename} 已存在，跳过下载")
        return dest

    log.info(f"[tagger-dl] 下载 {filename} from {repo_id}")
    dest.parent.mkdir(parents=True, exist_ok=True)

    try:
        from backend.log import console as _rc
    except Exception:
        _rc = None
    progress_bar = make_progress_bar(console=_rc)

    shared: dict = {}
    lock = threading.Lock()
    state = {"task_id": None}

    def _on_log(msg):
        try:
            log.info(f"[tagger-dl] {msg}")
        except Exception:
            pass

    def _on_progress(line):
        try:
            with lock:
                p = dict(shared)
            fn = p.get("filename") or filename
            total = int(p.get("total") or 0)
            done = int(p.get("downloaded") or 0)
            speed = float(p.get("speed") or 0.0)
            if state["task_id"] is None:
                state["task_id"] = progress_bar.add_task(fn, total=total or None, completed=done)
            else:
                progress_bar.update(state["task_id"], description=fn,
                                    total=total or None, completed=done)
                if speed:
                    progress_bar.tasks[state["task_id"]].speed = speed
        except Exception:
            pass

    progress_bar.start()
    try:
        download_hf_file(
            repo_id, filename, dest,
            progress=shared, lock=lock,
            on_log=_on_log, on_progress=_on_progress,
            file_index=0, file_total=1,
        )
    except Exception as e:
        try:
            log.error(f"[tagger-dl] {filename} 下载失败: {type(e).__name__}: {e}")
        except Exception:
            pass
        raise
    finally:
        try:
            progress_bar.stop()
        except Exception:
            pass

    log.info(f"[tagger-dl] {filename} 下载完成: {dest}")
    return dest
