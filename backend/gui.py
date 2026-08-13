import argparse
import asyncio
import atexit
import os
import platform
import signal
import subprocess
import sys

# Install project startup compatibility before importing ML dependencies.
if sys.platform == "win32":
    from tools.python_startup import sitecustomize as _sitecustomize  # noqa: F401

# Keep direct module launches from entering dependency repair with an
# unsupported interpreter. start.bat/start.sh can select Python 3.12
# without requiring users to uninstall newer system versions.
if not (sys.version_info[:2] == (3, 12) and sys.maxsize > 2**32):
    current = platform.python_version()
    launcher = "start.bat" if sys.platform == "win32" else "start.sh"
    print(
        f"[FAIL] Unsupported Python {current} or non-64-bit interpreter.\n"
        "       Supported: 64-bit Python 3.12.\n"
        f"       Please run {launcher}; it will select a compatible Python "
        "without removing newer versions.\n"
        f"       当前 Python {current} 不受支持，请运行 {launcher}；"
        "启动脚本会选择兼容的 Python，且不会卸载现有新版 Python。",
        file=sys.stderr,
    )
    raise SystemExit(1)

# Set up the startup console before importing the heavy torch/fastapi stack.
from backend.log import log
from backend.startup_output import show_step

# Give immediate feedback while the heavy imports (torch, fastapi) load.
show_step("Loading application / 正在加载应用")

from backend.launch_utils import (base_dir_path, check_environment, git_tag,
                                   prepare_environment, check_port_available, find_available_ports)

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
        return f"http://{args.tensorboard_host}:{args.tensorboard_port}/"
    except Exception as e:
        # TensorBoard 是辅助服务：缺失/端口占用/无 GPU 环境都可能起不来，
        # 不应让它拖死主 GUI。降级为 warning，主服务照常启动。
        log.warning(
            "TensorBoard unavailable; the GUI will continue. Reason: %s / "
            "TensorBoard 不可用，主界面仍可正常使用。原因：%s",
            e, e,
        )
        return None

def launch():
    log.info(
        "Launch context: base=%s cwd=%s platform=%s python=%s executable=%s",
        base_dir_path(), os.getcwd(), platform.system(), platform.python_version(), sys.executable,
        extra={"console": False},
    )
    show_step("Checking environment / 正在检查运行环境")
    free_disk_gb = check_environment()

    if not args.skip_prepare_environment:
        prepare_environment()

    requested_port = args.port
    if not check_port_available(requested_port):
        available = find_available_ports(30000, 30000 + 20)
        if available:
            args.port = available
            log.warning(
                "Port %s is already in use; using %s instead. / "
                "端口 %s 已被占用，已改用 %s。",
                requested_port, args.port, requested_port, args.port,
            )
        else:
            log.error("port finding fallback error / 端口查找失败，无可用端口")
            sys.exit(1)

    version = git_tag(base_dir_path())
    log.info("lora-scripts-anima version: %s", version, extra={"console": False})

    # flash-attn status
    try:
        from importlib.metadata import version as pkg_version
    except ImportError:
        pkg_version = None

    try:
        fa_ver = pkg_version("flash_attn") if pkg_version else None
        if fa_ver:
            log.info("flash_attn: %s", fa_ver, extra={"console": False})
        else:
            log.info("flash_attn: not installed", extra={"console": False})
    except Exception:
        log.info("flash_attn: not installed", extra={"console": False})

    # xformers status
    try:
        xf_ver = pkg_version("xformers") if pkg_version else None
        if xf_ver:
            log.info("xformers: %s", xf_ver, extra={"console": False})
        else:
            log.info("xformers: not installed", extra={"console": False})
    except Exception:
        log.info("xformers: not installed", extra={"console": False})

    if args.listen:
        args.host = "0.0.0.0"
        args.tensorboard_host = "0.0.0.0"

    os.environ["ANIMA_HOST"] = args.host
    os.environ["ANIMA_PORT"] = str(args.port)
    os.environ["ANIMA_TENSORBOARD_HOST"] = args.tensorboard_host
    os.environ["ANIMA_TENSORBOARD_PORT"] = str(args.tensorboard_port)
    os.environ["ANIMA_DEV"] = "1" if args.dev else "0"
    os.environ["ANIMA_VERSION"] = version
    if free_disk_gb is not None:
        os.environ["ANIMA_FREE_DISK_GB"] = str(free_disk_gb)

    show_step("Starting services / 正在启动服务")
    tensorboard_url = None
    if not args.disable_tensorboard:
        tensorboard_url = run_tensorboard()
    os.environ["ANIMA_TENSORBOARD_URL"] = tensorboard_url or ""

    import uvicorn
    uvicorn.run("backend.server:app", host=args.host, port=args.port, log_level="error", reload=args.dev)


if __name__ == "__main__":
    args, _ = parser.parse_known_args()
    launch()
