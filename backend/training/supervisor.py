"""
Anima Backend — 训练进程管理器

负责训练子进程的启动、环境隔离、端口检测。
解耦 backend 与 sd-scripts 的直接 import 依赖。
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from backend.log import log
from backend.tasks import tm
from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR


def _find_free_port(start: int = 6008, max_attempts: int = 10) -> int | None:
    """查找可用端口（用于 monitor）"""
    for offset in range(max_attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return None


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _detect_available_attn() -> list[str]:
    """检测可用的 attention backend"""
    available = ["torch"]  # torch SDPA 总是可用

    # 检测 xformers
    try:
        import xformers  # noqa: F401
        available.append("xformers")
    except ImportError:
        pass

    # 检测 flash_attn
    try:
        import flash_attn  # noqa: F401
        available.append("flash")
    except ImportError:
        pass

    return available


def _build_train_env(output_dir: str, task_id: str) -> dict:
    """构建训练子进程的环境变量"""
    env = os.environ.copy()

    # 防止系统 site-packages 污染
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONWARNINGS"] = "ignore::FutureWarning,ignore::UserWarning"
    env["ACCELERATE_DISABLE_RICH"] = "1"

    # 训练输出目录
    env["ANIMA_OUTPUT_DIR"] = output_dir
    env["ANIMA_TASK_ID"] = task_id

    # 确保项目根目录在 Python path 中（支持 vendor.emo_optimizer 等自定义模块）
    repo_root = str(REPO_ROOT)
    existing_pypath = env.get("PYTHONPATH", "")
    if repo_root not in existing_pypath.split(os.pathsep):
        env["PYTHONPATH"] = repo_root + (os.pathsep + existing_pypath if existing_pypath else "")

    return env


def _get_trainer_script(trainer_file: str) -> Path:
    """解析训练脚本路径"""
    base = REPO_ROOT  # repo root
    script = base / trainer_file.lstrip("./")
    if not script.exists():
        raise FileNotFoundError(f"Training script not found / 训练脚本不存在: {script}")
    return script


def run_train(
    toml_path: str,
    trainer_file: str = "./vendor/sd-scripts/train_network.py",
    gpu_ids: Optional[list] = None,
    cpu_threads: int = 2,
    extra_args: Optional[list] = None,
    output_dir: str = "",
) -> dict:
    """
    启动训练子进程。

    返回: {"status": "success", "data": {"task_id": ...}}
    """
    script = _get_trainer_script(trainer_file)

    # 默认 output 目录
    od = output_dir or str(Path(toml_path).parent.parent / "output")

    # ── 1. GPU 校验（在创建任务之前，避免无效 GPU 产生孤儿任务）──
    validated_ids: list[int] = []
    env_extra: dict = {}
    if gpu_ids:
        try:
            import torch
            device_count = torch.cuda.device_count()
            validated_ids = [int(g) for g in gpu_ids]
            if not all(0 <= g < device_count for g in validated_ids):
                raise ValueError(f"GPU ID out of range (available: 0-{device_count - 1})")
        except (ValueError, TypeError, ImportError) as e:
            log.error(f"Invalid GPU IDs / GPU ID 无效: {gpu_ids} — {e}")
            return {"status": "error", "message": f"Invalid GPU IDs: {gpu_ids}"}

    if validated_ids:
        env_extra = {"CUDA_VISIBLE_DEVICES": ",".join(str(g) for g in validated_ids)}
        if len(validated_ids) > 1 and sys.platform == "win32":
            env_extra["USE_LIBUV"] = "0"

    # ── 2. 构建命令行参数 ──────────────────────────────
    args = [
        sys.executable, "-m", "accelerate.commands.launch",
        "--num_cpu_threads_per_process", str(cpu_threads),
        "--quiet",
    ]
    # 多 GPU 参数
    if len(validated_ids) > 1:
        args.extend(["--multi_gpu", "--num_processes", str(len(validated_ids))])
        if sys.platform == "win32":
            args.extend(["--rdzv_backend", "c10d"])
    # 训练脚本 + 训练配置
    args.append(str(script))
    args.extend(["--config_file", toml_path])

    if extra_args:
        args.extend(extra_args)

    # ── 3. 创建任务（此时所有校验已通过）─────────────────
    task = tm.create_task(args, None)
    if not task:
        return {"status": "error", "message": "Failed to create task / 创建任务失败: max concurrency limit reached / 已达最大并发"}

    task_id = task.task_id
    task_id_short = task_id[:8]

    env = _build_train_env(output_dir=od, task_id=task_id)
    env.update(env_extra)
    task.environ = env  # 更新 task 的环境变量

    # 日志文件放在运行文件夹内
    run_dir = Path(od)
    run_dir.mkdir(parents=True, exist_ok=True)
    log_file = run_dir / f"train_{task_id_short}.log"

    def _run():
        import json as _json
        start_time = time.time()
        exit_code = -1
        status = "error"
        error_msg = ""

        try:
            # 打开日志文件用于捕获 stdout
            with open(log_file, "w", encoding="utf-8", errors="backslashreplace") as lf:
                task.execute(stdout_file=lf)
                result = task.communicate()
                exit_code = result.returncode
                if result.returncode != 0:
                    status = "failed"
                    error_msg = f"exit code {result.returncode}"
                    log.error(f"Training failed / 训练失败 (task={task_id_short}, exit={result.returncode})")
                else:
                    status = "completed"
                    log.info(f"Training completed / 训练完成 (task={task_id_short})")
        except subprocess.TimeoutExpired:
            status = "timeout"
            error_msg = "Training timed out / 训练超时"
            log.error(f"Training timed out / 训练超时 (task={task_id_short})")
        except Exception as e:
            status = "error"
            error_msg = str(e)[:500]
            log.error(f"Training exception / 训练异常 (task={task_id_short}): {e}")

        duration = time.time() - start_time

        # ── B: 写入结构化训练结果 ────────────────────────
        _write_result_json(run_dir, task_id, status, exit_code, error_msg, duration)
        # ── C: 失败时提取尾部错误日志 ─────────────────────
        if status != "completed":
            _write_error_tail(log_file, run_dir, task_id_short)

    coro = asyncio.to_thread(_run)
    task_handle = asyncio.create_task(coro)
    task_handle.add_done_callback(
        lambda t: log.error(f"Training background task crashed / 后台训练任务异常: {t.exception()}") if t.exception() else None
    )

    log.info(f"Training started / 训练已启动: {task_id_short} ({Path(toml_path).name})")

    return {
        "status": "success",
        "message": f"Training started / 训练已启动",
        "data": {"task_id": task_id},
    }


def terminate_train(task_id: str) -> bool:
    """终止训练"""
    try:
        tm.terminate_task(task_id)
        return True
    except Exception as e:
        log.error(f"Failed to terminate training / 终止失败: {e}")
        return False


def get_train_status(task_id: str) -> dict:
    """获取训练状态"""
    tasks = tm.dump()
    for t in tasks:
        if t["id"] == task_id:
            return t
    return {"id": task_id, "status": "UNKNOWN"}


def detect_attention_backend(requested: str) -> tuple[str, str]:
    """
    检测并自动降级 attention backend。

    返回: (actual_backend, warning_message)
    """
    available = _detect_available_attn()

    if requested in available:
        return requested, ""

    if requested == "xformers" and "torch" in available:
        msg = f"xformers not available / xformers 不可用; falling back to torch SDPA / 降级为 torch SDPA"
        log.warning(msg)
        return "torch", msg

    if requested == "flash" and "xformers" in available:
        msg = f"flash_attn not available / flash_attn 不可用; falling back to xformers / 降级为 xformers"
        log.warning(msg)
        return "xformers", msg

    if requested == "flash" and "torch" in available:
        msg = f"flash_attn and xformers both unavailable / 均不可用; falling back to torch SDPA / 降级为 torch SDPA"
        log.warning(msg)
        return "torch", msg

    return requested, ""


def _write_result_json(
    run_dir: Path,
    task_id: str,
    status: str,
    exit_code: int,
    error_msg: str,
    duration_sec: float,
) -> None:
    """写入结构化训练结果文件"""
    try:
        result = {
            "task_id": task_id,
            "status": status,
            "exit_code": exit_code,
            "duration_sec": round(duration_sec, 1),
            "duration_str": f"{int(duration_sec // 60)}m {int(duration_sec % 60)}s",
            "error": error_msg if error_msg else None,
        }
        result_path = run_dir / "result.json"
        result_path.write_text(
            json.dumps(result, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as e:
        log.warning(f"Failed to write result.json / 写入失败: {e}")


def _write_error_tail(log_file: Path, run_dir: Path, task_id_short: str) -> None:
    """训练失败时，从日志中提取最后 50 行写入 error.log"""
    try:
        if not log_file.exists():
            return
        text = log_file.read_text(encoding="utf-8", errors="backslashreplace")
        lines = text.split("\n")
        tail = lines[-50:] if len(lines) > 50 else lines
        error_path = run_dir / "error.log"
        error_path.write_text(
            "\n".join(tail),
            encoding="utf-8",
        )
        log.info(f"Error log written / 错误日志已写入: {error_path.name} (task={task_id_short})")
    except OSError as e:
        log.warning(f"Failed to write error.log / 写入失败: {e}")
