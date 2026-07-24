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
from pathlib import Path
from typing import List, Optional

from importlib import metadata as importlib_metadata

try:
    from packaging.version import Version as _Version
except ImportError:
    _Version = None

from backend.log import log

python_bin = sys.executable


def decode_subprocess_output(output: bytes | str | None) -> str:
    """Decode captured command output without assuming Windows tools emit UTF-8."""
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
    """Run a command with binary pipes, then decode stdout/stderr defensively."""
    if any(key in kwargs for key in ("capture_output", "stdout", "stderr", "text", "encoding", "errors")):
        raise TypeError("run_capture_text manages subprocess output arguments")
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    return subprocess.CompletedProcess(
        result.args,
        result.returncode,
        decode_subprocess_output(result.stdout),
        decode_subprocess_output(result.stderr),
    )


def base_dir_path():
    return Path(__file__).parents[1].absolute()

_GIT_TAG_CACHE: dict[str, str] = {}


def git_tag(path: str) -> str:
    if path in _GIT_TAG_CACHE:
        return _GIT_TAG_CACHE[path]
    try:
        tag = subprocess.check_output(
            ["git", "-C", path, "describe", "--tags"],
            stderr=subprocess.DEVNULL,
        )
        tag = decode_subprocess_output(tag).strip()
        _GIT_TAG_CACHE[path] = tag
        return tag
    except Exception:
        try:
            commit = decode_subprocess_output(
                subprocess.check_output(["git", "-C", path, "rev-parse", "--short", "HEAD"])
            ).strip()
            result = f"commit {commit}"
            _GIT_TAG_CACHE[path] = result
            return result
        except Exception:
            result = "<none>"
            _GIT_TAG_CACHE[path] = result
            return result


def check_dirs(dirs: List):
    for d in dirs:
        if not os.path.exists(d):
            os.makedirs(d)


def run(command,
        desc: Optional[str] = None,
        errdesc: Optional[str] = None,
        custom_env: Optional[list] = None,
        live: Optional[bool] = True,
        shell: Optional[bool] = None):

    if shell is None:
        shell = False  # Always use shell=False for safety; avoids command injection on Linux

    if desc is not None:
        print(desc)

    if live:
        result = subprocess.run(command, shell=shell, env=os.environ if custom_env is None else custom_env)
        if result.returncode != 0:
            raise RuntimeError(f"""{errdesc or 'Error running command'}.
Command: {command}
Error code: {result.returncode}""")

        return ""

    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            shell=shell, env=os.environ if custom_env is None else custom_env)

    if result.returncode != 0:
        message = f"""{errdesc or 'Error running command'}.
Command: {command}
Error code: {result.returncode}
stdout: {result.stdout.decode(encoding="utf8", errors="ignore") if len(result.stdout) > 0 else '<empty>'}
stderr: {result.stderr.decode(encoding="utf8", errors="ignore") if len(result.stderr) > 0 else '<empty>'}
"""
        raise RuntimeError(message)

    return result.stdout.decode(encoding="utf8", errors="ignore")


def _check_version(installed, constraint):
    """Check if installed version satisfies a PEP 440 constraint string.
    Handles compound constraints (commas) and all comparison operators."""
    if _Version is None:
        return True
    try:
        iv = _Version(installed)
    except Exception:
        return False

    for part in constraint.split(','):
        part = part.strip()
        if not part:
            continue
        for op in ('>=', '<=', '!=', '==', '~=', '>', '<'):
            if part.startswith(op):
                ver_str = part[len(op):].strip()
                try:
                    v = _Version(ver_str)
                except Exception:
                    continue
                if op == '==' and iv != v:
                    return False
                if op == '>=' and iv < v:
                    return False
                if op == '<=' and iv > v:
                    return False
                if op == '>' and not (iv > v):
                    return False
                if op == '<' and not (iv < v):
                    return False
                if op == '!=' and iv == v:
                    return False
                if op == '~=':
                    if iv < v:
                        return False
                    release = v.release
                    if len(release) >= 2:
                        next_major = _Version(f"{release[0] + 1}.0")
                    else:
                        next_major = _Version(f"{release[0] + 1}")
                    if iv >= next_major:
                        return False
                break
    return True


