"""主 venv 的环境准备与 pip 依赖管理。

约定：
- 子进程输出统一走 decode_subprocess_output（Windows 本机编码兜底）
- 依赖检测用 packaging.Requirement 解析 + importlib.metadata 查版本，
  结果缓存进 _PKG_VERSION_CACHE；任何 pip 变更后由 run_pip 失效缓存
- prepare_environment 是 gui.py 启动时唯一的编排入口
"""
from __future__ import annotations

import locale
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import sysconfig
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import List, Optional

from packaging.requirements import Requirement
from packaging.version import Version

from backend.log import log

python_bin = sys.executable


def decode_subprocess_output(output: bytes | str | None) -> str:
    """子进程输出兜底解码：先 UTF-8，失败回退本机编码（Windows 工具常输出 GBK）。"""
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    try:
        return output.decode("utf-8")
    except UnicodeDecodeError:
        get_encoding = getattr(locale, "getencoding", None)
        encoding = get_encoding() if get_encoding is not None else locale.getpreferredencoding(False)
        return output.decode(encoding, errors="replace")


def run_capture_text(command, **kwargs) -> subprocess.CompletedProcess:
    """以二进制管道跑命令，再把 stdout/stderr 兜底解码成文本返回。"""
    if any(key in kwargs for key in ("capture_output", "stdout", "stderr", "text", "encoding", "errors")):
        raise TypeError("run_capture_text manages subprocess output arguments")
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    return subprocess.CompletedProcess(
        result.args,
        result.returncode,
        decode_subprocess_output(result.stdout),
        decode_subprocess_output(result.stderr),
    )


def base_dir_path() -> Path:
    return Path(__file__).parents[1].absolute()


_GIT_TAG_CACHE: dict[str, str] = {}


def git_tag(path: str) -> str:
    """返回 git 描述（tag 或短 commit），失败为 <none>；按路径缓存避免重复起 git 进程。"""
    if path in _GIT_TAG_CACHE:
        return _GIT_TAG_CACHE[path]
    try:
        tag = subprocess.check_output(
            ["git", "-C", path, "describe", "--tags"],
            stderr=subprocess.DEVNULL,
        )
        result = decode_subprocess_output(tag).strip()
    except Exception:
        try:
            commit = decode_subprocess_output(
                subprocess.check_output(["git", "-C", path, "rev-parse", "--short", "HEAD"])
            ).strip()
            result = f"commit {commit}"
        except Exception:
            result = "<none>"
    _GIT_TAG_CACHE[path] = result
    return result


def check_dirs(dirs: List) -> None:
    for d in dirs:
        os.makedirs(d, exist_ok=True)


def _command_error(errdesc: Optional[str], command, returncode: int,
                   stdout: str = "", stderr: str = "") -> str:
    parts = [f"{errdesc or 'Error running command'}.",
             f"Command: {command}",
             f"Error code: {returncode}"]
    if stdout or stderr:
        parts.append(f"stdout: {stdout.strip() or '<empty>'}")
        parts.append(f"stderr: {stderr.strip() or '<empty>'}")
    return "\n".join(parts)


def run(command,
        desc: Optional[str] = None,
        errdesc: Optional[str] = None,
        custom_env: Optional[list] = None,
        live: Optional[bool] = True,
        shell: Optional[bool] = None):
    """跑命令。live=True 直连控制台（返回 ""），否则捕获输出并返回解码后的 stdout。

    一律默认 shell=False，规避命令注入。
    """
    if shell is None:
        shell = False
    if desc is not None:
        print(desc)

    env = os.environ if custom_env is None else custom_env
    if live:
        result = subprocess.run(command, shell=shell, env=env)
        if result.returncode != 0:
            raise RuntimeError(_command_error(errdesc, command, result.returncode))
        return ""

    result = run_capture_text(command, shell=shell, env=env)
    if result.returncode != 0:
        raise RuntimeError(_command_error(errdesc, command, result.returncode,
                                          result.stdout, result.stderr))
    return result.stdout


# ── 已安装包版本查询（快照缓存 + 逐包回退） ─────────────────

_PKG_VERSION_CACHE: dict[str, str] | None = None


def _snapshot_pkg_versions() -> dict[str, str]:
    """全量扫描已安装包，构建 name → version 映射（连字符/下划线双写）。

    扫描失败返回空 dict，调用方回退到逐包查询。
    """
    versions: dict[str, str] = {}
    try:
        for dist in importlib_metadata.distributions():
            name = (dist.metadata.get("Name") or "").strip()
            if not name:
                continue
            version = dist.metadata.get("Version") or ""
            versions[name.lower()] = version
            versions[name.lower().replace("-", "_")] = version
    except Exception:
        return {}
    return versions


