"""GUI 入口：`python -m backend.gui`。

启动顺序：解释器版本门禁 → 启动兼容性补丁 → 环境检查/依赖修复 →
端口探测 → uvicorn 托管 FastAPI（生命周期管理内部 TensorBoard）。
"""
import argparse
import asyncio
import os
import platform
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
from backend.startup_output import finish_step, show_step

if __name__ == "__main__":
    show_step("Loading application / 正在加载应用")

from backend.launch_utils import (
    app_version,
    base_dir_path,
    check_environment,
    check_port_available,
    find_available_ports,
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
                        help="Do not launch the bundled TensorBoard")
    parser.add_argument("--tensorboard-host", type=str, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--tensorboard-port", type=int, default=0,
                        help="Internal TensorBoard port (default: auto); access via /tensorboard/")
    parser.add_argument("--localization", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--dev", action="store_true", help="Enable CORS and uvicorn reload")
    return parser


def _report_optional_accelerators() -> None:
    """把 xformers 的安装状态写进日志（仅文件，不刷屏）。"""
    try:
        from importlib.metadata import version as pkg_version
    except ImportError:
        return
    for dist_name in ("xformers",):
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

    version = app_version(base_dir_path())
    log.info("lora-scripts-anima version: %s", version, extra={"console": False})
    _report_optional_accelerators()

    if args.listen:
        args.host = "0.0.0.0"
    if args.tensorboard_host is not None:
        log.warning("--tensorboard-host is deprecated and ignored / 此参数已弃用，"
                    "TensorBoard 仅监听回环地址，请通过主端口 /tensorboard/ 访问")

    os.environ["ANIMA_HOST"] = args.host
    os.environ["ANIMA_PORT"] = str(args.port)
    os.environ["ANIMA_DISABLE_TENSORBOARD"] = "1" if args.disable_tensorboard else "0"
    os.environ["ANIMA_TENSORBOARD_PORT"] = str(args.tensorboard_port)
    os.environ["ANIMA_DEV"] = "1" if args.dev else "0"
    os.environ["ANIMA_VERSION"] = version
    if free_disk_gb is not None:
        os.environ["ANIMA_FREE_DISK_GB"] = str(free_disk_gb)

    show_step("Starting services / 正在启动服务")

    import uvicorn
    if args.dev:
        # Reload mode owns a separate worker console lifecycle.
        finish_step()
    uvicorn.run("backend.server:app", host=args.host, port=args.port,
                log_level="error", reload=args.dev)


def main() -> None:
    args, _ = build_parser().parse_known_args()
    launch(args)


if __name__ == "__main__":
    main()
