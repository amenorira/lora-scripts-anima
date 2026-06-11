import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import socket
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


def base_dir_path():
    return Path(__file__).parents[1].absolute()

def git_tag(path: str) -> str:
    try:
        tag = subprocess.check_output(
            ["git", "-C", path, "describe", "--tags"],
            stderr=subprocess.DEVNULL,
        ).strip().decode("utf-8")
        return tag
    except Exception:
        try:
            commit = subprocess.check_output(["git", "-C", path, "rev-parse", "--short", "HEAD"]).strip().decode("utf-8")
            return f"commit {commit}"
        except Exception:
            return "<none>"


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


def is_installed(package, friendly: str = None):
    #
    # This function was adapted from code written by vladimandic: https://github.com/vladmandic/automatic/commits/master
    #

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
            # Extract version from >= or == constraint for comparison
            if '>=' in pkg:
                pkg_version = re.findall(r'>=\s*([0-9a-zA-Z.+]+)', pkg)
                pkg_version = pkg_version[0] if pkg_version else None
            elif '==' in pkg:
                pkg_version = re.findall(r'==\s*([0-9a-zA-Z.+]+)', pkg)
                pkg_version = pkg_version[0] if pkg_version else None
            else:
                pkg_version = None

            spec = None
            for try_name in (pkg_name, pkg_name.lower(), pkg_name.replace('_', '-')):
                try:
                    spec = importlib_metadata.distribution(try_name)
                    break
                except importlib_metadata.PackageNotFoundError:
                    continue

            if spec is not None:
                version = spec.metadata["Version"]
                # log.debug(f'Package version found: {pkg_name} {version}')

                if pkg_version is not None:
                    try:
                        if _Version is not None:
                            # Use proper version comparison
                            if '>=' in pkg:
                                ok = _Version(version) >= _Version(pkg_version)
                            else:
                                ok = _Version(version) == _Version(pkg_version)
                        else:
                            # Fallback to string comparison if packaging unavailable
                            if '>=' in pkg:
                                ok = version >= pkg_version
                            else:
                                ok = version == pkg_version
                    except Exception:
                        # Version parsing failed, assume mismatch
                        ok = False

                    if not ok:
                        log.info(f'Package wrong version: {pkg_name} {version} required {pkg_version}')
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

    # bnb_windows_index = os.environ.get("BNB_WINDOWS_INDEX", "https://jihulab.com/api/v4/projects/140618/packages/pypi/simple")
    bnb_package = "bitsandbytes"
    bnb_path = os.path.join(sysconfig.get_paths()["purelib"], "bitsandbytes")

    installed_bnb = is_installed("bitsandbytes")  # don't check version here
    bnb_cuda_setup = False
    if os.path.isdir(bnb_path):
        bnb_cuda_setup = len([f for f in os.listdir(bnb_path) if re.findall(r"libbitsandbytes_cuda.+?\.dll", f)]) != 0

    if not installed_bnb or not bnb_cuda_setup:
        log.error("detected wrong install of bitsandbytes, reinstall it")
        run_pip(f"uninstall bitsandbytes -y", "bitsandbytes", live=True)
        run_pip(f"install {bnb_package}", bnb_package, live=True)


def setup_onnxruntime(
        onnx_version: Optional[str] = None,
        index_url: Optional[str] = None
):
    if sys.platform == "linux":
        libc_ver = platform.libc_ver()
        if libc_ver[0] == "glibc" and libc_ver[1] <= "2.27":
            onnx_version = "1.16.3"

    onnx_version = os.environ.get("ONNXRUNTIME_VERSION", onnx_version)

    if onnx_version and not is_installed(f"onnxruntime-gpu=={onnx_version}"):
        log.info("uninstalling wrong onnxruntime version")
        run_pip(f"uninstall onnxruntime -y", "onnxruntime", live=True)
        run_pip(f"uninstall onnxruntime-gpu -y", "onnxruntime", live=True)

    if not is_installed(f"onnxruntime-gpu"):
        log.info(f"installing onnxruntime")
        pip_install("onnxruntime", onnx_version, index_url=index_url, live=True)
        pip_install("onnxruntime-gpu", onnx_version, index_url=index_url, live=True)


def run_pip(command, desc=None, live=False):
    # Use shell=False with list args to avoid shell injection
    cmd = [python_bin, "-m", "pip"] + shlex.split(command)
    return run(cmd, desc=f"Installing {desc}", errdesc=f"Couldn't install {desc}", live=live, shell=False)


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
    log.info(result.stdout.decode("utf-8").strip())
    return result.returncode == 0


def check_requirements():
    """Check and install missing packages from requirements.txt."""
    req_file = Path(__file__).parents[1] / "requirements.txt"
    if not req_file.exists():
        return

    log.info("Checking requirements / 检查依赖...")
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
        log.info("All requirements satisfied / 所有依赖已满足")


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


def check_environment():
    """Check GPU and disk space; log results via RichHandler."""

    # GPU check via nvidia-smi
    try:
        result = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            gpu_info = result.stdout.strip().split('\n')[0]
            log.info("GPU: %s", gpu_info)
        else:
            log.warning("nvidia-smi not found -- no NVIDIA GPU or driver? / 未检测到 NVIDIA GPU")
    except FileNotFoundError:
        log.warning("nvidia-smi not found -- no NVIDIA GPU or driver? / 未检测到 NVIDIA GPU")

    # Disk space
    try:
        usage = shutil.disk_usage(base_dir_path())
        free_gb = usage.free // (1024 ** 3)
        if free_gb < 10:
            log.error("Disk free: %d GB -- critically low / 磁盘空间不足", free_gb)
        elif free_gb < 30:
            log.warning("Disk free: %d GB / 磁盘剩余空间", free_gb)
        else:
            log.info("Disk free: %d GB / 磁盘剩余空间", free_gb)
    except OSError:
        pass