def _installed_version(pkg_name: str, cache: dict[str, str]) -> Optional[str]:
    lowered = pkg_name.lower()
    for key in (lowered, lowered.replace("_", "-"), lowered.replace("-", "_")):
        if cache.get(key):
            return cache[key]
    # 缓存未命中（快照漏报或缓存被禁用）：逐包查 metadata
    for candidate in (pkg_name, lowered, lowered.replace("_", "-")):
        try:
            return importlib_metadata.distribution(candidate).metadata["Version"]
        except importlib_metadata.PackageNotFoundError:
            continue
    return None


def is_installed(requirement: str, friendly: str = None) -> bool:
    """检查 requirement 字符串（如 'diffusers[torch]==0.10.2'）是否已安装且满足版本约束。

    friendly 传入时按空格拆分优先使用（兼容旧调用）。
    """
    global _PKG_VERSION_CACHE
    if _PKG_VERSION_CACHE is None:
        _PKG_VERSION_CACHE = _snapshot_pkg_versions()

    specs = friendly.split() if friendly else [
        token for token in requirement.split()
        if not token.startswith("-") and not token.startswith("=")
    ]
    for spec in specs:
        # 从 URL 安装的包只取最后的包名部分
        candidate = spec.rsplit("/", 1)[-1]
        try:
            req = Requirement(candidate)
        except Exception:
            # 非 PEP 508 写法（裸 URL 等）：退化为纯包名，不做版本判断
            req = Requirement(re.split(r"[<>=!~\[]", candidate)[0].strip())
        version = _installed_version(req.name, _PKG_VERSION_CACHE)
        if version is None:
            log.warning(f"Package version not found: {req.name}")
            return False
        if req.specifier and not req.specifier.contains(version, prereleases=True):
            log.info(f"Package wrong version: {req.name} {version} required {req.specifier}")
            return False
    return True


# ── pip 变更 ─────────────────────────────────────────────

def run_pip(command: str, desc=None, live: bool = False):
    """通过当前解释器跑 pip。pip 可能增删改包，结束后必须失效版本缓存。"""
    global _PKG_VERSION_CACHE
    args = [python_bin, "-m", "pip"] + shlex.split(command)
    try:
        return run(args, desc=f"Installing {desc}", errdesc=f"Couldn't install {desc}",
                   live=live, shell=False)
    finally:
        _PKG_VERSION_CACHE = None


def pip_install(package: str, version: Optional[str] = None,
                index_url: Optional[str] = None, live: bool = True) -> None:
    """安装一个包；version/index_url 可选。"""
    requirement = f"{package}=={version}" if version else package
    command = f"install {requirement}"
    if index_url:
        command += f" -i {index_url}"
    run_pip(command, desc=requirement, live=live)


# ── 特定依赖的装机/修复逻辑 ───────────────────────────────

def setup_windows_bitsandbytes() -> None:
    """Windows 下校验 bitsandbytes 的 CUDA dll 与 torch 构建匹配，不匹配则重装。"""
    if sys.platform != "win32":
        return

    try:
        import torch
        cuda = torch.version.cuda
        expected_dll = f"libbitsandbytes_cuda{cuda.replace('.', '')}.dll" if cuda else None
    except Exception:
        expected_dll = None

    bnb_dir = Path(sysconfig.get_paths()["purelib"]) / "bitsandbytes"
    dlls = [p.name for p in bnb_dir.glob("libbitsandbytes_cuda*.dll")] if bnb_dir.is_dir() else []
    cuda_dll_ok = (expected_dll in dlls) if expected_dll else bool(dlls)

    if not is_installed("bitsandbytes") or not cuda_dll_ok:
        log.error("bitsandbytes 安装异常（未安装或 CUDA dll 与 torch 构建不匹配），正在重装 / "
                  "bitsandbytes install is broken (missing or CUDA dll mismatch); reinstalling")
        run_pip("uninstall bitsandbytes -y", "bitsandbytes", live=True)
        run_pip("install bitsandbytes", "bitsandbytes", live=True)


# onnxruntime-gpu 与 CUDA 的对应表（仅列项目用到的组合）：
# 1.20.1 需 CUDA 12.x + cuDNN 9；1.27.0 需 CUDA 13 + cuDNN 9
_ORT_VERSION_BY_CUDA_MAJOR = {
    "12": "1.20.1",
    "13": "1.27.0",
}


def _resolve_ort_version_for_torch() -> Optional[str]:
    """按已安装 torch 的 CUDA 后缀推导兼容的 onnxruntime-gpu 版本。

    torch 未装好（首次启动还在装）或读不到 CUDA 后缀时返回 None，
    由调用方走不约束版本的路径。
    """
    try:
        import torch
        match = re.search(r"\+cu(\d+)", torch.__version__)
        if not match:
            return None
        digits = match.group(1)
        cuda_major = digits[:-1] if len(digits) > 1 else digits
        return _ORT_VERSION_BY_CUDA_MAJOR.get(cuda_major)
    except Exception:
        return None


