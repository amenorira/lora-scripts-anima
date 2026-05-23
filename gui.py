import argparse
import asyncio
import locale
import os
import platform
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
parser.add_argument("--port", type=int, default=28000, help="Port to run the server on")
parser.add_argument("--listen", action="store_true")
parser.add_argument("--skip-prepare-environment", action="store_true")
parser.add_argument("--skip-prepare-onnxruntime", action="store_true")
parser.add_argument("--disable-tensorboard", action="store_true", help="Deprecated: TensorBoard is now disabled by default. Use --enable-tensorboard to re-enable.")
parser.add_argument("--disable-tageditor", action="store_true", help="Deprecated: Tag editor is now disabled by default. Use --enable-tageditor to re-enable.")
parser.add_argument("--enable-tensorboard", action="store_true", help="Enable legacy TensorBoard (port 6006)")
parser.add_argument("--enable-tageditor", action="store_true", help="Enable legacy Gradio tag editor (port 28001)")
parser.add_argument("--disable-auto-mirror", action="store_true")
parser.add_argument("--tensorboard-host", type=str, default="127.0.0.1", help="Port to run the tensorboard")
parser.add_argument("--tensorboard-port", type=int, default=6006, help="Port to run the tensorboard")
parser.add_argument("--localization", type=str)
parser.add_argument("--dev", action="store_true")


@catch_exception
def run_tensorboard():
    log.info("Starting tensorboard...")
    subprocess.Popen([sys.executable, "-m", "tensorboard.main", "--logdir", "logs",
                     "--host", args.tensorboard_host, "--port", str(args.tensorboard_port)])


@catch_exception
def run_tag_editor():
    log.info("Starting tageditor...")
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
    subprocess.Popen(cmd)


def launch():
    log.info("Starting lora-scripts-anima GUI...")
    log.info(f"Base directory: {base_dir_path()}, Working directory: {os.getcwd()}")
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

    # 检测 flash-attn 状态
    try:
        from importlib.metadata import version as pkg_version
        fa_ver = pkg_version("flash_attn")
        log.info(f"flash_attn: OK (版本 {fa_ver})")
    except Exception:
        log.info("flash_attn: NOT FOUND / 未安装 — RTX 40/50 系建议运行 install-flash-attn 脚本")

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

    if args.enable_tensorboard:
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
    log.info(f"Server started at {url_new}")
    uvicorn.run("backend.app:app", host=args.host, port=args.port, log_level="error", reload=args.dev)


if __name__ == "__main__":
    args, _ = parser.parse_known_args()
    launch()
