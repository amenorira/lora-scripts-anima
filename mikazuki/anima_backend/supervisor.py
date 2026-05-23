"""
Anima Backend — 训练进程管理器

负责训练子进程的启动、环境隔离、端口检测。
解耦 mikazuki 与 sd-scripts 的直接 import 依赖。
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys
from pathlib import Path
from typing import Optional

from mikazuki.log import log
from mikazuki.tasks import tm


def _find_free_port(start: int = 6008, max_attempts: int = 10) -> int:
    """查找可用端口（用于 monitor）"""
    for offset in range(max_attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start  # fallback


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

    return env


def _get_trainer_script(trainer_file: str) -> Path:
    """解析训练脚本路径"""
    base = Path(__file__).parents[2]  # repo root
    script = base / trainer_file.lstrip("./")
    if not script.exists():
        raise FileNotFoundError(f"训练脚本不存在: {script}")
    return script


def run_train(
    toml_path: str,
    trainer_file: str = "./vendor/sd-scripts/train_network.py",
    gpu_ids: Optional[list] = None,
    cpu_threads: int = 2,
    extra_args: Optional[list] = None,
) -> dict:
    """
    启动训练子进程。

    返回: {"status": "success", "data": {"task_id": ...}}
    """
    script = _get_trainer_script(trainer_file)

    args = [
        sys.executable, "-m", "accelerate.commands.launch",
        "--num_cpu_threads_per_process", str(cpu_threads),
        "--quiet",
        str(script),
        "--config_file", toml_path,
    ]

    if extra_args:
        args.extend(extra_args)

    env = _build_train_env(
        output_dir=Path(toml_path).parent.parent / "output",
        task_id="",
    )

    # GPU 配置
    if gpu_ids:
        env["CUDA_VISIBLE_DEVICES"] = ",".join(str(g) for g in gpu_ids)
        if len(gpu_ids) > 1:
            args[3:3] = ["--multi_gpu", "--num_processes", str(len(gpu_ids))]
            if sys.platform == "win32":
                env["USE_LIBUV"] = "0"
                args[3:3] = ["--rdzv_backend", "c10d"]

    # 创建任务
    task = tm.create_task(args, env)
    if not task:
        return {"status": "error", "message": "任务创建失败：已达到最大并发限制"}

    task_id = task.task_id
    env["ANIMA_TASK_ID"] = task_id

    def _run():
        try:
            task.execute()
            result = task.communicate()
            if result.returncode != 0:
                log.error(f"训练失败 (task={task_id[:8]})")
            else:
                log.info(f"训练完成 (task={task_id[:8]})")
        except Exception as e:
            log.error(f"训练异常 (task={task_id[:8]}): {e}")

    coro = asyncio.to_thread(_run)
    asyncio.create_task(coro)

    log.info(f"训练已启动: {task_id[:8]} ({Path(toml_path).name})")

    return {
        "status": "success",
        "message": f"训练已启动",
        "data": {"task_id": task_id},
    }


def terminate_train(task_id: str) -> bool:
    """终止训练"""
    try:
        tm.terminate_task(task_id)
        return True
    except Exception as e:
        log.error(f"终止训练失败: {e}")
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
        msg = f"xformers 不可用，自动降级为 torch SDPA"
        log.warning(msg)
        return "torch", msg

    if requested == "flash" and "xformers" in available:
        msg = f"flash_attn 不可用，自动降级为 xformers"
        log.warning(msg)
        return "xformers", msg

    if requested == "flash" and "torch" in available:
        msg = f"flash_attn/xformers 均不可用，降级为 torch SDPA"
        log.warning(msg)
        return "torch", msg

    return requested, ""