def setup_onnxruntime(onnx_version: Optional[str] = None,
                      index_url: Optional[str] = None) -> None:
    """确保 onnxruntime-gpu 就位且版本与 torch 的 CUDA 构建匹配；版本不符时整体换装。"""
    env_version = os.environ.get("ONNXRUNTIME_VERSION")
    if env_version:
        pinned = env_version
    elif onnx_version:
        pinned = onnx_version
    else:
        pinned = _resolve_ort_version_for_torch()
        if pinned:
            log.info(
                "Resolved onnxruntime-gpu==%s from torch CUDA build",
                pinned,
                extra={"console": False},
            )

    target = f"onnxruntime-gpu=={pinned}" if pinned else "onnxruntime-gpu"
    if is_installed(target):
        return

    # 目标版本不在位：清掉两种 flavors 后统一安装，避免 cpu/gpu 包互相顶包
    for package in ("onnxruntime", "onnxruntime-gpu"):
        if is_installed(package):
            run_pip(f"uninstall {package} -y", "onnxruntime", live=True)
    log.info("installing onnxruntime")
    pip_install("onnxruntime-gpu", pinned, index_url=index_url, live=True)


# ── 启动编排 ─────────────────────────────────────────────

def check_requirements() -> None:
    """对照 requirements.txt 补齐缺失依赖。"""
    req_file = Path(__file__).parents[1] / "requirements.txt"
    if not req_file.exists():
        return

    log.info("Checking requirements / 检查依赖", extra={"console": False})
    missing = []
    for raw_line in req_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if line and not is_installed(line):
            missing.append(line)

    if not missing:
        log.info("All requirements satisfied / 所有依赖已满足", extra={"console": False})
        return

    log.info(f"Installing {len(missing)} missing packages / 安装 {len(missing)} 个缺失的包")
    for package in missing:
        try:
            run_pip(f"install {package}", desc=package, live=True)
        except Exception as e:
            log.warning(f"Failed to install {package}: {e}")


def prepare_environment(prepare_onnxruntime: bool = True) -> None:
    if sys.platform == "win32":
        # Windows 上 triton 不可用，关掉 xformers 的 triton 探测
        os.environ["XFORMERS_FORCE_DISABLE_TRITON"] = "1"

    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
    os.environ["BITSANDBYTES_NOWELCOME"] = "1"
    # 不覆盖用户显式设置的过滤规则
    os.environ.setdefault("PYTHONWARNINGS", "ignore::UserWarning")
    os.environ["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"

    if not os.environ.get("PATH"):
        os.environ["PATH"] = str(Path(sys.executable).parent)

    check_dirs(["config/autosave", "logs"])

    try:
        check_requirements()
    except Exception as e:
        log.warning(f"Requirements check failed: {e} / 依赖检查失败")

    try:
        setup_windows_bitsandbytes()
    except Exception:
        log.warning("bitsandbytes setup skipped (GPU may be unavailable) / bitsandbytes 初始化跳过 (可能无 GPU)")

    if prepare_onnxruntime:
        try:
            setup_onnxruntime()
        except Exception:
            log.warning("onnxruntime-gpu setup skipped (GPU may be unavailable) / onnxruntime-gpu 初始化跳过 (可能无 GPU)")


# ── 端口与磁盘 ───────────────────────────────────────────

def check_port_available(port: int) -> bool:
    """端口空闲性探测。存在 TOCTOU 竞态：检测到绑定之间端口可能被抢，调用方需兜底绑定失败。"""
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def find_available_ports(port_init: int, port_range: int):
    """在 [port_init, port_range) 里找第一个空闲端口；找不到返回 None。"""
    for port in range(port_init, port_range):
        if check_port_available(port):
            return port
    log.error(f"error finding available ports in range: {port_init} -> {port_range}")
    return None


_ENV_CHECKED = False


def check_environment():
    """检查启动关键的磁盘余量，返回可用 GiB（检查时只跑一次）。"""
    global _ENV_CHECKED
    if _ENV_CHECKED:
        return None
    _ENV_CHECKED = True

    try:
        free_gb = shutil.disk_usage(base_dir_path()).free // (1024 ** 3)
    except OSError:
        return None

    if free_gb < 10:
        log.error(
            "Critically low disk space: %d GB free. Model downloads or checkpoints may fail; "
            "free space before training. / 磁盘空间严重不足：仅剩 %d GB，模型下载或 checkpoint "
            "保存可能失败，请先清理空间。",
            free_gb, free_gb,
        )
    elif free_gb < 30:
        log.warning(
            "Low disk space: %d GB free. Large model downloads and checkpoints need more room. / "
            "磁盘空间偏低：仅剩 %d GB，大模型下载和 checkpoint 保存可能需要更多空间。",
            free_gb, free_gb,
        )
    else:
        log.info("Disk free: %d GB / 磁盘剩余空间", free_gb, extra={"console": False})
    return free_gb
