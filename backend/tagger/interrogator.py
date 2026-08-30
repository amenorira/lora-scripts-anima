"""传统批量打标流水线（本地 ONNX 模型）。

职责：任务进度快照、取消、GPU 推理互斥、批量循环与字幕写盘。
打标模型实现见 interrogators/，文件名模板见 naming.py；
工作区打标（workspace.py）与本模块共享 available_interrogators 和推理锁。
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import OrderedDict
from glob import glob
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError

from backend.constants import HF_CACHE_DIR
from backend.log import log
from backend.tagger import naming
from backend.tagger.interrogators.base import Interrogator  # noqa: F401  （对外再导出）
from backend.tagger.interrogators.camie import CamieTaggerInterrogator
from backend.tagger.interrogators.cl import CLTaggerInterrogator
from backend.tagger.interrogators.wd14 import WaifuDiffusionInterrogator

# 所有打标模型统一下载到项目 huggingface/ 目录
_HF_CACHE = str(HF_CACHE_DIR)

available_interrogators = {
    'wd-eva02-large-tagger-v3': WaifuDiffusionInterrogator(
        'wd-eva02-large-tagger-v3',
        repo_id='SmilingWolf/wd-eva02-large-tagger-v3',
        cache_dir=_HF_CACHE,
    ),
    'wd-vit-large-tagger-v3': WaifuDiffusionInterrogator(
        'wd-vit-large-tagger-v3',
        repo_id='SmilingWolf/wd-vit-large-tagger-v3',
        cache_dir=_HF_CACHE,
    ),
    'cl_tagger_1_02': CLTaggerInterrogator(
        'cl_tagger_1_02',
        repo_id='cella110n/cl_tagger',
        model_path='cl_tagger_1_02/model.onnx',
        tag_mapping_path='cl_tagger_1_02/tag_mapping.json',
        cache_dir=_HF_CACHE,
    ),
    'camie-tagger-v2': CamieTaggerInterrogator(
        'camie-tagger-v2',
        repo_id='Camais03/camie-tagger-v2',
        model_filename='camie-tagger-v2.onnx',
        metadata_filename='camie-tagger-v2-metadata.json',
        cache_dir=_HF_CACHE,
    ),
}

# GPU 推理互斥：打标/训练抢同一张卡时由路由层协调
gpu_inference_lock = threading.Lock()


def split_str(s: str, separator: str = ',') -> List[str]:
    """逗号串 → 去空白后的非空项列表。"""
    return list(filter(None, map(str.strip, s.split(separator))))


# ── 任务状态（进度快照 + 取消标志 + TTL 清理） ─────────────

_TASK_TTL_SEC = 300  # 终态任务保留 5 分钟后清理

_task_states: Dict[str, dict] = {}
_states_lock = threading.Lock()


def _sweep_expired() -> None:
    """清理已到终态且过期的任务，防止状态表无限增长。"""
    now = time.time()
    with _states_lock:
        expired = [
            task_id for task_id, state in _task_states.items()
            if state.get("status") in ("done", "cancelled", "error")
            and now - state.get("_completed_at", now) > _TASK_TTL_SEC
        ]
        for task_id in expired:
            del _task_states[task_id]


def _update(task_id: str, **fields) -> None:
    with _states_lock:
        state = _task_states.get(task_id)
        if state is not None:
            state.update(fields)


def _log_line(task_id: str, line: str) -> None:
    with _states_lock:
        state = _task_states.get(task_id)
        if state is not None:
            state["logs"].append(line)


def _settle(task_id: str, status: str, **fields) -> None:
    """写入终态并记录完成时间（供 TTL 清理）。已取消的任务不被覆盖成 done。"""
    with _states_lock:
        state = _task_states.get(task_id)
        if state is None:
            return
        if status == "done" and state.get("status") == "cancelled":
            status = "cancelled"
        state.update(fields)
        state["status"] = status
        state["_completed_at"] = time.time()


def _is_cancelled(task_id: str) -> bool:
    with _states_lock:
        state = _task_states.get(task_id)
        return bool(state) and state.get("status") == "cancelled"


def get_tagger_task_snapshot(task_id: str) -> dict:
    with _states_lock:
        return _task_states.get(
            task_id,
            {"status": "idle", "current": 0, "total": 0, "current_file": "", "logs": []},
        ).copy()


def cancel_tagger_task(task_id: str) -> bool:
    """标记任务取消；批量循环在下一张图前检查并提前退出。"""
    with _states_lock:
        state = _task_states.get(task_id)
        if state is None:
            return False
        state["status"] = "cancelled"
        state["logs"].append('Task cancelled by user')
        state["_completed_at"] = time.time()
        return True


def has_active_legacy_tagger_task() -> bool:
    with _states_lock:
        return any(state.get("status") == "running" for state in _task_states.values())


# ── 批量流水线 ───────────────────────────────────────────

def _expand_input(pattern: str, recursive: bool) -> Tuple[Optional[str], List[Path]]:
    """规范化 glob 模式并展开为图片路径列表；返回 (基准目录, 路径表)。

    基准目录用于把子目录结构镜像到输出目录；输入不是目录时返回 (None, [])。
    """
    if not pattern.endswith("*"):
        if not pattern.endswith(os.sep):
            pattern += os.sep
        pattern += "*"
    if recursive:
        pattern += "*"

    head = re.split(r"[*?]", pattern, maxsplit=1)[0].rstrip(os.sep) or os.sep
    base_dir = head if os.path.isdir(head) else os.path.dirname(head)
    if not base_dir or not os.path.isdir(base_dir):
        return None, []

    # 注意要在打开图片后再取 registered_extensions：过早调用只能拿到 PNG
    openable = {ext for ext, fmt in Image.registered_extensions().items() if fmt in Image.OPEN}
    paths = [
        Path(p) for p in glob(pattern, recursive=recursive)
        if Path(p).suffix.lower() in openable
    ]
    return base_dir, paths


def _output_path_for(image_path: Path, base_dir: str, out_root: str, template: str) -> Path:
    """按基准目录镜像子目录结构，并用模板渲染输出文件名。"""
    root = Path(out_root) if out_root else Path(base_dir)
    try:
        relative_parent = image_path.parent.relative_to(base_dir)
    except ValueError:
        relative_parent = Path()
    out_dir = root / relative_parent
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = naming.render(template, naming.FileContext(image_path, "txt"))
    return out_dir / filename


def _write_caption(output_path: Path, caption: str, conflict: str,
                   deduplicate: bool, save_json: bool, raw_tags) -> None:
    """按冲突策略写字幕文件；save_json 时附带原始置信度。"""
    import json

    existing = ""
    if output_path.is_file():
        existing = output_path.read_text(encoding="utf-8", errors="ignore").strip()

    if conflict == 'copy':
        segments = [caption]
    elif conflict == 'prepend' and existing:
        segments = [caption, existing]
    elif existing:
        segments = [existing, caption]
    else:
        segments = [caption]

    text = ', '.join(part for part in segments if part)
    if deduplicate:
        text = ', '.join(OrderedDict.fromkeys(
            tag.strip() for tag in text.split(',')
        ))
    output_path.write_text(text, encoding="utf-8")

    if save_json:
        output_path.with_suffix(".json").write_text(json.dumps(raw_tags))


def on_interrogate(
        task_id: str,
        image: Image,
        batch_input_glob: str,
        batch_input_recursive: bool,
        batch_output_dir: str,
        batch_output_filename_format: str,
        batch_output_action_on_conflict: str,
        batch_remove_duplicated_tag: bool,
        batch_output_save_json: bool,

        interrogator: Interrogator,

        threshold: float,
        character_threshold: float,
        category_thresholds: Dict[str, float] = None,

        add_rating_tag: bool = False,
        add_model_tag: bool = False,

        additional_tags: str = "",
        exclude_tags: str = "",
        sort_by_alphabetical_order: bool = False,
        add_confident_as_weight: bool = False,
        replace_underscore: bool = False,
        replace_underscore_excludes: str = "",
        escape_tag: bool = False,

        unload_model_after_running: bool = False
):
    """批量打标入口（后台线程跑，进度经 get_tagger_task_snapshot 轮询）。"""
    postprocess_args = (
        threshold,
        character_threshold,
        category_thresholds or {},
        add_rating_tag,
        add_model_tag,
        split_str(additional_tags),
        split_str(exclude_tags),
        sort_by_alphabetical_order,
        add_confident_as_weight,
        replace_underscore,
        split_str(replace_underscore_excludes),
        escape_tag,
    )

    out_root = batch_output_dir.strip()
    template = batch_output_filename_format.strip()

    if batch_input_glob.strip():
        base_dir, image_paths = _expand_input(batch_input_glob.strip(), batch_input_recursive)
        if base_dir is None:
            log.error('input path is not a directory / 输入路径不是目录')
            return 'input path is not a directory / 输入路径不是目录'

        total = len(image_paths)
        _sweep_expired()
        with _states_lock:
            _task_states[task_id] = {
                "status": "running", "current": 0, "total": total,
                "current_file": "", "logs": [],
            }
        log.info(f'found {total} image(s) / 找到 {total} 张图片')
        _log_line(task_id, 'Loading model (first use may download automatically)... / 正在加载模型（首次使用可能自动下载）……')

        for index, path in enumerate(image_paths):
            if _is_cancelled(task_id):
                log.info(f'Task {task_id} cancelled at {index}/{total} / 任务已取消')
                break
            _update(task_id, current_file=str(path.name))

            try:
                output_path = _output_path_for(path, base_dir, out_root, template)
            except (TypeError, ValueError) as error:
                # 模板写错属于配置问题：整批中止，让用户改完再来
                message = f"Format error / 格式错误: {str(error)[:200]}"
                _log_line(task_id, f'Error / 错误: {message}')
                _settle(task_id, "error", error_detail=message)
                return str(error)

            # ignore 策略只看目标文件是否存在，不必先解码图片（批量跳过重图时显著省时）
            if batch_output_action_on_conflict == 'ignore' and output_path.is_file():
                log.info(f'skipping {path} / 跳过', extra={"console": False})
                _log_line(task_id, f'Skip (already exists) / 跳过（已存在）: {path.name}')
                _update(task_id, current=index + 1)
                continue

            try:
                with Image.open(path) as opened:
                    with gpu_inference_lock:
                        raw_tags = interrogator.interrogate(opened)
                processed = Interrogator.postprocess_tags(raw_tags, *postprocess_args)
                caption = ', '.join(processed)
                _write_caption(
                    output_path, caption, batch_output_action_on_conflict,
                    batch_remove_duplicated_tag, batch_output_save_json, raw_tags,
                )
                log.info(f'[{index+1}/{total}] found {len(processed)} tags from {path.name} / 找到 {len(processed)} 个标签', extra={"console": False})
                _log_line(task_id, f'[{index+1}/{total}] {path.name}: {len(processed)} tags / {len(processed)} 个标签')
            except UnidentifiedImageError:
                log.warning(f'{path} is not a supported image type / 不支持的图片格式')
                _log_line(task_id, f'Skip (unsupported) / 跳过（格式不支持）: {path.name}')
            except Exception as e:
                message = f'{path.name}: {type(e).__name__}: {str(e)[:200]}'
                log.warning(f'Error processing {message} / 处理出错')
                log.exception(f'Error processing {message} / 处理出错')
                _log_line(task_id, f'Error / 错误: {message}')

            _update(task_id, current=index + 1)

        _settle(task_id, "done")
        log.info('all done / 全部完成')

    if unload_model_after_running:
        interrogator.unload()

    return 'Succeed'
