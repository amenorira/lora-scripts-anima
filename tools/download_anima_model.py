#!/usr/bin/env python
"""训练模型下载工具（薄封装）。

从 Hugging Face Hub 下载 lora-scripts-anima 所需的 Anima / Krea 2 模型文件
落到本地 `models/` 目录，供训练直接 `pretrained_model_name_or_path` 等字段引用。

本文件只保留产品模型清单、批量下载编排、本地扫描和 CLI，
通用 HF 流式下载核心（多分块/续传/端点回退/进度上报/rich Progress）在
backend/utils/hf_download.py，由 api.py / tagger_download.py / 本文件共用。

用法（库内调用，由 backend/server/api.py 封装）:
    from tools.download_anima_model import download_anima_files, ANIMA_FILES
    progress = {}   # 由调用方提供，线程间共享
    download_anima_files(progress=progress, on_log=log_fn, on_progress=bar_fn)

CLI 调试:
    python tools/download_anima_model.py --dest ./models
    python tools/download_anima_model.py --dest ./models --file anima-base-v1.0.safetensors
"""
from __future__ import annotations

import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Callable, Optional

# 让 tools/ 作为脚本直接运行时也能 import 到 backend 包
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.utils.hf_download import download_hf_file, cleanup_temp  # noqa: E402


# ── Anima 核心文件清单 ──
# (HF repo 内路径, 本地文件名, 用途说明)
# HF 仓库里文件在 split_files/ 子目录下，本地统一落到 models/ 根目录。
ANIMA_FILES: list[tuple[str, str, str]] = [
    ("split_files/diffusion_models/anima-base-v1.0.safetensors", "anima-base-v1.0.safetensors", "底模 / Base diffusion model"),
    ("split_files/text_encoders/qwen_3_06b_base.safetensors",   "qwen_3_06b_base.safetensors",   "Text encoder (Qwen3-0.6B)"),
    ("split_files/vae/qwen_image_vae.safetensors",               "qwen_image_vae.safetensors",     "VAE"),
]

# anima_comparison.json 是 ComfyUI 工作流文件，训练不需要，不下。

# HF 仓库
ANIMA_REPO_ID = "circlestone-labs/Anima"
KREA2_REPO_ID = "Comfy-Org/Krea-2"

KREA2_FILES: list[tuple[str, str, str]] = [
    (
        "diffusion_models/krea2_raw_fp8_scaled.safetensors",
        "krea2_raw_fp8_scaled.safetensors",
        "Krea 2 训练底模 / Training model",
    ),
    (
        "diffusion_models/krea2_turbo_fp8_scaled.safetensors",
        "krea2_turbo_fp8_scaled.safetensors",
        "Krea 2 推理模型 / Inference model",
    ),
    (
        "text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
        "qwen3vl_4b_fp8_scaled.safetensors",
        "文本编码器 / Text encoder (Qwen3-VL-4B FP8 scaled)",
    ),
    (
        "vae/qwen_image_vae.safetensors",
        "qwen_image_vae.safetensors",
        "VAE（与 Anima 共用本地文件） / Shared with Anima",
    ),
]

# (HF repo, HF 路径, 本地文件名, 用途说明, UI 分组)
MODEL_FILES: list[tuple[str, str, str, str, str]] = [
    (ANIMA_REPO_ID, hf_path, local_name, desc, "Anima")
    for hf_path, local_name, desc in ANIMA_FILES
] + [
    (KREA2_REPO_ID, hf_path, local_name, desc, "Krea 2")
    for hf_path, local_name, desc in KREA2_FILES
]


def _normalize_file(
    item: tuple[str, str, str] | tuple[str, str, str, str] | tuple[str, str, str, str, str],
    default_repo_id: str,
) -> tuple[str, str, str, str]:
    """Return (repo_id, hf_path, local_name, description)."""
    if len(item) == 3:
        hf_path, local_name, desc = item
        return default_repo_id, hf_path, local_name, desc
    if len(item) == 4:
        repo, hf_path, local_name, desc = item
        return repo, hf_path, local_name, desc
    repo, hf_path, local_name, desc, _group = item
    return repo, hf_path, local_name, desc