_PKG_VERSION_CACHE: dict[str, str] | None = None


def _build_pkg_version_cache() -> dict[str, str]:
    """构建 package_name → version 的反向映射（O(1) 查找，替代多次 filesystem 遍历）
    若 distributions() 不可用则回退到空 dict，is_installed 将逐包查找。"""
    cache: dict[str, str] = {}
    if not hasattr(importlib_metadata, 'distributions'):
        return cache  # Python <3.10 回退到逐包查找
    try:
        for dist in importlib_metadata.distributions():
            name = dist.metadata.get("Name", "")
            version = dist.metadata.get("Version", "")
            if name:
                cache[name.lower()] = version
                # 也注册 normalized 名称（连字符 → 下划线）
                cache[name.lower().replace('-', '_')] = version
    except Exception:
        return {}  # 构建失败时返回空 dict，强制 is_installed 回退到逐包查找
    return cache


def is_installed(package, friendly: str = None):
    #
    # This function was adapted from code written by vladimandic: https://github.com/vladmandic/automatic/commits/master
    #
    global _PKG_VERSION_CACHE
    if _PKG_VERSION_CACHE is None:
        _PKG_VERSION_CACHE = _build_pkg_version_cache()

    # Remove brackets and their contents from the line using regular expressions
    # e.g., diffusers[torch]==0.10.2 becomes diffusers==0.10.2
    package = re.sub(r'\[.*?\]', '', package)

    try:
        if friendly:
            pkgs = friendly.split()
        else:
            pkgs = [
                p
                for p in package.split()
                if not p.startswith('-') and not p.startswith('=')
            ]
            pkgs = [
                p.split('/')[-1] for p in pkgs
            ]   # get only package name if installing from URL

        for pkg in pkgs:
            # Extract package name (strip all version constraints)
            pkg_name = re.split(r'[<>=!~]', pkg)[0].strip()
            constraint_str = pkg[len(pkg_name):].strip()

            version = None
            # 从缓存查找（O(1)，如果可用）
            if _PKG_VERSION_CACHE:
                version = _PKG_VERSION_CACHE.get(pkg_name.lower())
                if version is None:
                    version = _PKG_VERSION_CACHE.get(pkg_name.lower().replace('_', '-'))

            if version is not None:
                if constraint_str and not _check_version(version, constraint_str):
                    log.info(f'Package wrong version: {pkg_name} {version} required {constraint_str}')
                    return False
                continue

            # 缓存未命中：回退到逐包 metadata 查找（兼容 distributions() 漏报的情况）
            spec = None
            for try_name in (pkg_name, pkg_name.lower(), pkg_name.replace('_', '-')):
                try:
                    spec = importlib_metadata.distribution(try_name)
                    break
                except importlib_metadata.PackageNotFoundError:
                    continue
            if spec is not None:
                version = spec.metadata["Version"]
                if constraint_str and not _check_version(version, constraint_str):
                    log.info(f'Package wrong version: {pkg_name} {version} required {constraint_str}')
                    return False
            else:
                log.warning(f'Package version not found: {pkg_name}')
                return False

        return True
    except ModuleNotFoundError:
        log.warning(f'Package not installed: {pkgs}')
        return False



def setup_windows_bitsandbytes():
    if sys.platform != "win32":
        return

    bnb_package = "bitsandbytes"
    bnb_path = os.path.join(sysconfig.get_paths()["purelib"], "bitsandbytes")

    installed_bnb = is_installed("bitsandbytes")  # don't check version here
    try:
        import torch

        expected_binary = f"libbitsandbytes_cuda{torch.version.cuda.replace('.', '')}.dll" if torch.version.cuda else None
    except Exception:
        expected_binary = None
    binaries = os.listdir(bnb_path) if os.path.isdir(bnb_path) else []
    bnb_cuda_setup = expected_binary in binaries if expected_binary else any(
        re.fullmatch(r"libbitsandbytes_cuda.+?\.dll", filename) for filename in binaries
    )

    if not installed_bnb or not bnb_cuda_setup:
        log.error("detected wrong install of bitsandbytes, reinstall it")
        run_pip(f"uninstall bitsandbytes -y", "bitsandbytes", live=True)
        run_pip(f"install {bnb_package}", bnb_package, live=True)


