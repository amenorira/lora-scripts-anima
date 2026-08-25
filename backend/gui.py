"""GUI 入口：`python -m backend.gui`。

启动顺序：解释器版本门禁 → 启动兼容性补丁 → 环境检查/依赖修复 →
端口探测 → TensorBoard 拉起 → uvicorn 托管 FastAPI。
"""
import argparse
import asyncio
import atexit
import os
import platform
import signal
import subprocess
import sys

# 项目启动兼容性补丁必须先于 ML 依赖导入
if sys.platform == "win32":
    from tools.python_startup import sitecustomize as _sitecustomize  # noqa: F401

# 直接以模块启动时也要拦住不受支持的解释器，避免半路触发依赖修复。
# start.bat/start.sh 会自动挑选 Python 3.12，无需用户卸载新版系统 Python。
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

# 控制台通道要先建好，重的 torch/fastapi 导入才有处说"正在加载"
from backend.log import log
from backend.startup_output import show_step

show_step("Loading application / 正在加载应用")

from backend.launch_utils import (
    base_dir_path,
    check_environment,
    check_port_available,
    find_available_ports,
    git_tag,
    prepare_environment,
)

# Windows 上用 SelectorEventLoop，规避 Proactor 的 ConnectionResetError 噪音
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LoRA training GUI (Anima suite)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Web UI listen host")
    parser.add_argument("--port", type=int, default=12333, help="Web UI listen port")
    parser.add_argument("--listen", action="store_true", help="Listen on 0.0.0.0 (LAN access)")
    parser.add_argument("--skip-prepare-environment", action="store_true",
                        help="Skip dependency check/repair at startup")
    parser.add_argument("--skip-prepare-onnxruntime", action="store_true",
                        help="Skip onnxruntime-gpu setup only")
    parser.add_argument("--disable-tensorboard", action="store_true",
                        help="Do not launch the bundled TensorBoard (port 6006)")
    parser.add_argument("--tensorboard-host", type=str, default="127.0.0.1")
    parser.add_argument("--tensorboard-port", type=int, default=6006)
    parser.add_argument("--localization", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--dev", action="store_true", help="Enable CORS and uvicorn reload")
    return parser


_tracked_children = []  # [(Popen, 显示名)]


def _terminate_children() -> None:
    """关停所有登记过的子进程（先 terminate 后 kill）。"""
    for proc, display_name in _tracked_children:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.info("%s stopped / %s 已停止", display_name, display_name)
    _tracked_children.clear()


def _handle_shutdown(signum=None, frame=None) -> None:
    log.info("Shutting down / 正在关闭...")
    _terminate_children()
    sys.exit(0)


signal.signal(signal.SIGINT, _handle_shutdown)
if sys.platform == "win32":
    signal.signal(signal.SIGBREAK, _handle_shutdown)
atexit.register(_terminate_children)


def start_tensorboard(host: str, port: int):
    """拉起 TensorBoard 子进程；失败降级为 warning 不拖死主界面。成功返回访问 URL。"""
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "tensorboard.main", "--logdir", "output",
             "--host", host, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # 起完立刻看一眼，排除"装上即崩"（缺包/端口占用）
        import time as _time
        _time.sleep(0.5)
        if proc.poll() is not None:
            raise RuntimeError(
                f"TensorBoard exited immediately with code {proc.returncode}. "
                f"Check if tensorboard is installed or port {port} is available."
            )
        _tracked_children.append((proc, "TensorBoard"))
        return f"http://{host}:{port}/"
    except Exception as e:
        # TensorBoard 是辅助服务：缺失/端口占用/无 GPU 都可能起不来，主服务照常
        log.warning(
            "TensorBoard unavailable; the GUI will continue. Reason: %s / "
            "TensorBoard 不可用，主界面仍可正常使用。原因：%s",
            e, e,
        )
        return None


def _report_optional_accelerators() -> None:
    """把 flash_attn / xformers 的安装状态写进日志（仅文件，不刷屏）。"""
    try:
        from importlib.metadata import version as pkg_version
    except ImportError:
        return
    for dist_name in ("flash_attn", "xformers"):
        try:
            installed = pkg_version(dist_name)
        except Exception:
            installed = None
        log.info(
            "%s: %s", dist_name, installed if installed else "not installed",
            extra={"console": False},
        )


def launch(args: argparse.Namespace) -> None:
    log.info(
        "Launch context: base=%s cwd=%s platform=%s python=%s executable=%s",
        base_dir_path(), os.getcwd(), platform.system(), platform.python_version(), sys.executable,
        extra={"console": False},
    )
    show_step("Checking environment / 正在检查运行环境")
    free_disk_gb = check_environment()

    if not args.skip_prepare_environment:
        # --skip-prepare-onnxruntime 单独跳过 onnxruntime 修复（其余依赖检查照常）
        prepare_environment(prepare_onnxruntime=not args.skip_prepare_onnxruntime)

    requested_port = args.port
    if not check_port_available(requested_port):
        fallback = find_available_ports(30000, 30000 + 20)
        if fallback is None:
            log.error("port finding fallback error / 端口查找失败，无可用端口")
            sys.exit(1)
        args.port = fallback
        log.warning(
            "Port %s is already in use; using %s instead. / 端口 %s 已被占用，已改用 %s。",
            requested_port, args.port, requested_port, args.port,
        )

    version = git_tag(base_dir_path())
    log.info("lora-scripts-anima version: %s", version, extra={"console": False})
    _report_optional_accelerators()

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
        tensorboard_url = start_tensorboard(args.tensorboard_host, args.tensorboard_port)
    os.environ["ANIMA_TENSORBOARD_URL"] = tensorboard_url or ""

    import uvicorn
    uvicorn.run("backend.server:app", host=args.host, port=args.port,
                log_level="error", reload=args.dev)


def main() -> None:
    args, _ = build_parser().parse_known_args()
    launch(args)


if __name__ == "__main__":
    main()