def download_anima_files(
    dest_dir: Path,
    progress: dict | None = None,
    on_log: Optional[Callable[[str], None]] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    repo_id: str = ANIMA_REPO_ID,
    files: list[
        tuple[str, str, str]
        | tuple[str, str, str, str]
        | tuple[str, str, str, str, str]
    ] | None = None,
    progress_lock: Optional[threading.Lock] = None,
) -> list[Path]:
    """逐文件下载模型，把进度写入共享 progress dict。

    参数:
        dest_dir: 落盘目录（通常 = SD_MODELS_DIR），所有文件最终平铺在此目录下
        progress: 线程间共享的进度 dict（由后端提供），每次更新原地覆盖
        on_log: 事件日志回调（文件开始/完成/失败/重试），换行打印
        on_progress: 单行进度回调（百分比+速度），由调用方以 \\r 原地刷新；可空
        repo_id: HF 仓库 id
        files: 支持 (hf_path, local_name, desc) 或带 repo_id / UI 分组的模型条目
        progress_lock: 保护 progress dict 的锁；传入后端共享锁可使读取端与之互斥，
                       避免轮询时 "dictionary changed during iteration"。默认自建本地锁。

    返回每个文件落盘的绝对路径列表。失败文件对应路径为空 Path('.')。
    """
    files = files or ANIMA_FILES  # type: ignore[assignment]
    file_total = len(files)
    lock = progress_lock if progress_lock is not None else threading.Lock()
    progress = progress if progress is not None else {}

    # 让前端能区分"本次要下的文件"（排队中）与"不相关的文件"（显示静态状态）
    normalized_files = [_normalize_file(item, repo_id) for item in files]
    batch_names = [local_name for _, _, local_name, _ in normalized_files]
    with lock:
        progress.update({
            "phase": "downloading",
            "file_index": 0,
            "file_total": file_total,
            "batch": batch_names,
            "filename": normalized_files[0][2] if normalized_files else "",
        })

    def _log(msg: str):
        if on_log:
            try:
                on_log(msg)
            except Exception:
                pass

    # 磁盘空间预检（粗略：要求至少 1GB，避免下到一半才报磁盘满）
    try:
        usage = shutil.disk_usage(dest_dir)
        if usage.free < 1024 ** 3:
            with lock:
                progress.update({
                    "phase": "error", "filename": "",
                    "file_index": 0, "file_total": file_total,
                    "error": f"磁盘剩余 {usage.free // (1024**3)} GB < 1GB",
                })
            _log(f"[ERROR] 磁盘空间不足 / Insufficient disk space: {usage.free // (1024**3)} GB remaining")
            return [Path(".")] * file_total
    except OSError:
        pass

    dest_dir.mkdir(parents=True, exist_ok=True)
    results: list[Path] = []
    for i, (file_repo_id, hf_path, local_name, desc) in enumerate(normalized_files):
        _log(f"[{i+1}/{file_total}] 下载 / Downloading {local_name} ({desc}) ...")
        with lock:
            progress.update({
                "filename": local_name,
                "file_index": i,
                "file_total": file_total,
                "downloaded": 0,
                "total": 0,
                "speed": 0.0,
                "phase": "downloading",
            })
        dest = dest_dir / local_name
        try:
            path = download_hf_file(
                file_repo_id, hf_path, dest,
                progress=progress, lock=lock,
                on_log=on_log, on_progress=on_progress,
                file_index=i, file_total=file_total,
            )
            results.append(path)
            _log(f"[{i+1}/{file_total}] 已下载 / Downloaded: {path}")
        except Exception as e:
            with lock:
                progress.update({
                    "phase": "error",
                    "filename": local_name,
                    "file_index": i,
                    "file_total": file_total,
                    "error": f"{type(e).__name__}: {e}",
                })
            _log(f"[{i+1}/{file_total}] 失败 / Failed: {e}")
            results.append(Path("."))
            # 清理该文件的临时分块，避免孤儿占用磁盘（分块内重试已覆盖瞬时网络错误）
            cleanup_temp(dest)

    # 全部完成
    with lock:
        progress.update({
            "phase": "done",
            "file_index": file_total,
            "file_total": file_total,
            "speed": 0.0,
        })
    return results


def list_local_model_files(dest_dir: Path) -> list[dict]:
    """扫描全部可下载训练模型，并返回 UI 所需的仓库与用途信息。"""
    out = []
    for repo_id, hf_path, local_name, desc, group in MODEL_FILES:
        path = dest_dir / local_name
        exists = path.exists() and path.is_file()
        out.append(
            {
                "filename": local_name,
                "desc": desc,
                "group": group,
                "repo_id": repo_id,
                "source_url": f"https://huggingface.co/{repo_id}/blob/main/{hf_path}",
                "exists": exists,
                "size_gb": round(path.stat().st_size / (1024**3), 2) if exists else 0,
            }
        )
    return out


def main():
    """CLI 调试入口：python tools/download_anima_model.py [--dest PATH] [--file NAME]"""
    import argparse
    parser = argparse.ArgumentParser(description="Download Anima base models to ./models/")
    parser.add_argument("--dest", default="./models", help="目标目录（默认 ./models）")
    parser.add_argument("--file", default=None, help="只下某个文件名（本地名或 HF 路径）")
    args = parser.parse_args()

    dest = Path(args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    files = ANIMA_FILES
    if args.file:
        files = [(h, l, d) for h, l, d in ANIMA_FILES if l == args.file or h == args.file]
        if not files:
            print(f"未知文件: {args.file}，可选: {[l for _,l,_ in ANIMA_FILES]}")
            return

    print(f"dest = {dest}")
    print(f"files = {[f for f,_ in files]}")
    # 尊重 HF_ENDPOINT（如已 export HF_ENDPOINT=https://hf-mirror.com）
    print(f"HF_ENDPOINT = {os.environ.get('HF_ENDPOINT', '(default)')}")

    is_tty = sys.stdout.isatty()

    def _cli_progress(line: str):
        if is_tty:
            sys.stdout.write("\r" + line)
            sys.stdout.flush()

    def _cli_log(msg: str):
        if is_tty:
            # 先清掉正在刷新的进度行，再换行打印事件
            sys.stdout.write("\r" + " " * 100 + "\r")
        print(msg, flush=True)

    progress: dict = {}
    paths = download_anima_files(
        dest_dir=dest,
        progress=progress,
        on_log=_cli_log,
        on_progress=_cli_progress,
        files=files,
    )
    if is_tty:
        sys.stdout.write("\r" + " " * 100 + "\r")
        sys.stdout.flush()
    print("\n结果:")
    for (fname, _), p in zip(files, paths):
        print(f"  {fname:32s} -> {p if p != Path('.') else '失败'}")


if __name__ == "__main__":
    main()
