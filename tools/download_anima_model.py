#!/usr/bin/env python
"""Anima 模型下载工具。

从 Hugging Face Hub 下载 lora-scripts-anima 所需的基础模型文件（底模 / text encoder / VAE）
落到本地 `models/` 目录，供训练直接 `pretrained_model_name_or_path` 等字段引用。

设计要点:
    - 逐文件 `hf_hub_download` 下载，开启 hf[xet] 多线程分块加速（未安装时自动回退普通 HTTP）。
    - 通过自定义进度回调把 `downloaded / total / speed` 写入外部共享 dict（线程安全），
      供 FastAPI 后台线程轮询并经 `/api/install-log/{job_id}` 暴露给前端。
    - 尊重 `HF_ENDPOINT` 环境变量，方便 AutoDL 学术加速 / 自建镜像用户切换源。
    - 失败降级：单文件下载失败仅记录 phase=error，不崩主进程。

用法（库内调用，由 backend/server/api.py 封装）:
    from tools.download_anima_model import download_anima_files, ANIMA_FILES
    progress = {}   # 由调用方提供，线程间共享
    download_anima_files(progress=progress, on_log=log_fn)

CLI 调试:
    python tools/download_anima_model.py --dest ./models
    python tools/download_anima_model.py --dest ./models --file anima-base-v1.0.safetensors
"""
from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path
from typing import Callable, Optional

# ── Anima 核心文件清单（写死；以后再加别的就改这里）──
# (filename, 用途说明)
ANIMA_FILES: list[tuple[str, str]] = [
    ("anima-base-v1.0.safetensors",  "底模 / Base diffusion model"),
    ("qwen_3_06b_base.safetensors",  "Text encoder (Qwen3-0.6B)"),
    ("qwen_image_vae.safetensors",   "VAE"),
]
# anima_comparison.json 是 ComfyUI 工作流文件，训练不需要，不下。

# HF 仓库
ANIMA_REPO_ID = "circlestone-labs/Anima"


class _ProgressCallback:
    """huggingface_hub tqdm 兼容回调。

    hf_hub_download 在新版接受 `tqdm` 参数（需要一个类 tqdm 接口的对象），
    在老版则使用 `DownloadArtifact` 内置回调。这里实现最小子集：
    `__call__`（旧 API）+ `update(n)` / `total` setter（新 API），
    把回调写入外部共享 dict。
    """

    def __init__(
        self,
        progress: dict,
        filename: str,
        file_index: int,
        file_total: int,
        lock: threading.Lock,
    ):
        self._p = progress
        self._lock = lock
        self._filename = filename
        self._file_index = file_index
        self._file_total = file_total
        self._downloaded = 0
        self._total = 0
        self._last_ts = time.time()
        self._last_bytes = 0
        # 兼容 tqdm-like 接口
        self.n = 0
        self.total = 0

    def _push(self):
        now = time.time()
        dt = now - self._last_ts
        if dt >= 0.3:
            speed = (self._downloaded - self._last_bytes) / max(dt, 1e-6) / (1024 ** 2)
            self._last_ts = now
            self._last_bytes = self._downloaded
        else:
            speed = self._p.get("speed", 0.0)
        with self._lock:
            self._p.update({
                "filename": self._filename,
                "file_index": self._file_index,
                "file_total": self._file_total,
                "downloaded": self._downloaded,
                "total": self._total,
                "speed": round(speed, 2),
                "phase": "downloading",
            })

    # 旧 API：hf_hub_download(..., tqdm=cb) 时每次进度条更新调用 cb(arguments)
    def __call__(self, arguments):
        # arguments 是 huggingface_hub 历史上传过的 dict 或 tqdm-like；尽量兼容
        try:
            n = getattr(arguments, "n", None)
            total = getattr(arguments, "total", None)
            if n is None and isinstance(arguments, dict):
                n = arguments.get("n")
                total = arguments.get("total")
            if n is not None:
                self._downloaded = int(n)
            if total is not None:
                self._total = int(total)
        except Exception:
            pass
        self._push()

    # 新 API（tqdm-like）：直接对象方法
    def update(self, n=1):
        self._downloaded += int(n)
        self._push()

    def reset(self, total=None):
        self._downloaded = 0
        if total is not None:
            self._total = int(total)

    def close(self):
        with self._lock:
            self._p.update({
                "filename": self._filename,
                "file_index": self._file_index,
                "file_total": self._file_total,
                "downloaded": self._total if self._total else self._downloaded,
                "total": self._total,
                "speed": 0.0,
                "phase": "file_done",
            })


def _hf_hub_download_compat(
    repo_id: str,
    filename: str,
    local_dir: Path,
    cb: _ProgressCallback,
) -> Path:
    """调用 hf_hub_download，跨 huggingface_hub 版本尽量兼容 tqdm 参数名。

    新版（>=0.21）支持 `tqdm` 参数；老版本回调通过 `DownloadConfig`。
    这里尝试 `tqdm=cb`，失败则降级无进度下载（速度不显示，但能下）。
    """
    from huggingface_hub import hf_hub_download
    local_dir.mkdir(parents=True, exist_ok=True)
    kwargs = dict(
        repo_id=repo_id,
        filename=filename,
        local_dir=str(local_dir),
    )
    # tqdm 参数在不同版本兼容名不同，依次尝试
    for tqdm_kw in ("tqdm",):
        try:
            return Path(hf_hub_download(tqdm=cb, **kwargs))
        except TypeError:
            # 该版本不支持此参数
            break
    # 无进度降级
    return Path(hf_hub_download(**kwargs))


