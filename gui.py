import argparse
import asyncio
import atexit
import locale
import os
import platform
import signal
import subprocess
import sys

from backend.launch_utils import (base_dir_path, catch_exception, git_tag,
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
parser.add_argument("--disable-tensorboard", action="store_true", help="Disable TensorBoard (port 6006). TensorBoard is enabled by default.")
parser.add_argument("--disable-tageditor", action="store_true", help="Deprecated: Tag editor is now disabled by default. Use --enable-tageditor to re-enable.")
parser.add_argument("--enable-tensorboard", action="store_true", help="Deprecated: TensorBoard is now enabled by default. Use --disable-tensorboard to turn off.")
parser.add_argument("--enable-tageditor", action="store_true", help="Enable legacy Gradio tag editor (port 28001)")
parser.add_argument("--disable-auto-mirror", action="store_true")
parser.add_argument("--tensorboard-host", type=str, default="127.0.0.1", help="Port to run the tensorboard")
parser.add_argument("--tensorboard-port", type=int, default=6006, help="Port to run the tensorboard")
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


@catch_exception
def run_tensorboard():
    log.info("Starting tensorboard / 正在启动 TensorBoard...")
    proc = subprocess.Popen(
        [sys.executable, "-m", "tensorboard.main", "--logdir", "logs",
         "--host", args.tensorboard_host, "--port", str(args.tensorboard_port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _subprocesses.append((proc, "TensorBoard"))
    log.info(
        "TensorBoard started at http://%s:%s/ / TensorBoard 已启动",
        args.tensorboard_host, args.tensorboard_port,
    )


@catch_exception
def run_tag_editor():
    log.info("Starting tageditor / 正在启动标签编辑器...")
    cmd = [
        sys.executable,
        base_dir_path() / "legacy/frontend/scripts/launch.py",
        "--port", "28001",
        "--shadow-gradio-output",
        "--root-path", "/proxy/tageditor"
    ]
    if args.localization:
        cmd.extend(["--localization", args.localization])
    else:
        l = locale.getdefaultlocale()[0]
        if l and l.startswith("zh"):
            cmd.extend(["--localization", "zh-Hans"])
    proc = subprocess.Popen(cmd)
    _subprocesses.append((proc, "tag editor"))


def launch():
    log.info("Starting lora-scripts-anima GUI / 正在启动...")
    log.info(f"Base directory / 项目目录: {base_dir_path()}, Working directory / 工作目录: {os.getcwd()}")
    log.info(f"{platform.system()} Python {platform.python_version()} {sys.executable}")

    if not args.skip_prepare_environment:
        prepare_environment(disable_auto_mirror=args.disable_auto_mirror)

    if not check_port_avaliable(args.port):
        avaliable = find_avaliable_ports(30000, 30000+20)
        if avaliable:
            args.port = avaliable
        else:
            log.error("port finding fallback error")

    log.info(f"lora-scripts-anima Version: {git_tag(base_dir_path())}")

    # flash-attn status / 检测 flash-attn 状态
    try:
        from importlib.metadata import version as pkg_version
        fa_ver = pkg_version("flash_attn")
        log.info(f"flash_attn: OK (version / 版本 {fa_ver})")
    except Exception:
        log.info("flash_attn: NOT FOUND / 未安装 — RTX 40/50 series recommended: install-flash-attn scripts")

    # xformers status / 检测 xformers 状态
    try:
        xf_ver = pkg_version("xformers")
        log.info(f"xformers: OK (version / 版本 {xf_ver})")
    except Exception:
        log.info("xformers: NOT FOUND / 未安装 — pip install xformers available")

    os.environ["ANIMA_HOST"] = args.host
    os.environ["ANIMA_PORT"] = str(args.port)
    os.environ["ANIMA_TENSORBOARD_HOST"] = args.tensorboard_host
    os.environ["ANIMA_TENSORBOARD_PORT"] = str(args.tensorboard_port)
    os.environ["ANIMA_DEV"] = "1" if args.dev else "0"

    if args.listen:
        args.host = "0.0.0.0"
        args.tensorboard_host = "0.0.0.0"

    if args.enable_tageditor:
        run_tag_editor()

    if not args.disable_tensorboard:
        run_tensorboard()

    import uvicorn
    url_new = f"http://{args.host}:{args.port}/v2"
    url_legacy = f"http://{args.host}:{args.port}/"
    print()
    print("=" * 60)
    print("  lora-scripts-anima 已启动 / Server started")
    print("=" * 60)
    print(f"  新前端 / New UI :  {url_new}")
    print(f"  旧前端 / Legacy  :  {url_legacy}")
    print("=" * 60)
    print()
    log.info(f"Server started at {url_new} / 服务器已启动")
    uvicorn.run("backend.app:app", host=args.host, port=args.port, log_level="error", reload=args.dev)


if __name__ == "__main__":
    args, _ = parser.parse_known_args()
    launch()
