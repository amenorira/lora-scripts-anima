#!/usr/bin/env python
"""flash_attn 安装工具 / flash_attn installer.

项目基线固定为 Python 3.12 + PyTorch 2.10.0+cu130 + win_amd64 / linux_x86_64，
内置对应 2 个 wheel 下载地址（不访问 GitHub API）；多镜像回退下载
（断点续传 + 本地缓存）→ pip 安装本地文件 → import 验证。
镜像下载较慢（约 0.5MB/s，240MB 约 8 分钟），慢但有效即不打断，单源 30s 无数据才切换。
Fixed baseline: Python 3.12 + PyTorch 2.10.0+cu130 + win_amd64 / linux_x86_64,
with 2 bundled wheel URLs (no GitHub API); multi-mirror download with resume
and local cache → pip install the local file → import verification.

用法 / Usage:
    python tools/install_flash_attn.py              检查并安装 / check & install
    python tools/install_flash_attn.py --force      强制重装 / force reinstall
    python tools/install_flash_attn.py --yes        非交互安装 / non-interactive
    python tools/install_flash_attn.py --url URL    指定 wheel URL 或本地 .whl / wheel URL or local .whl
    python tools/install_flash_attn.py --source mirror  镜像优先 / mirrors first
"""
from __future__ import annotations

import argparse
import importlib.metadata
import platform
import re
import subprocess
import sys
import urllib.request
import warnings
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote

_PYTHON_TAG = "cp312"
_TORCH_TAG = "torch2.10"
_CUDA_TAG = "cu130"

_WHEELS: dict[str, str] = {
    "win_amd64": (
        "https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.9.28/"
        "flash_attn-2.8.3%2Bcu130torch2.10-cp312-cp312-win_amd64.whl"
    ),
    "linux_x86_64": (
        "https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.9.0/"
        "flash_attn-2.8.3%2Bcu130torch2.10-cp312-cp312-linux_x86_64.whl"
    ),
}

# "" 为直连 / direct; ghproxy 系镜像只用于文件下载（API 一律 403） / mirrors are for file downloads only
_MIRRORS = ["", "https://ghproxy.net/", "https://gh-proxy.com/", "https://ghfast.top/"]

_FA_SOURCE_TIMEOUT = 10
_FA_DOWNLOAD_TIMEOUT = 30
_FA_WHEEL_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "flash_attn"


def detect_env() -> dict[str, Any]:
    vi = sys.version_info
    python_tag = f"cp{vi.major}{vi.minor}"
    syst = platform.system().lower()
    mach = platform.machine().lower()
    if syst == "linux" and mach == "x86_64":
        plat = "linux_x86_64"
    elif syst == "windows" and mach in ("amd64", "x86_64"):
        plat = "win_amd64"
    else:
        plat = None

    torch_ver: Optional[str] = None
    torch_tag: Optional[str] = None
    cuda_tag: Optional[str] = None
    try:
        import torch
        torch_ver = torch.__version__
        m = re.search(r"\+cu(\d+)", torch_ver)
        if m:
            cuda_tag = f"cu{m.group(1)}"
        v = torch_ver.split("+")[0].split(".")
        if len(v) >= 2:
            torch_tag = f"torch{v[0]}.{v[1]}"
    except ImportError:
        pass

    return {
        "python_tag": python_tag,
        "platform": plat,
        "torch_ver": torch_ver,
        "torch_tag": torch_tag,
        "cuda_tag": cuda_tag,
        "cuda_ver": cuda_tag[2:] if cuda_tag else None,
        "driver_cuda_ver": None,
    }


def current_status() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("flash_attn")
        return {"installed": True, "version": version}
    except importlib.metadata.PackageNotFoundError:
        return {"installed": False, "version": None}


