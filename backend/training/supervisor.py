"""
Anima Backend — 训练进程管理器

负责训练子进程的启动、环境隔离、端口检测。
解耦 backend 与 sd-scripts 的直接 import 依赖。
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from backend.log import log
from backend.tasks import TaskStatus, tm
from backend.constants import REPO_ROOT
from backend.monitor.snapshot import save_config_snapshot
from backend.training.core_registry import engine_pythonpaths, get_engine


_ATTN_CACHE: list[str] | None = None


def _detect_available_attn() -> list[str]:
    """检测可用的 attention backend（结果缓存，首次调用后复用）"""
    global _ATTN_CACHE
    if _ATTN_CACHE is not None:
        return _ATTN_CACHE

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

    _ATTN_CACHE = available
    return available


def _build_train_env(
    artifact_dir: str,
    task_id: str,
    run_dir: str | None = None,
    engine_id: str = "sd_scripts",
) -> dict:
    """构建训练子进程的环境变量"""
    env = os.environ.copy()
    engine = get_engine(engine_id)

    # 防止系统 site-packages 污染
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONWARNINGS"] = (
        "ignore::FutureWarning,ignore::UserWarning,"
        "ignore:invalid escape sequence:SyntaxWarning"
    )
    env["ACCELERATE_DISABLE_RICH"] = "1"

    # 训练输出目录
    env["ANIMA_OUTPUT_DIR"] = artifact_dir
    env["ANIMA_RUN_DIR"] = run_dir or artifact_dir
    env["ANIMA_TASK_ID"] = task_id
    repo_root = str(REPO_ROOT)
    vendor_root = str(REPO_ROOT / "vendor")
    existing_pypath = env.get("PYTHONPATH", "")

    if engine.uses_sd_scripts_hooks:
        env["LORA_SCRIPTS_TRUE_LR_LOGGING"] = "1"
        # sd-scripts needs the startup hook and vendored LyCORIS package.
        startup_hooks = str(REPO_ROOT / "tools" / "python_startup")
        new_paths = [startup_hooks, vendor_root, repo_root]
    else:
        # Musubi imports a package from vendor/musubi-tuner/src. Do not place
        # vendor/ as a whole before it: sd-scripts also owns a top-level
        # library package and can shadow musubi imports.
        env.pop("LORA_SCRIPTS_TRUE_LR_LOGGING", None)
        new_paths = [str(path) for path in engine_pythonpaths(engine_id)] + [repo_root]

    for p in existing_pypath.split(os.pathsep):
        if not p or p == vendor_root or p in new_paths:
            continue
        new_paths.append(p)
    env["PYTHONPATH"] = os.pathsep.join(new_paths)

    # 抑制 HuggingFace tokenizers 在 DataLoader fork 时刷屏的 "parallelism disabled" 警告
    if "TOKENIZERS_PARALLELISM" not in env:
        env["TOKENIZERS_PARALLELISM"] = "true"

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
    trainer_file: str = "./vendor/sd-scripts/sdxl_train_network.py",
    gpu_ids: Optional[list] = None,
    cpu_threads: int = 2,
    extra_args: Optional[list] = None,
    # output_dir 保留为旧调用兼容；新代码分别传 run_dir / artifact_dir。
    output_dir: str = "",
    run_dir: str = "",
    artifact_dir: str = "",
    output_base_dir: str = "",
    preview_enabled: bool | None = None,
    engine_id: str = "sd_scripts",
    config_argument: str | None = "--config_file",
    use_accelerate: bool = True,
    run_metadata: Optional[dict[str, Any]] = None,
    on_complete: Optional[Callable[[str], None]] = None,
) -> dict:
    """
    启动训练子进程。

    返回: {"status": "success", "data": {"task_id": ...}}
    """
    script = _get_trainer_script(trainer_file)
    engine = get_engine(engine_id)
    if engine.python_executable is not None and not engine.python_executable.is_file():
        return {
            "status": "error",
            "message": (
                f"Training runtime is not installed / 训练核心运行环境未安装: "
                f"{engine.python_executable}. Please run start.bat to provision the {engine.label} core."
            ),
        }

    # 内部运行目录保存日志/配置/TB；产物目录保存模型/断点/sample。
    control_dir = run_dir or output_dir or str(Path(toml_path).parent.parent / "output")
    artifacts_dir = artifact_dir or output_dir or control_dir

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
    args = [str(engine.python_executable or Path(sys.executable))]
    if use_accelerate:
        args.extend([
            "-m", "accelerate.commands.launch",
            "--num_cpu_threads_per_process", str(cpu_threads),
            "--quiet",
        ])
    # 多 GPU 参数
    if use_accelerate and len(validated_ids) > 1:
        args.extend(["--multi_gpu", "--num_processes", str(len(validated_ids))])
        if sys.platform == "win32":
            args.extend(["--rdzv_backend", "c10d"])
    # 训练脚本 + 可选配置参数。Krea cache pipeline uses a dataset TOML
    # argument instead of sd-scripts' config_file convention.
    args.append(str(script))
    if config_argument:
        args.extend([config_argument, toml_path])

    if extra_args:
        args.extend(extra_args)

    # ── 3. 创建任务（此时所有校验已通过）─────────────────
    task = tm.create_task(args, None)
    if not task:
        return {"status": "error", "message": "Failed to create task / 创建任务失败: max concurrency limit reached / 已达最大并发"}

    task_id = task.task_id
    task_id_short = task_id[:8]

    # Save task metadata into run directory (task_id ↔ run_dir mapping)
    try:
        metadata = {
            "trainer_file": trainer_file,
            "gpu_ids": gpu_ids,
            "output_dir": artifacts_dir,
            "preview_enabled": preview_enabled,
            "engine_id": engine_id,
        }
        if run_metadata:
            metadata.update(run_metadata)
        save_config_snapshot(
            task_id,
            toml_path,
            run_dir=control_dir,
            artifact_dir=artifacts_dir,
            output_base_dir=output_base_dir or str(Path(artifacts_dir).parent),
            extra_info=metadata,
        )
    except Exception as e:
        tm.terminate_task(task_id)
        log.error(f"Failed to save task metadata / 保存任务元数据失败: {e}")
        return {
            "status": "error",
            "message": f"Failed to initialize training monitoring / 初始化训练监控失败: {e}",
        }

    env = _build_train_env(
        artifact_dir=artifacts_dir,
        task_id=task_id,
        run_dir=control_dir,
        engine_id=engine_id,
    )
    env.update(env_extra)
    task.environ = env  # 更新 task 的环境变量

    # 日志文件放在运行文件夹内
    run_path = Path(control_dir)
    run_path.mkdir(parents=True, exist_ok=True)
    log_file = run_path / f"train_{task_id_short}.log"

    # ── 读取 run 元信息（用于控制台启动/结束简短信息）──
    run_meta = _read_run_meta(run_path, trainer_file)

    def _run():
        start_time = time.time()
        exit_code = -1
        status = "error"
        error_msg = ""

        try:
            # 打开日志文件用于捕获 stdout
            with open(log_file, "w", encoding="utf-8", errors="backslashreplace", buffering=1) as lf:
                task.execute(stdout_file=lf)
                result = task.communicate()
                exit_code = result.returncode
                if task.status is TaskStatus.TERMINATED:
                    status = "terminated"
                    error_msg = "Training terminated / 训练已终止"
                elif result.returncode != 0:
                    status = "failed"
                    error_msg = f"exit code {result.returncode}"
                else:
                    status = "completed"
        except subprocess.TimeoutExpired:
            status = "timeout"
            error_msg = "Training timed out / 训练超时"
        except Exception as e:
            status = "error"
            error_msg = str(e)[:500]
            log.debug(
                "Training exception / 训练异常 (task=%s): %s",
                task_id_short, e, exc_info=True,
            )

        duration = time.time() - start_time

        # ── B: 写入结构化训练结果 ────────────────────────
        _write_result_json(run_path, task_id, status, exit_code, error_msg, duration)
        # ── C: 失败时提取尾部错误日志 ─────────────────────
        if status != "completed":
            _write_error_tail(log_file, run_path, task_id_short)
        if on_complete:
            try:
                on_complete(status)
            except Exception as exc:
                log.warning("Training completion callback failed / 训练完成回调失败: %s", exc)

        # ── D: 控制台结束简短信息（带 run 元信息 + 时长）──
        _log_run_end(status, run_meta, duration, exit_code, task_id_short)

    coro = asyncio.to_thread(_run)
    task_handle = asyncio.create_task(coro)
    task_handle.add_done_callback(
        lambda t: log.error(f"Training background task crashed / 后台训练任务异常: {t.exception()}") if t.exception() else None
    )

    _log_run_start(run_meta, task_id_short, Path(artifacts_dir))

    return {
        "status": "success",
        "message": "Training started / 训练已启动",
        "data": {
            "task_id": task_id,
            "run_dir": str(run_path),
            "artifact_dir": str(Path(artifacts_dir)),
            "engine_id": engine_id,
        },
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
        msg = "xformers not available / xformers 不可用; falling back to torch SDPA / 降级为 torch SDPA"
        log.warning(msg)
        return "torch", msg

    if requested == "flash" and "xformers" in available:
        msg = "flash_attn not available / flash_attn 不可用; falling back to xformers / 降级为 xformers"
        log.warning(msg)
        return "xformers", msg

    if requested == "flash" and "torch" in available:
        msg = "flash_attn and xformers both unavailable / 均不可用; falling back to torch SDPA / 降级为 torch SDPA"
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
    """训练失败时，从日志中提取最后 50 行写入 error.log（只读尾部 ~10KB，避免加载整个文件）"""
    try:
        if not log_file.exists():
            return
        # 高效读取文件尾部（不加载整个文件到内存）
        with open(log_file, "rb") as f:
            f.seek(0, 2)  # SEEK_END
            size = f.tell()
            tail_bytes = max(0, size - 10_240)
            f.seek(tail_bytes)
            raw = f.read()
            # 跳过首行碎片（可能从半行开始）
            first_newline = raw.find(b"\n")
            if first_newline >= 0 and tail_bytes > 0:
                raw = raw[first_newline + 1:]
            text = raw.decode("utf-8", errors="backslashreplace")
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


# ── 控制台启动/结束简短信息辅助 ──────────────────────────────

def _read_run_meta(run_dir: Path, trainer_file: str) -> dict:
    """从 run 目录的 config.toml 读取关键元信息（用于控制台简短日志）。

    返回 {"output_name", "model", "train_type", "epochs", "total_steps"}；
    读取失败时返回空字段，不抛异常。
    """
    import re
    meta = {"output_name": "", "model": "", "train_type": "", "epochs": "", "total_steps": ""}
    # 训练类型从 trainer_file 推断
    if "anima" in trainer_file:
        meta["train_type"] = "anima-lora"
    elif "sdxl" in trainer_file:
        meta["train_type"] = "sdxl-lora"
    elif "krea2" in trainer_file:
        meta["train_type"] = "krea2-lora"
    config_file = run_dir / "config.toml"
    if not config_file.exists():
        return meta
    try:
        text = config_file.read_text(encoding="utf-8")
        for key in ("output_name", "pretrained_model_name_or_path", "dit",
                    "max_train_epochs", "max_train_steps"):
            m = re.search(rf'^{key}\s*=\s*["\']?(?P<v>[^"\'\n#]+)["\']?\s*$', text, re.MULTILINE)
            if m:
                v = m.group("v").strip().strip('"').strip("'")
                if key == "output_name":
                    meta["output_name"] = v
                elif key in {"pretrained_model_name_or_path", "dit"}:
                    meta["model"] = Path(v).name if v else ""
                elif key == "max_train_epochs":
                    meta["epochs"] = v
                elif key == "max_train_steps":
                    meta["total_steps"] = v
    except OSError:
        pass
    return meta


def _fmt_duration(seconds: float) -> str:
    """格式化时长为紧凑形式：3m 17s / 45s / 1h 2m"""
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    return f"{s // 3600}h {(s % 3600) // 60}m"


def _log_run_start(meta: dict, task_id_short: str, run_dir: Path) -> None:
    """训练开始：控制台输出带元信息的简短行（时间戳由 rich handler 自动附加）。"""
    parts = []
    if meta.get("output_name"):
        parts.append(meta["output_name"])
    if meta.get("train_type"):
        parts.append(f"({meta['train_type']})")
    if meta.get("model"):
        parts.append(f"model {meta['model']}")
    # 输出目录用相对项目根的形式（更简短）
    try:
        rel = str(run_dir).replace("\\", "/")
        # 取 output/ 之后的部分
        if "/output/" in rel:
            rel = "output/" + rel.split("/output/", 1)[1]
        parts.append(f"output {rel}")
    except Exception:
        pass
    parts.append(f"task={task_id_short}")
    detail = " · ".join(parts) if parts else f"task={task_id_short}"
    log.info(f"Training started / 训练已启动: {detail}")


def _log_run_end(status: str, meta: dict, duration: float, exit_code: int, task_id_short: str) -> None:
    """训练结束：控制台输出带时长/步数/退出码的简短行。"""
    dur = _fmt_duration(duration)
    name = meta.get("output_name") or f"task={task_id_short}"
    if status == "completed":
        step_info = ""
        if meta.get("total_steps"):
            step_info = f" · {meta['total_steps']}/{meta['total_steps']} steps"
        elif meta.get("epochs"):
            step_info = f" · {meta['epochs']} epochs"
        log.info(f"Training completed / 训练完成: {name} · elapsed {dur}{step_info} · exit {exit_code}")
    elif status == "timeout":
        log.error(f"Training timed out / 训练超时: {name} · elapsed {dur} · task={task_id_short}")
    else:
        # failed / error
        log.error(f"Training failed / 训练失败: {name} · elapsed {dur} · exit {exit_code} · details in error.log / 详见 error.log · task={task_id_short}")
