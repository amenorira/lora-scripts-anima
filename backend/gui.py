"""GUI 入口：`python -m backend.gui`。

启动顺序：解释器版本门禁 → 启动兼容性补丁 → 环境检查/依赖修复 →
端口探测 → uvicorn 托管 FastAPI（生命周期管理内部 TensorBoard）。
"""
import argparse
import hashlib
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

# Ensure --data-dir / --root-path CLI flags take effect in os.environ BEFORE
# importing backend.log / backend.constants / backend.server.application.
def _preapply_cli_env(argv: list[str]) -> None:
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--data-dir" and i + 1 < len(argv):
            val = argv[i + 1].strip()
            if val:
                os.environ["ANIMA_DATA_DIR"] = os.path.abspath(os.path.expanduser(val))
            i += 2
            continue
        if arg.startswith("--data-dir="):
            val = arg.split("=", 1)[1].strip()
            if val:
                os.environ["ANIMA_DATA_DIR"] = os.path.abspath(os.path.expanduser(val))
            i += 1
            continue
        if arg == "--root-path" and i + 1 < len(argv):
            val = argv[i + 1].strip().rstrip("/")
            if val:
                os.environ["ANIMA_ROOT_PATH"] = val if val.startswith("/") else "/" + val
            else:
                os.environ.pop("ANIMA_ROOT_PATH", None)
            i += 2
            continue
        if arg.startswith("--root-path="):
            val = arg.split("=", 1)[1].strip().rstrip("/")
            if val:
                os.environ["ANIMA_ROOT_PATH"] = val if val.startswith("/") else "/" + val
            else:
                os.environ.pop("ANIMA_ROOT_PATH", None)
            i += 1
            continue
        i += 1


if __name__ == "__main__":
    _preapply_cli_env(sys.argv[1:])

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


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        log.warning("Invalid integer for %s; using default %s / %s 数值无效，使用默认值 %s", name, default, name, default)
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.strip())
    except ValueError:
        log.warning("Invalid number for %s; using default %s / %s 数值无效，使用默认值 %s", name, default, name, default)
        return default


def normalize_root_path(value: str | None) -> str:
    """Normalize ASGI root_path: strip trailing '/', ensure leading '/' if non-empty."""
    if not value:
        return ""
    cleaned = value.strip().rstrip("/")
    if not cleaned:
        return ""
    if not cleaned.startswith("/"):
        cleaned = "/" + cleaned
    return cleaned


class _ExplicitPortAction(argparse.Action):
    """Record that --port was explicitly passed on the CLI."""

    def __call__(self, parser, namespace, values, option_string=None):
        setattr(namespace, self.dest, values)
        setattr(namespace, "_port_explicit", True)