def verify_flash_attn() -> tuple[bool, str]:
    try:
        import flash_attn  # noqa: F401
        try:
            import torch
            from flash_attn import flash_attn_func
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message=r"cudaGetDeviceCount\(\) returned cudaErrorNotSupported.*",
                    category=UserWarning,
                )
                cuda_available = torch.cuda.is_available()
            if cuda_available:
                q = torch.randn(1, 4, 1, 8, device="cuda", dtype=torch.float16)
                _ = flash_attn_func(q, q, q)
                return True, "import + CUDA forward test passed / import + CUDA forward 测试通过"
            return True, "import passed; CUDA forward skipped (GPU unavailable) / import 成功；GPU 不可用，已跳过 CUDA forward 测试"
        except Exception as e:
            return True, f"import ok but forward test failed: {e} / import 成功，但 forward 测试未通过: {e}"
    except ImportError:
        return False, "import flash_attn failed, not installed / import flash_attn 失败，未安装"
    except Exception as e:
        return False, f"import exception: {e} / import 异常: {e}"


def fetch_candidates(env: dict[str, Any], source: str = "default") -> tuple[list[dict[str, Any]], Optional[str]]:
    plat = env.get("platform")
    url = _WHEELS.get(plat) if plat else None
    if not url:
        return [], (
            f"Unsupported platform {plat}; this tool only supports win_amd64 / linux_x86_64 "
            f"/ 不支持的平台 {plat}；本工具仅支持 win_amd64 / linux_x86_64"
        )
    name = unquote(url.rsplit("/", 1)[-1])
    notes: list[dict[str, str]] = []
    usable = True

    if env.get("python_tag") != _PYTHON_TAG:
        usable = False
        notes.append({
            "key": "pythonMismatch",
            "text": f"Python mismatch (env={env.get('python_tag')}, baseline={_PYTHON_TAG}) / "
                    f"Python 版本不匹配（当前 {env.get('python_tag')}，基线 {_PYTHON_TAG}）",
        })
    if env.get("torch_tag") and env.get("torch_tag") != _TORCH_TAG:
        usable = False
        notes.append({
            "key": "torchMismatch",
            "text": f"Torch mismatch (env={env.get('torch_tag')}, baseline={_TORCH_TAG}) / "
                    f"PyTorch 版本不匹配（当前 {env.get('torch_tag')}，基线 {_TORCH_TAG}）",
        })
    if env.get("cuda_tag") and env.get("cuda_tag") != _CUDA_TAG:
        usable = False
        notes.append({
            "key": "cudaMismatch",
            "text": f"CUDA mismatch (env={env.get('cuda_tag')}, baseline={_CUDA_TAG}) / "
                    f"CUDA 版本不匹配（当前 {env.get('cuda_tag')}，基线 {_CUDA_TAG}）",
        })

    return [{"url": url, "name": name, "notes": notes, "usable": usable, "score": 0}], None


def download_urls_for(url: str, source: str = "default") -> list[str]:
    mirrors = list(_MIRRORS)
    if source == "mirror":
        mirrors = [m for m in _MIRRORS if m] + [""]
    seen: set[str] = set()
    out: list[str] = []
    for prefix in mirrors:
        u = prefix + url
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def proxy_download_url(url: str, source: str = "default") -> str:
    return download_urls_for(url, source)[0]


def _probe_size(url: str) -> Optional[int]:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "lora-scripts/install-flash-attn"})
    try:
        with urllib.request.urlopen(req, timeout=_FA_SOURCE_TIMEOUT) as resp:
            return int(resp.headers.get("Content-Length") or 0) or None
    except Exception:
        return None


def _download_from(url: str, dest: Path) -> None:
    resume_from = dest.stat().st_size if dest.exists() else 0
    headers = {"User-Agent": "lora-scripts/install-flash-attn"}
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_FA_DOWNLOAD_TIMEOUT) as resp, open(
        dest, "wb" if resp.status != 206 else "ab"
    ) as fh:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            fh.write(chunk)
            fh.flush()