# onnxruntime-gpu 与 CUDA 的版本对应（仅列项目用到的组合）
# 1.20.1 需 CUDA 12.x + cuDNN 9；1.27.0 需 CUDA 13 + cuDNN 9
_ORT_VERSION_BY_CUDA_MAJOR = {
    "12": "1.20.1",
    "13": "1.27.0",
}


def _resolve_ort_version_for_torch() -> Optional[str]:
    """根据已安装 torch 的 CUDA 版本返回兼容的 onnxruntime-gpu 版本。

    torch 未安装（首次启动可能还在装）或读不到 CUDA 后缀时返回 None，
    交由调用方走"不约束版本"的原有路径。
    """
    try:
        import torch  # noqa: F401
        m = re.search(r"\+cu(\d+)", torch.__version__)
        if not m:
            return None
        cuda_major = m.group(1)[:-1] if len(m.group(1)) > 1 else m.group(1)
        return _ORT_VERSION_BY_CUDA_MAJOR.get(cuda_major)
    except Exception:
        return None


def setup_onnxruntime(
        onnx_version: Optional[str] = None,
        index_url: Optional[str] = None
):
    if sys.platform == "linux":
        libc_ver = platform.libc_ver()
        if libc_ver[0] == "glibc" and libc_ver[1] <= "2.27":
            onnx_version = "1.16.3"

    # 环境变量优先（保留覆盖入口），其次按 torch CUDA 版本动态匹配
    env_ver = os.environ.get("ONNXRUNTIME_VERSION")
    if env_ver:
        onnx_version = env_ver
    elif onnx_version is None:
        resolved = _resolve_ort_version_for_torch()
        if resolved:
            onnx_version = resolved
            log.debug(f"resolved onnxruntime-gpu=={resolved} from torch CUDA build")

    if onnx_version and not is_installed(f"onnxruntime-gpu=={onnx_version}"):
        log.info("uninstalling wrong onnxruntime version")
        run_pip(f"uninstall onnxruntime -y", "onnxruntime", live=True)
        run_pip(f"uninstall onnxruntime-gpu -y", "onnxruntime", live=True)

    if not is_installed(f"onnxruntime-gpu"):
        log.info(f"installing onnxruntime")
        if is_installed("onnxruntime"):
            run_pip(f"uninstall onnxruntime -y", "onnxruntime", live=True)
        pip_install("onnxruntime-gpu", onnx_version, index_url=index_url, live=True)


def run_pip(command, desc=None, live=False):
    global _PKG_VERSION_CACHE
    # Use shell=False with list args to avoid shell injection
    cmd = [python_bin, "-m", "pip"] + shlex.split(command)
    try:
        return run(cmd, desc=f"Installing {desc}", errdesc=f"Couldn't install {desc}", live=live, shell=False)
    finally:
        # pip may add, remove, or replace a distribution in this interpreter.
        _PKG_VERSION_CACHE = None


def pip_install(package: str, version: Optional[str] = None, index_url: Optional[str] = None, live: bool = True):
    """
    Install a package using pip.
    :param package: The name of the package to install.
    :param version: The version of the package to install (optional).
    :param index_url: The index URL to use for installing the package (optional).
    """
    if version:
        package = f"{package}=={version}"

    command = f"install {package}"

    if index_url:
        command = f"{command} -i {index_url}"

    run_pip(command, desc=f"Installing {package}", live=live)


def check_run(file: str) -> bool:
    result = subprocess.run([python_bin, file], capture_output=True, shell=False)
    log.info(decode_subprocess_output(result.stdout).strip())
    return result.returncode == 0


