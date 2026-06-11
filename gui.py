import argparse
import asyncio
import atexit
import os
import platform
import signal
import subprocess
import sys

# Immediate feedback before heavy imports (torch, fastapi, rich)
print("Initializing...", flush=True)

from backend.launch_utils import (base_dir_path, catch_exception, check_environment, git_tag,
                                   prepare_environment, check_port_avaliable, find_avaliable_ports)
from backend.log import log

# Windows: use SelectorEventLoop to avoid Proactor "ConnectionResetError" noise
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

parser = argparse.ArgumentParser(description="GUI for stable diffusion training")
parser.add_argument("--host", type=str, default="127.0.0.1")
parser.add_argument("--port", type=int, default=12333, help="Port to run the server on")
parser.add_argument("--listen", action="store_true")
parser.add_argument("--skip-prepare-environment", action="store_true")
parser.add_argument("--skip-prepare-onnxruntime", action="store_true")
parser.add_argument("--disable-tensorboard", action="store_true", help="Disable TensorBoard (port 6006)")
parser.add_argument("--tensorboard-host", type=str, default="127.0.0.1")
parser.add_argument("--tensorboard-port", type=int, default=6006)
parser.add_argument("--localization", type=str)
parser.add_argument("--dev", action="store_true")

# ── Subprocess tracking ──
_subprocesses = []  # list of (Popen, name)


def _cleanup_subprocesses():
    """Terminate all tracked child processes."""
    for proc, name in _subprocesses:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.info("%s stopped / %s 已停止", name, name)
    _subprocesses.clear()


def _shutdown(signum=None, frame=None):
    """Graceful shutdown: clean up subprocesses, then exit."""
    log.info("Shutting down / 正在关闭...")
    _cleanup_subprocesses()
    sys.exit(0)


signal.signal(signal.SIGINT, _shutdown)
if sys.platform == "win32":
    signal.signal(signal.SIGBREAK, _shutdown)
atexit.register(_cleanup_subprocesses)


def run_tensorboard():
    log.info("Starting tensorboard / 正在启动 TensorBoard...")
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "tensorboard.main", "--logdir", "output",
             "--host", args.tensorboard_host, "--port", str(args.tensorboard_port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # 检查进程是否立即崩溃
        import time as _time
        _time.sleep(0.5)
        if proc.poll() is not None:
            raise RuntimeError(
                f"TensorBoard exited immediately with code {proc.returncode}. "
                f"Check if tensorboard is installed or port {args.tensorboard_port} is available."
            )
        _subprocesses.append((proc, "TensorBoard"))
        log.info(
            "TensorBoard started at http://%s:%s/ / TensorBoard 已启动",
            args.tensorboard_host, args.tensorboard_port,
        )
    except Exception as e:
        log.error(f"TensorBoard failed to start: {e}")
        # 不静默吞掉异常，让用户感知
        raise

def launch():
    log.info("Starting lora-scripts-anima GUI / 正在启动...")
    log.info(f"Base directory / 项目目录: {base_dir_path()}, Working directory / 工作目录: {os.getcwd()}")
    log.info(f"{platform.system()} Python {platform.python_version()} {sys.executable}")
    check_environment()

    if not args.skip_prepare_environment:
        prepare_environment()

    if not check_port_avaliable(args.port):
        avaliable = find_avaliable_ports(30000, 30000 + 20)
        if avaliable:
            args.port = avaliable
        else:
            log.error("port finding fallback error / 端口查找失败，无可用端口")
            sys.exit(1)

    log.info(f"lora-scripts-anima Version: {git_tag(base_dir_path())}")

    # flash-attn status
    try:
        from importlib.metadata import version as pkg_version
    except ImportError:
        pkg_version = None

    try:
        fa_ver = pkg_version("flash_attn") if pkg_version else None
        if fa_ver:
            log.info(f"flash_attn: OK (version / 版本 {fa_ver})")
        else:
            log.info("flash_attn: NOT FOUND / 未安装")
    except Exception:
        log.info("flash_attn: NOT FOUND / 未安装")

    # xformers status
    try:
        xf_ver = pkg_version("xformers") if pkg_version else None
        if xf_ver:
            log.info(f"xformers: OK (version / 版本 {xf_ver})")
        else:
            log.info("xformers: NOT FOUND / 未安装")
    except Exception:
        log.info("xformers: NOT FOUND / 未安装")

    if args.listen:
        args.host = "0.0.0.0"
        args.tensorboard_host = "0.0.0.0"

    os.environ["ANIMA_HOST"] = args.host
    os.environ["ANIMA_PORT"] = str(args.port)
    os.environ["ANIMA_TENSORBOARD_HOST"] = args.tensorboard_host
    os.environ["ANIMA_TENSORBOARD_PORT"] = str(args.tensorboard_port)
    os.environ["ANIMA_DEV"] = "1" if args.dev else "0"

    if not args.disable_tensorboard:
        run_tensorboard()

    import uvicorn
    uvicorn.run("backend.server:app", host=args.host, port=args.port, log_level="error", reload=args.dev)


if __name__ == "__main__":
    args, _ = parser.parse_known_args()
    launch()