def download_wheel(url: str, source: str = "default", dest_dir: Optional[Path] = None) -> Path:
    dest_dir = dest_dir or _FA_WHEEL_CACHE_DIR
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    dest = dest_dir / unquote(url.rsplit("/", 1)[-1])

    expected: Optional[int] = None
    for probe_url in download_urls_for(url, source):
        expected = _probe_size(probe_url)
        if expected is not None:
            break

    if dest.exists() and expected is not None and dest.stat().st_size == expected:
        print(f"[CACHE] Local wheel already present, reusing: {dest.name} / 本地已有完整 wheel，直接复用")
        return dest
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[RESUME] Continuing partial download: {dest.stat().st_size / (1024**2):.1f} MB / 断点续传")
    elif expected is not None:
        print(f"[DOWNLOAD] {dest.name}  ({expected / (1024**2):.1f} MB)")

    candidates = download_urls_for(url, source)
    last_tail = ""
    for i, dl_url in enumerate(candidates):
        via = "direct" if dl_url == url else "mirror"
        print(f"  [{i + 1}/{len(candidates)}] via {via}: {dl_url}")
        try:
            _download_from(dl_url, dest)
        except Exception as exc:
            last_tail = str(exc)[:200]
            print(f"  [WARN] {via} source failed: {last_tail}, trying next / {via} 源失败，切换下一个源")
            continue
        actual = dest.stat().st_size
        if expected is not None and actual != expected:
            print(f"  [WARN] size mismatch (expected {expected}, actual {actual}), removing and retrying / 大小不匹配，删除重试")
            try:
                dest.unlink()
            except OSError:
                pass
            continue
        print(f"  [OK] downloaded {actual / (1024**2):.1f} MB / 下载完成")
        return dest

    raise RuntimeError(
        f"wheel download failed after trying {len(candidates)} source(s): {last_tail} "
        f"/ 尝试 {len(candidates)} 个源后下载失败: {last_tail}"
    )


def install_wheel(url: str, source: str = "default") -> dict[str, Any]:
    print(f"\n[DOWNLOAD] {unquote(url.rsplit('/', 1)[-1])} (direct first, mirrors on failure / 直连优先，失败自动切换镜像)")

    local_file = Path(url)
    if local_file.exists():
        print(f"[LOCAL] Using local wheel file: {local_file} / 使用本地 wheel 文件")
        wheel_path = local_file
    else:
        wheel_path = download_wheel(url, source=source)

    print(f"\n[INSTALL] pip install {wheel_path.name}  (local file / 本地文件)")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--retries", "3", "--timeout", "60", str(wheel_path)],
        capture_output=True,
        text=True,
    )
    stdout = r.stdout + r.stderr
    last_tail = "\n".join(stdout.splitlines()[-40:])

    if r.returncode == 0:
        try:
            importlib.invalidate_caches()
            version = importlib.metadata.version("flash_attn")
        except Exception:
            version = None
        return {
            "installed": True,
            "version": version,
            "url": url,
            "stdout_tail": last_tail,
            "restart_required": True,
        }
    raise RuntimeError(
        f"pip install failed for {wheel_path.name} (wheel cached, retry is free) / "
        f"pip 安装失败（wheel 已缓存，重试无需重新下载）:\n{last_tail}"
    )


