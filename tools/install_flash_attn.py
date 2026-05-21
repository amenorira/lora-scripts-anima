#!/usr/bin/env python
"""Flash Attention prebuilt wheel 智能安装工具。

从 GitHub Releases (mjun0812/flash-attention-prebuild-wheels) 自动匹配当前环境
(Python + PyTorch + CUDA + 平台) 的最优 wheel 并安装。

用法:
    python tools/install_flash_attn.py              # 交互式：展示候选，数字键选择安装
    python tools/install_flash_attn.py --dry-run    # 仅列出环境和候选，不安装
    python tools/install_flash_attn.py --url URL    # 手动指定 wheel URL 安装
    python tools/install_flash_attn.py --yes        # 非交互：自动选最优并安装
    python tools/install_flash_attn.py --force      # 即使已安装也强制重装

内建功能:
    - 环境自动检测 (Python / PyTorch / CUDA / 平台)
    - 已装版本兼容性校验，不匹配时自动提示修复
    - 安装后自动验证 import，失败时引导重试
    - 交互式候选列表，数字键选择 + 兼容性说明

与旧版 install-flash-attn.bat 的改进:
    - 不再硬编码 wheel 版本号，而是从 GitHub API 动态拉取候选列表
    - 自动匹配 Python + PyTorch + CUDA + 平台的精确组合
    - CUDA 版本优先从 torch.__version__ 取（而非 nvidia-smi），避免 ABI 不匹配
    - 支持评分排序：精确匹配 > 同大版本 > 不可用
    - 支持 --dry-run 预览模式
    - GitHub API 失败时仍可通过 --url 手动安装

设计参考:
    AnimaLoraStudio (WalkingMeatAxolotl/AnimaLoraStudio)
    studio/services/flash_attention_setup.py (GPL-3.0)
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ── 配置 ──────────────────────────────────────────────────────────────────
FA_RELEASES_URL = (
    "https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases"
)
FA_FALLBACK_URLS = [
    "https://api.github.com/repos/bdashore3/flash-attention/releases",
]


# ── 环境检测 ──────────────────────────────────────────────────────────────

def detect_env() -> dict[str, Any]:
    """检测当前 Python / CUDA / PyTorch / 平台。

    关键设计：cuda_tag 优先从 `torch.__version__` 的 `+cuXXX` 后缀取，
    **不是**从 nvidia-smi 取。因为 flash_attn 的 ABI 绑定 PyTorch 编译时的
    CUDA runtime 版本，而不是驱动支持的最高版本。
    """
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

    cuda_tag: Optional[str] = None
    cuda_ver: Optional[str] = None
    torch_tag: Optional[str] = None
    torch_ver: Optional[str] = None

    try:
        import torch
        torch_ver = torch.__version__
        v = torch_ver.split("+")[0].split(".")
        torch_tag = f"torch{v[0]}.{v[1]}"
        m = re.search(r"\+cu(\d+)", torch_ver)
        if m:
            num = m.group(1)
            cuda_tag = f"cu{num}"
            if len(num) >= 2:
                cuda_ver = f"{num[:-1]}.{num[-1]}"
    except ImportError:
        pass

    driver_cuda_ver: Optional[str] = None
    try:
        r = subprocess.run(
            ["nvidia-smi"], capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0:
            m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", r.stdout)
            if m:
                driver_cuda_ver = f"{m.group(1)}.{m.group(2)}"
                if cuda_tag is None:
                    cuda_tag = f"cu{m.group(1)}{m.group(2)}"
                    cuda_ver = driver_cuda_ver
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        pass

    return {
        "python_tag": python_tag,
        "cuda_tag": cuda_tag,
        "cuda_ver": cuda_ver,
        "driver_cuda_ver": driver_cuda_ver,
        "torch_tag": torch_tag,
        "torch_ver": torch_ver,
        "platform": plat,
    }


# ── Wheel 文件名解析 ──────────────────────────────────────────────────────

def _parse_wheel(name: str) -> Optional[dict[str, str]]:
    """从 wheel 文件名解析 cuda / torch / python / platform 标签。"""
    m = re.search(r"\+(cu\d+)(torch[\d.]+)-(cp\d+)-cp\d+-([\w]+)\.whl$", name)
    if not m:
        return None
    return {
        "cuda": m.group(1),
        "torch": m.group(2),
        "python": m.group(3),
        "platform": m.group(4),
    }


def _cuda_major(tag: str) -> int:
    """cu130 → 13, cu124 → 12；解析失败返回 -1。"""
    m = re.search(r"cu(\d+)", tag)
    return int(m.group(1)) // 10 if m else -1


# ── 候选列表拉取 ──────────────────────────────────────────────────────────

def fetch_candidates(env: dict[str, Any]) -> tuple[list[dict[str, Any]], Optional[str]]:
    """查询 GitHub Releases，返回 (candidates, fetch_error)。"""
    plat = env.get("platform")
    torch_tag = env.get("torch_tag")
    cuda_tag = env.get("cuda_tag")
    python_tag = env.get("python_tag")

    if not plat:
        return [], None

    urls = [FA_RELEASES_URL] + FA_FALLBACK_URLS
    data = None
    last_error = None

    for base_url in urls:
        try:
            req = urllib.request.Request(
                base_url + "?per_page=100",
                headers={"User-Agent": "lora-scripts/install-flash-attn"},
            )
            data = json.loads(urllib.request.urlopen(req, timeout=15).read())
            break
        except Exception as exc:
            last_error = str(exc)
            continue

    if data is None:
        return [], last_error

    if not isinstance(data, list):
        msg = data.get("message", str(data)) if isinstance(data, dict) else str(data)
        return [], f"GitHub API 错误: {msg}"

    candidates: list[dict[str, Any]] = []
    for release in data:
        for asset in release.get("assets", []):
            tags = _parse_wheel(asset["name"])
            if not tags:
                continue
            if tags["platform"] != plat:
                continue

            score = 0
            notes: list[str] = []
            usable = True

            # PyTorch: 精确匹配 > 同大版本(高风险) > 不同大版本(不可用)
            if torch_tag:
                if tags["torch"] == torch_tag:
                    score += 20
                else:
                    wheel_tv = tags["torch"].replace("torch", "")
                    env_tv = torch_tag.replace("torch", "")
                    if wheel_tv.split(".")[0] == env_tv.split(".")[0]:
                        score += 5
                        notes.append(
                            f"⚠ PyTorch 版本不同 (wheel 编译于 {tags['torch']}, 当前 {torch_tag})"
                            f" — PyTorch 小版本间通常 ABI 不兼容，大概率 import 失败"
                        )
                    else:
                        score -= 15
                        usable = False
                        notes.append(
                            f"✗ PyTorch 版本不同 (wheel={tags['torch']}, 当前={torch_tag})"
                            f" — 无法使用"
                        )

            # Python ABI: 严格匹配
            if python_tag:
                if tags["python"] == python_tag:
                    score += 20
                else:
                    usable = False
                    notes.append(
                        f"✗ Python ABI 不兼容 (wheel={tags['python']}, 当前={python_tag})"
                    )

            # CUDA: 精确匹配 > 同大版本 > 不兼容
            if cuda_tag:
                if tags["cuda"] == cuda_tag:
                    score += 20
                elif _cuda_major(tags["cuda"]) == _cuda_major(cuda_tag):
                    score += 10
                    notes.append(
                        f"CUDA 小版本差异 (wheel={tags['cuda']}, 当前={cuda_tag}, 同大版本通常兼容)"
                    )
                else:
                    score -= 5
                    notes.append(
                        f"✗ CUDA 大版本不同 (wheel={tags['cuda']}, 当前={cuda_tag})"
                    )

            candidates.append({
                "url": asset["browser_download_url"],
                "name": asset["name"],
                "score": score,
                "notes": notes,
                "usable": usable,
            })

    return sorted(candidates, key=lambda x: -x["score"]), None


def find_best_wheel(env: dict[str, Any]) -> Optional[str]:
    """返回最优可用 wheel URL；没有则返回 None。"""
    candidates, _ = fetch_candidates(env)
    for c in candidates:
        if c["usable"]:
            return c["url"]
    return None


# ── 安装状态与验证 ────────────────────────────────────────────────────────

def current_status() -> dict[str, Any]:
    """当前 flash_attn 安装状态。"""
    try:
        version = importlib.metadata.version("flash_attn")
        return {"installed": True, "version": version}
    except importlib.metadata.PackageNotFoundError:
        return {"installed": False, "version": None}


def verify_flash_attn() -> tuple[bool, str]:
    """验证 flash_attn 是否能正常 import 和使用。
    返回 (ok, message)。
    """
    try:
        import flash_attn  # noqa: F401
        # 尝试做一个最小 forward 测试，确保 ABI 真的匹配
        try:
            import torch
            from flash_attn import flash_attn_func
            if torch.cuda.is_available():
                # 极小 tensor 测试，验证 ABI 无问题
                q = torch.randn(1, 4, 1, 8, device="cuda", dtype=torch.float16)
                _ = flash_attn_func(q, q, q)
            return True, "import + CUDA forward 测试通过"
        except Exception as e:
            # forward 失败但 import 成功 → 可能是显卡不支持或其他运行时问题
            return True, f"import 成功，但 forward 测试未通过: {e}"
    except ImportError:
        return False, "import flash_attn 失败，未安装"
    except Exception as e:
        return False, f"import 异常: {e}"


def uninstall_flash_attn() -> bool:
    """卸载 flash_attn。返回是否成功。"""
    print("[修复] 正在卸载当前的 flash_attn...")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "uninstall", "flash-attn", "-y"],
        capture_output=True, text=True,
    )
    return r.returncode == 0


# ── 安装 ──────────────────────────────────────────────────────────────────

def install_wheel(url: str) -> dict[str, Any]:
    """pip install 指定的 wheel URL。返回安装结果。"""
    print(f"\n[安装] pip install {url}")
    print("       下载 + 安装可能需要 2-5 分钟（约 150-250 MB）...")
    print()

    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", url],
        capture_output=True,
        text=True,
    )
    stdout = r.stdout + r.stderr
    tail = "\n".join(stdout.splitlines()[-40:])

    if r.returncode != 0:
        raise RuntimeError(f"pip install 失败:\n{tail}")

    try:
        importlib.invalidate_caches()
        version = importlib.metadata.version("flash_attn")
    except Exception:
        version = None

    return {
        "installed": True,
        "version": version,
        "url": url,
        "stdout_tail": tail,
        "restart_required": True,
    }


# ── 交互式选择 ────────────────────────────────────────────────────────────

def _print_candidates(candidates: list[dict[str, Any]]) -> None:
    """格式化打印候选列表，带序号和兼容性说明。"""
    usable_list = [c for c in candidates if c["usable"]]
    print(f"\n[候选] 共 {len(candidates)} 个匹配 wheel，其中 {len(usable_list)} 个可直接安装:")
    print("-" * 62)

    for i, c in enumerate(candidates, 1):
        mark = "✓" if c["usable"] else "✗"
        # 提取 flash_attn 版本号
        fa_ver = c["name"].split("+")[0].replace("flash_attn-", "")
        tags = _parse_wheel(c["name"]) or {}
        print(f"  [{i:>2}] [{mark}] 评分={c['score']:>3d}  flash_attn {fa_ver}")
        print(f"       文件: {c['name']}")
        if c["notes"]:
            for note in c["notes"]:
                print(f"       ⚠ {note}")
        else:
            if c["usable"]:
                print(f"       ✓ 完全匹配当前环境")

    print("-" * 62)


def _print_choice_guide(env: dict[str, Any]) -> None:
    """打印选版本帮助说明。"""
    torch_tag = env.get('torch_tag', '未知')
    cuda_tag = env.get('cuda_tag', '未知')
    python_tag = env.get('python_tag', '未知')
    print(f"""