def download_anima_files(
    dest_dir: Path,
    progress: dict | None = None,
    on_log: Optional[Callable[[str], None]] = None,
    repo_id: str = ANIMA_REPO_ID,
    files: list[tuple[str, str]] | None = None,
) -> list[Path]:
    """逐文件下载 Anima 模型，把进度写入共享 progress dict。

    参数:
        dest_dir: 落盘目录（通常 = SD_MODELS_DIR）
        progress: 线程间共享的进度 dict（由后端提供），每次更新原地覆盖
        on_log: 文本日志回调（写一行字符串），可选
        repo_id: HF 仓库 id
        files: [(filename, desc)]，默认 ANIMA_FILES

    返回每个文件落盘的绝对路径列表。失败文件对应路径为空 Path('.')。
    """
    files = files or ANIMA_FILES
    file_total = len(files)
    lock = threading.Lock()
    progress = progress if progress is not None else {}

    def _log(msg: str):
        if on_log:
            try:
                on_log(msg)
            except Exception:
                pass

    # 磁盘空间预检（按 3 个文件合计 ~12GB 估算，宽松一点）
    try:
        usage = shutil.disk_usage(dest_dir.parent if dest_dir.exists() else dest_dir)
        if usage.free < 1024 ** 3:  # < 1GB
            with lock:
                progress.update({
                    "phase": "error",
                    "filename": "",
                    "file_index": 0,
                    "file_total": file_total,
                    "error": f"磁盘剩余 {usage.free // (1024**3)} GB < 1GB，不足以下载 Anima 模型",
                })
            _log(f"[ERROR] 磁盘空间不足：剩余 {usage.free // (1024**3)} GB")
            return [Path(".")]*file_total
    except OSError:
        pass

    results: list[Path] = []
    for i, (fname, desc) in enumerate(files):
        _log(f"[{i+1}/{file_total}] 下载 {fname} ({desc}) ...")
        with lock:
            progress.update({
                "filename": fname,
                "file_index": i,
                "file_total": file_total,
                "downloaded": 0,
                "total": 0,
                "speed": 0.0,
                "phase": "downloading",
            })
        cb = _ProgressCallback(progress, fname, i, file_total, lock)
        try:
            path = _hf_hub_download_compat(repo_id, fname, dest_dir, cb)
            cb.close()
            results.append(path)
            _log(f"[{i+1}/{file_total}] 已下载: {path}")
        except Exception as e:
            with lock:
                progress.update({
                    "phase": "error",
                    "filename": fname,
                    "file_index": i,
                    "file_total": file_total,
                    "error": f"{type(e).__name__}: {e}",
                })
            _log(f"[{i+1}/{file_total}] 失败: {e}")
            results.append(Path("."))
    # 全部完成
    with lock:
        progress.update({"phase": "done", "file_index": file_total, "file_total": file_total, "speed": 0.0})
    return results


def list_local_anima_files(dest_dir: Path) -> list[dict]:
    """扫描 models/ 下与 ANIMA_FILES 同名的文件，返回 {filename, exists, size_gb}。"""
    out = []
    for fname, desc in ANIMA_FILES:
        p = dest_dir / fname
        if p.exists() and p.is_file():
            out.append({"filename": fname, "desc": desc, "exists": True, "size_gb": round(p.stat().st_size / (1024**3), 2)})
        else:
            out.append({"filename": fname, "desc": desc, "exists": False, "size_gb": 0})
    return out


def main():
    """CLI 调试入口：python tools/download_anima_model.py [--dest PATH] [--file NAME]"""
    import argparse
    parser = argparse.ArgumentParser(description="Download Anima base models to ./models/")
    parser.add_argument("--dest", default="./models", help="目标目录（默认 ./models）")
    parser.add_argument("--file", default=None, help="只下某个文件名")
    args = parser.parse_args()

    dest = Path(args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    files = ANIMA_FILES
    if args.file:
        files = [(f, d) for f, d in ANIMA_FILES if f == args.file]
        if not files:
            print(f"未知文件: {args.file}，可选: {[f for f,_ in ANIMA_FILES]}")
            return

    print(f"dest = {dest}")
    print(f"files = {[f for f,_ in files]}")
    # 尊重 HF_ENDPOINT（如已 export HF_ENDPOINT=https://hf-mirror.com）
    print(f"HF_ENDPOINT = {os.environ.get('HF_ENDPOINT', '(default)')}")

    progress: dict = {}
    paths = download_anima_files(
        dest_dir=dest,
        progress=progress,
        on_log=lambda m: print(m, flush=True),
        files=files,
    )
    print("\n结果:")
    for (fname, _), p in zip(files, paths):
        print(f"  {fname:32s} -> {p if p != Path('.') else '失败'}")


if __name__ == "__main__":
    main()