def _pause() -> None:
    try:
        input("Press Enter to exit... / 按 Enter 退出...")
    except (EOFError, KeyboardInterrupt):
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="flash_attn installer (baseline cu130/torch2.10/cp312) / 安装工具（基线 cu130/torch2.10/cp312）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--url", metavar="URL", help="wheel URL or local .whl path / 指定 wheel URL 或本地 .whl 路径")
    parser.add_argument("--force", action="store_true", help="force reinstall even if installed / 即使已安装也强制重装")
    parser.add_argument("--yes", "-y", action="store_true", help="non-interactive install / 非交互安装")
    parser.add_argument(
        "--source", default="default", choices=["default", "mirror"],
        help="download order: default=direct first / mirror=mirrors first (默认直连优先)",
    )
    args = parser.parse_args(argv)

    env = detect_env()
    print("=" * 62)
    print("  FlashAttention Installer (baseline cu130/torch2.10/cp312) / 安装工具")
    print("=" * 62)
    print(f"  Python  ABI : {env['python_tag']}")
    print(f"  Platform    : {env['platform'] or 'Unsupported / 不支持'}")
    print(f"  PyTorch     : {env['torch_tag'] or 'Not detected / 未检测到'}  ({env.get('torch_ver') or 'N/A'})")
    print(f"  CUDA (ABI)  : {env['cuda_tag'] or 'Not detected / 未检测到'}")
    print()

    status = current_status()
    if status["installed"]:
        print(f"[STATUS] flash_attn installed (version {status['version']}) / 已安装")
        ok, msg = verify_flash_attn()
        print(f"[VERIFY] {msg}")
        if ok and not args.force:
            print("       All good, no reinstall needed. Use --force to force reinstall. / 一切正常，无需重装。使用 --force 可强制重装。")
            print()
            _pause()
            return 0
        print("       --force specified, will reinstall... / 已指定 --force，将重新安装...")
    else:
        print("[STATUS] flash_attn not installed / 未安装")

    if not env["platform"]:
        print("\n[ERROR] Unsupported platform. Prebuilt wheels only support win_amd64 / linux_x86_64. / 不支持的平台。")
        print("       macOS / ARM Linux users: pip install flash-attn --no-build-isolation / macOS / ARM Linux 用户请改用 pip 源码安装")
        _pause()
        return 2

    if args.url:
        install_url = args.url
        print(f"\n[MANUAL] Using specified URL: {install_url} / 使用指定 URL")
    else:
        candidates, fetch_error = fetch_candidates(env, source=args.source)
        if fetch_error:
            print(f"\n[ERROR] {fetch_error}", file=sys.stderr)
            print("       Run the installer (start.bat / start.sh) first to bring the env to baseline. / 请先运行安装脚本升级到基线环境。")
            _pause()
            return 2
        install_url = candidates[0]["url"]
        if not candidates[0]["usable"]:
            print("\n[WARN] Environment does not match the fixed baseline (cu130/torch2.10/cp312)! / 当前环境与固定基线不匹配！")
            for note in candidates[0]["notes"]:
                print(f"       [WARN] {note['text']}")
            if not args.yes:
                confirm = input("Force install anyway? (y/N) / 仍然强制安装? (y/N): ").strip().lower()
                if confirm != "y":
                    print("Cancelled. / 已取消。")
                    return 0
        print(f"\n[AUTO] Wheel: {candidates[0]['name']} / 基线 wheel")

    try:
        result = install_wheel(install_url, source=args.source)
    except RuntimeError as exc:
        print(f"\n[ERROR] {exc}", file=sys.stderr)
        print("\n[TROUBLESHOOT] Common causes: / 常见原因:")
        print("       1. Network issue -> download .whl manually then use --url with local path / 网络问题 → 手动下载 .whl 后用 --url 指定本地路径")
        print("       2. pip too old -> python -m pip install --upgrade pip")
        _pause()
        return 1

    print()
    ok, msg = verify_flash_attn()
    if ok:
        print("=" * 62)
        print(f"  flash_attn {result['version'] or '(version detection failed / 版本检测失败)'} installed successfully! / 安装成功!")
        print(f"  {msg}")
        if result.get("restart_required"):
            print("  [INFO] flash_attn is a C extension. Running training processes need restart to take effect. / flash_attn 是 C 扩展，正在运行的训练进程需重启才能生效。")
        print("=" * 62)
        _pause()
        return 0

    print("=" * 62)
    print(f"  Post-install verification failed: {msg} / 安装后验证失败")
    print("  Wheel may have ABI mismatch. Re-run with --force to retry. / wheel 可能 ABI 不匹配当前环境，请重新运行并加 --force 重试。")
    print("=" * 62)
    _pause()
    return 1


if __name__ == "__main__":
    sys.exit(main())