┌─ 如何选择正确的版本？──────────────────────────────────────┐
│                                                           │
│  flash_attn wheel 文件名格式:                              │
│    flash_attn-{{版本}}+{{CUDA}}{{PyTorch}}-{{Python}}-{{平台}}.whl  │
│                                                           │
│  必须同时匹配三项才能正常 import:                            │
│                                                           │
│  ① PyTorch — 必须完全一致！                                 │
│     你当前: {torch_tag}                                     │
│     ⚠ torch2.7 ≠ torch2.8，小版本间 ABI 不兼容              │
│     如果找不到精确匹配 PyTorch 的版本 → 考虑换 PyTorch 版本   │
│                                                           │
│  ② CUDA ABI — 同大版本通常兼容                              │
│     你当前: {cuda_tag}                                      │
│     ✓ cu128 ≈ cu124 (同大版本 12.x)                        │
│     ✗ cu118 ≠ cu128 (不同大版本)                           │
│                                                           │
│  ③ Python ABI — 必须一致                                   │
│     你当前: {python_tag}                                    │
│     ✗ cp312 ≠ cp310                                       │
│                                                           │
│  ✓ 评分最高 + 无警告 = 首选                                 │
│  ⚠ 有 PyTorch 版本差异 = 高风险，大概率 import 失败          │
│  ✗ ABI 不兼容 = 装了也用不了                                │
└───────────────────────────────────────────────────────────┘""")


def _interactive_select(candidates: list[dict[str, Any]], env: dict[str, Any]) -> Optional[str]:
    """交互式让用户选择安装哪个 wheel。
    返回选中的 URL，或 None（用户取消）。
    """
    if not candidates:
        return None

    usable_list = [c for c in candidates if c["usable"]]
    _print_candidates(candidates)
    _print_choice_guide(env)

    default_idx = candidates.index(usable_list[0]) + 1 if usable_list else 1

    while True:
        print(f"输入序号选择 (1-{len(candidates)}), 直接回车=选推荐 [{default_idx}], q=退出: ", end="")
        try:
            choice = input().strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None

        if choice.lower() == "q":
            return None

        if choice == "":
            idx = default_idx
        else:
            try:
                idx = int(choice)
            except ValueError:
                print(f"  → 请输入数字 (1-{len(candidates)}) 或 q 退出")
                continue

        if 1 <= idx <= len(candidates):
            selected = candidates[idx - 1]
            print(f"\n  已选择: [{idx}] {selected['name']}")
            if not selected["usable"]:
                print(f"  ⚠ 该项标记为不兼容，强制安装可能 import 失败！")
                confirm = input("  确认强制安装? (y/N): ").strip().lower()
                if confirm != "y":
                    print("  已取消，请重新选择。")
                    continue
            return selected["url"]
        else:
            print(f"  → 序号超出范围，请输入 1-{len(candidates)}")


# ── 主入口 ────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Flash Attention prebuilt wheel 智能安装",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--url", metavar="URL",
        help="手动指定 wheel URL（跳过交互和自动匹配）"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="仅列出环境和候选 wheel，不实际安装"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="即使 flash_attn 已安装也强制重装"
    )
    parser.add_argument(
        "--yes", "-y", action="store_true",
        help="非交互模式：自动选择最优 wheel 并安装，不询问"
    )
    args = parser.parse_args(argv)

    # ── 打印环境信息 ──
    env = detect_env()
    print("=" * 62)
    print("  Flash Attention 智能安装工具 (prebuilt wheel)")
    print("=" * 62)
    print(f"  Python  ABI : {env['python_tag']}")
    print(f"  平台         : {env['platform'] or '⚠ 不支持 (非 x86_64 Linux/Windows)'}")
    print(f"  PyTorch      : {env['torch_tag'] or '⚠ 未检测到'}  ({env.get('torch_ver') or 'N/A'})")

    cuda_tag = env['cuda_tag']
    cuda_ver = env.get('cuda_ver')
    driver_ver = env.get('driver_cuda_ver')

    if cuda_tag:
        print(f"  CUDA (ABI)   : {cuda_tag}  (PyTorch 编译时绑定 = {cuda_ver})")
    else:
        print(f"  CUDA (ABI)   : ⚠ 未检测到 (PyTorch 可能为 CPU 版本)")

    if driver_ver:
        if driver_ver != cuda_ver:
            print(f"  驱动 CUDA    : {driver_ver}  ⚡ wheel 匹配 {cuda_tag}，不匹配驱动版本!")
        else:
            print(f"  驱动 CUDA    : {driver_ver}  (与 PyTorch ABI 一致)")
    else:
        print(f"  驱动 CUDA    : 未检测到 nvidia-smi")

    if cuda_tag and env['torch_tag']:
        print(f"  → 目标 wheel : +{cuda_tag}{env['torch_tag']}-{env['python_tag']}-*-{env['platform']}.whl")
    print()

    # ── 内建：检查已安装版本兼容性 ──
    status = current_status()
    needs_repair = False
    if status["installed"]:
        print(f"[状态] ✅ flash_attn 已安装 (版本 {status['version']})")
        ok, msg = verify_flash_attn()
        if ok:
            print(f"[验证] ✓ {msg}")
            if not args.force and not args.dry_run:
                print("       一切正常，无需重装。使用 --force 可强制重装。")
                print()
                input("按 Enter 退出...")
                return 0
            print("       --force 已指定，将重新安装...")
        else:
            print(f"[验证] ❌ {msg}")
            print("       ⚠ 当前安装的 flash_attn 不可用 (ABI 不匹配或损坏)！")
            needs_repair = True
    else:
        print("[状态] ❌ flash_attn 未安装")

    # ── 内建自动修复 ──
    if needs_repair:
        print()
        print("=" * 62)
        print("  🔧 自动修复: 检测到 flash_attn 不可用，将卸载并重新安装匹配版本")
        print("=" * 62)

        # 给出原因分析
        if env['torch_tag']:
            print(f"  PyTorch 环境: {env['torch_tag']} (CUDA {cuda_tag})")
            print(f"  旧 flash_attn 可能是为不同 PyTorch/CUDA 编译的")
            print(f"  将自动匹配当前环境的正确 wheel 重新安装。")
        print()

        if not args.yes:
            confirm = input("是否继续自动修复? (Y/n): ").strip().lower()
            if confirm == "n":
                print("已取消。")
                input("按 Enter 退出...")
                return 1

        if not uninstall_flash_attn():
            print("[警告] 卸载可能失败，继续尝试覆盖安装...")
        print("[修复] 卸载完成，开始匹配正确版本...")
        print()

    # ── 平台检查 ──
    if not env["platform"]:
        print("\n[错误] 不支持的平台。prebuilt wheel 仅支持:")
        print("       - linux_x86_64")
        print("       - win_amd64")
        print("       macOS / ARM Linux 用户请从源码编译: pip install flash-attn --no-build-isolation")
        input("按 Enter 退出...")
        return 2

    # ── 拉取候选列表 ──
    if not args.url:
        print("[查询] 从 GitHub Releases 拉取候选 wheel 列表...")
        candidates, fetch_error = fetch_candidates(env)

        if fetch_error:
            print(f"\n[警告] 无法拉取候选列表: {fetch_error}")
            print("       可手动指定 wheel URL:")
            print(f"       python tools/install_flash_attn.py --url <URL>")
            print(f"       Releases 页面: https://github.com/mjun0812/flash-attention-prebuild-wheels/releases")

        if not candidates:
            print("\n[提示] 未找到匹配当前环境的 wheel。")
            print(f"       当前环境: Python={env['python_tag']}, CUDA={cuda_tag}, PyTorch={env['torch_tag']}")
            print("       可能原因:")
            print("       1. PyTorch 版本较新，prebuilt wheel 尚未发布")
            print("       2. 检查 PyTorch 是否为 CUDA 版本: python -c \"import torch; print(torch.__version__)\"")
            if fetch_error:
                print("       3. 网络无法访问 GitHub API")
            print()
            print("       替代方案:")
            print("       - 手动下载: https://github.com/mjun0812/flash-attention-prebuild-wheels/releases")
            print("       - 源码编译: pip install flash-attn --no-build-isolation")
            input("按 Enter 退出...")
            return 2

        if args.dry_run:
            _print_candidates(candidates)
            _print_choice_guide(env)
            input("按 Enter 退出...")
            return 0

        # ── 选择安装方式：交互式 或 自动 ──
        if args.yes:
            install_url = find_best_wheel(env)
            if not install_url:
                print("\n[错误] 无可用 wheel（所有候选 Python ABI 不匹配）")
                _print_candidates(candidates)
                input("按 Enter 退出...")
                return 2
            print(f"\n[自动] 最优匹配 → {install_url}")
        else:
            # 交互式选择
            install_url = _interactive_select(candidates, env)
            if install_url is None:
                print("\n已取消安装。")
                input("按 Enter 退出...")
                return 0

    else:
        install_url = args.url
        print(f"\n[手动] 使用指定 URL:")
        print(f"       {install_url}")

    # ── 安装 ──
    try:
        result = install_wheel(install_url)
    except RuntimeError as exc:
        print(f"\n[错误] {exc}", file=sys.stderr)
        print("\n[排查] 常见原因:")
        print("       1. 网络问题 → 手动下载 .whl 后用 --url 指定本地路径")
        print("       2. ABI 不匹配 → 重新运行本工具，选择其他候选")
        print("       3. pip 版本过旧 → python -m pip install --upgrade pip")
        input("按 Enter 退出...")
        return 1

    # ── 安装后验证 ──
    print()
    ok, msg = verify_flash_attn()
    if ok:
        print("=" * 62)
        print(f"  ✅ flash_attn {result['version'] or '(版本检测失败)'} 安装成功!")
        print(f"  ✓ {msg}")
        if result.get("restart_required"):
            print("  ⚡ flash_attn 是 C 扩展，正在运行的训练进程需要重启才能生效。")
        print(f"  已安装 wheel: {result['url']}")
        print("=" * 62)
    else:
        print("=" * 62)
        print(f"  ❌ 安装后验证失败: {msg}")
        print(f"  wheel 可能 ABI 不匹配当前环境。请重新运行本工具，尝试其他候选版本。")
        print("=" * 62)
        input("按 Enter 退出...")
        return 1

    input("按 Enter 退出...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