def check_requirements():
    """Check and install missing packages from requirements.txt."""
    req_file = Path(__file__).parents[1] / "requirements.txt"
    if not req_file.exists():
        return

    log.debug("Checking requirements / 检查依赖...")
    missing = []
    with open(req_file, "r", encoding="utf-8") as f:
        for line in f:
            # Remove inline comments and strip whitespace
            line = line.split("#")[0].strip()
            if not line:
                continue
            if not is_installed(line):
                missing.append(line)

    if missing:
        log.info(f"Installing {len(missing)} missing packages / 安装 {len(missing)} 个缺失的包")
        for pkg in missing:
            try:
                run_pip(f"install {pkg}", desc=pkg, live=True)
            except Exception as e:
                log.warning(f"Failed to install {pkg}: {e}")
    else:
        log.debug("All requirements satisfied / 所有依赖已满足")


def prepare_environment(prepare_onnxruntime: bool = True):
    if sys.platform == "win32":
        # disable triton on windows
        os.environ["XFORMERS_FORCE_DISABLE_TRITON"] = "1"

    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
    os.environ["BITSANDBYTES_NOWELCOME"] = "1"
    os.environ["PYTHONWARNINGS"] = "ignore::UserWarning"
    os.environ["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"

    if not os.environ.get("PATH"):
        os.environ["PATH"] = os.path.dirname(sys.executable)

    check_dirs(["config/autosave", "logs"])

    # Check and install missing requirements
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


def catch_exception(f):
    def wrapper(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except Exception as e:
            log.error(f"An error occurred: {e}")
    return wrapper


def check_port_avaliable(port: int):
    """Check if a port is available.

    Note: TOCTOU race exists — the port may be taken between check and bind.
    Callers should handle binding failures gracefully.
    """
    try:
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))
        s.close()
        return True
    except (OSError, socket.error):
        return False


def find_avaliable_ports(port_init: int, port_range: int):
    server_ports = range(port_init, port_range)

    for p in server_ports:
        if check_port_avaliable(p):
            return p

    log.error(f"error finding available ports in range: {port_init} -> {port_range}")
    return None


_ENV_CHECKED = False


def check_environment():
    """Check GPU and disk space; log results via RichHandler.
    仅首次调用时执行 nvidia-smi（子进程耗时 ~500ms–2s），后续调用复用结果。"""
    global _ENV_CHECKED

    # GPU check via nvidia-smi（仅首次）
    if not _ENV_CHECKED:
        _ENV_CHECKED = True
        try:
            result = run_capture_text(["nvidia-smi", "-L"])
            if result.returncode == 0 and result.stdout.strip():
                gpu_info = result.stdout.strip().split('\n')[0]
                log.debug("GPU: %s", gpu_info)
            else:
                log.debug("nvidia-smi not found -- no NVIDIA GPU or driver? / 未检测到 NVIDIA GPU")
        except FileNotFoundError:
            log.debug("nvidia-smi not found -- no NVIDIA GPU or driver? / 未检测到 NVIDIA GPU")
        except PermissionError:
            # 某些容器（如 AutoDL）nvidia-smi 存在但无执行权限，不应阻断启动
            log.warning("nvidia-smi permission denied -- skipping GPU probe / 无权限执行 nvidia-smi，跳过 GPU 探测")
        except OSError:
            log.warning("nvidia-smi not executable -- no NVIDIA GPU or driver? / 无法执行 nvidia-smi")

    # Disk space
    try:
        usage = shutil.disk_usage(base_dir_path())
        free_gb = usage.free // (1024 ** 3)
        if free_gb < 10:
            log.error("Disk free: %d GB -- critically low / 磁盘空间不足", free_gb)
        elif free_gb < 30:
            log.warning("Disk free: %d GB / 磁盘剩余空间", free_gb)
        else:
            log.debug("Disk free: %d GB / 磁盘剩余空间", free_gb)
    except OSError:
        pass