def _auth_digest(value: str) -> str:
    username, _, password = value.partition(":")
    if not username or not password:
        raise argparse.ArgumentTypeError(
            "expected username:password with both fields non-empty / "
            "格式为 用户名:密码，用户名和密码均不能为空"
        )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _resolve_auth_digest(args: argparse.Namespace) -> str | None:
    """Resolve auth digest from --auth, --auth-file, or ANIMA_AUTH; scrub plaintext env."""
    env_auth = os.environ.pop("ANIMA_AUTH", None)
    if args.auth_digest is not None:
        return args.auth_digest

    auth_file = getattr(args, "auth_file", None)
    if auth_file:
        try:
            with open(auth_file, "r", encoding="utf-8") as fh:
                raw = fh.read().splitlines()
        except OSError as exc:
            log.error("Failed to read --auth-file %s: %s / 读取认证文件失败", auth_file, exc)
            raise SystemExit(2) from None
        credential = next((line.strip() for line in raw if line.strip()), "")
        try:
            return _auth_digest(credential)
        except argparse.ArgumentTypeError as exc:
            log.error("Invalid credentials in --auth-file: %s", exc)
            raise SystemExit(2) from None

    if env_auth is not None and env_auth != "":
        try:
            return _auth_digest(env_auth)
        except argparse.ArgumentTypeError as exc:
            log.error("Invalid credentials in ANIMA_AUTH: %s", exc)
            raise SystemExit(2) from None

    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LoRA training GUI (Anima suite)")
    parser.set_defaults(_port_explicit=False)
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Web UI listen host")
    parser.add_argument("--port", type=int, default=12333, action=_ExplicitPortAction,
                        help="Web UI listen port (explicitly specifying --port enables strict port mode)")
    parser.add_argument("--strict-port", action="store_true",
                        help="Fail immediately if the requested port is occupied instead of falling back")
    parser.add_argument("--listen", action="store_true", help="Listen on 0.0.0.0 (LAN access)")
    parser.add_argument("--auth", type=_auth_digest, dest="auth_digest", metavar="USERNAME:PASSWORD",
                        help="Require HTTP Basic authentication for the training UI")
    parser.add_argument("--auth-file", type=str, default=None, metavar="PATH",
                        help="Path to a file containing username:password for HTTP Basic authentication")
    parser.add_argument("--data-dir", type=str, default=None, metavar="DIR",
                        help="External base directory for models, output, config, and logs (env: ANIMA_DATA_DIR)")
    parser.add_argument("--root-path", type=str, default=None, metavar="PREFIX",
                        help="Reverse proxy mount path prefix, e.g. /proxy/12333 (env: ANIMA_ROOT_PATH)")
    parser.add_argument("--forwarded-allow-ips", type=str, default=None, metavar="IPS",
                        help="Trusted proxy IPs for X-Forwarded-* headers (default: 127.0.0.1; env: ANIMA_FORWARDED_ALLOW_IPS)")
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
    # Resolve storage, proxy, and auth env vars BEFORE importing backend.constants
    # or backend.server.application, and scrub plaintext ANIMA_AUTH before any subprocess runs.
    raw_data_dir = getattr(args, "data_dir", None)
    if raw_data_dir is None:
        raw_data_dir = os.environ.get("ANIMA_DATA_DIR")
    if raw_data_dir is not None and raw_data_dir.strip():
        os.environ["ANIMA_DATA_DIR"] = os.path.abspath(os.path.expanduser(raw_data_dir.strip()))
    elif getattr(args, "data_dir", None) == "":
        os.environ.pop("ANIMA_DATA_DIR", None)

    raw_root_path = getattr(args, "root_path", None)
    if raw_root_path is None:
        raw_root_path = os.environ.get("ANIMA_ROOT_PATH", "")
    root_path = normalize_root_path(raw_root_path)
    if root_path:
        os.environ["ANIMA_ROOT_PATH"] = root_path
    else:
        os.environ.pop("ANIMA_ROOT_PATH", None)

    if "backend.constants" in sys.modules:
        sys.modules["backend.constants"].refresh_storage_paths()

    auth_digest = _resolve_auth_digest(args)
    args.auth_digest = auth_digest
    if auth_digest is None:
        os.environ.pop("ANIMA_AUTH_DIGEST", None)
    else:
        # The reload worker needs the verifier, but child processes do not need the password.
        os.environ["ANIMA_AUTH_DIGEST"] = auth_digest

    from backend.user_defaults import ensure_user_defaults

    ensure_user_defaults()
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

    strict_port = bool(
        getattr(args, "strict_port", False)
        or getattr(args, "_port_explicit", False)
        or _env_bool("ANIMA_STRICT_PORT")
    )
    requested_port = args.port
    if not check_port_available(requested_port):
        if strict_port:
            log.error(
                "Port %s is already in use; aborting because strict port mode is enabled. / "
                "端口 %s 已被占用，已启用严格端口模式，中止启动。",
                requested_port, requested_port,
            )
            sys.exit(1)
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

    raw_forwarded = getattr(args, "forwarded_allow_ips", None)
    if raw_forwarded is None:
        raw_forwarded = os.environ.get("ANIMA_FORWARDED_ALLOW_IPS", "127.0.0.1")
    forwarded_allow_ips = raw_forwarded.strip() or "127.0.0.1"

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
    uvicorn.run(
        "backend.server:app",
        host=args.host,
        port=args.port,
        root_path=root_path,
        proxy_headers=True,
        forwarded_allow_ips=forwarded_allow_ips,
        ws_ping_interval=_env_float("ANIMA_WS_PING_INTERVAL", 25.0),
        ws_ping_timeout=_env_float("ANIMA_WS_PING_TIMEOUT", 60.0),
        timeout_keep_alive=_env_int("ANIMA_TIMEOUT_KEEP_ALIVE", 65),
        log_level="error",
        reload=args.dev,
    )


def main() -> None:
    args, _ = build_parser().parse_known_args()
    launch(args)


if __name__ == "__main__":
    main()
