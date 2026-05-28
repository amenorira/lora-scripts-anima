"""Dependency check / 依赖完整性检测

Startup-time check that packages in requirements.txt are installed at correct versions.
启动前自动校验 requirements.txt 中的包是否已安装且版本匹配。

Usage / 用法: python tools/check_deps.py [--fix]

Exit codes / 退出码:
  0 -- All OK / 全部 OK
  1 -- Issues found / 有缺失或版本不匹配的包（--fix 会尝试自动修复）
  2 -- Cannot fix / 无法修复
"""

import re
import sys
import subprocess
from pathlib import Path
from importlib.metadata import version as get_version, PackageNotFoundError


def _parse_requirements(req_path: Path) -> dict[str, tuple[str | None, str | None]]:
    """Parse requirements.txt into {pkg: (min_ver, max_ver)} / 解析版本约束"""
    pkgs: dict[str, tuple[str | None, str | None]] = {}

    for line in req_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        # Strip inline comments
        if "#" in line:
            line = line.split("#")[0].strip()
        if not line or line.startswith("#"):
            continue

        # Handle extras: pkg[extra]>=1.0 -> pkg
        pkg_base = line.split("[")[0].strip()
        pkg_name = re.split(r'[<>=!~]', pkg_base)[0].strip()

        if not pkg_name or pkg_name.startswith("--"):
            continue

        min_ver = None
        max_ver = None
        constraints = re.findall(r'([<>!=~]+)\s*([0-9a-zA-Z.+]+(?:\.post\d+)?)', line)
        for op, ver in constraints:
            if op in (">=", "==", "~="):
                min_ver = ver
        for op, ver in constraints:
            if op == "<":
                max_ver = ver

        key = pkg_name.lower().replace("_", "-")

        if key in pkgs:
            old_min, old_max = pkgs[key]
            if old_min is None or (min_ver is not None and _cmp_ver(min_ver, old_min) > 0):
                old_min = min_ver
            pkgs[key] = (old_min, old_max)
        else:
            pkgs[key] = (min_ver, max_ver)

    return pkgs


def _cmp_ver(a: str, b: str) -> int:
    def _parts(v):
        return tuple(int(x) if x.isdigit() else x for x in re.split(r'[.post]', v) if x)
    pa, pb = _parts(a), _parts(b)
    return -1 if pa < pb else (1 if pa > pb else 0)


def _check(req_path: Path, label: str = "") -> dict[str, str]:
    """Returns {pkg: issue_description} or empty dict / 返回问题字典，空则正常"""
    if not req_path.exists():
        return {f"{label or req_path.name}": "file not found / 文件不存在"}

    required = _parse_requirements(req_path)
    issues: dict[str, str] = {}

    for pkg_name, (min_ver, max_ver) in required.items():
        # 跳过 pip 选项行（如 "-e ."）
        if pkg_name.startswith("-"):
            continue

        installed = None
        for variant in (pkg_name, pkg_name.replace("-", "_"), pkg_name.replace("_", "-")):
            try:
                installed = get_version(variant)
                break
            except PackageNotFoundError:
                continue

        if installed is None:
            issues[pkg_name] = "not installed / 未安装"
            continue

        if min_ver and _cmp_ver(installed, min_ver) < 0:
            issues[pkg_name] = f"installed {installed}, need >= {min_ver} / 已安装 {installed}，需要 >= {min_ver}"
        elif max_ver and _cmp_ver(installed, max_ver) >= 0:
            issues[pkg_name] = f"installed {installed}, need < {max_ver} / 已安装 {installed}，需要 < {max_ver}"

    return issues


def main():
    repo_root = Path(__file__).resolve().parents[1]

    # 训练核心 sd-scripts 依赖优先检查
    sd_req = repo_root / "vendor" / "sd-scripts" / "requirements.txt"
    sd_issues = _check(sd_req, label="sd-scripts")

    # 主项目依赖
    main_req = repo_root / "requirements.txt"
    main_issues = _check(main_req, label="requirements.txt")

    all_issues = {**sd_issues, **main_issues}

    if not all_issues:
        print("[deps] All OK / 依赖完整")
        return 0

    # Issues found
    print(f"[deps] {len(all_issues)} issue(s) found / 发现 {len(all_issues)} 个问题:")
    if sd_issues:
        print("  [sd-scripts]")
        for pkg, desc in sd_issues.items():
            print(f"    - {pkg}: {desc}")
    if main_issues:
        print("  [requirements.txt]")
        for pkg, desc in main_issues.items():
            print(f"    - {pkg}: {desc}")

    if "--fix" in sys.argv:
        print()
        print("[deps] Trying to fix / 尝试修复...")
        try:
            # 训练核心优先修复
            if sd_issues and sd_req.exists():
                print("[deps] Fixing sd-scripts dependencies / 修复 sd-scripts 依赖...")
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "-r", str(sd_req)],
                    stdout=sys.stdout, stderr=sys.stderr
                )
            # 再修复主项目依赖
            if main_issues and main_req.exists():
                print("[deps] Fixing main dependencies / 修复主项目依赖...")
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "-r", str(main_req)],
                    stdout=sys.stdout, stderr=sys.stderr
                )

            # 重新检查
            sd_remaining = _check(sd_req, label="sd-scripts") if sd_req.exists() else {}
            main_remaining = _check(main_req, label="requirements.txt") if main_req.exists() else {}
            remaining = {**sd_remaining, **main_remaining}

            if not remaining:
                print("[deps] Fix succeeded / 修复成功")
                return 0
            else:
                print(f"[deps] {len(remaining)} issue(s) remain / 仍有 {len(remaining)} 个问题未能修复:")
                for pkg, desc in remaining.items():
                    print(f"  - {pkg}: {desc}")
                return 2
        except subprocess.CalledProcessError:
            print("[deps] Fix failed / 修复失败")
            return 2

    return 1


if __name__ == "__main__":
    sys.exit(main())
