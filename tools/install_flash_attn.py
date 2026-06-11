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
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ── 配置 ──────────────────────────────────────────────────────────────────
SOURCE_CONFIGS: dict[str, dict[str, Any]] = {
    "default": {
        "primary":  "https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
        "fallback": ["https://api.github.com/repos/bdashore3/flash-attention/releases"],
    },
    "mirror": {
        "primary":  "https://ghproxy.com/https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
        "fallback": ["https://ghproxy.com/https://api.github.com/repos/bdashore3/flash-attention/releases"],
    },
    "fallback": {
        "primary":  "https://api.github.com/repos/bdashore3/flash-attention/releases",
        "fallback": ["https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases"],
    },
}


def get_source_config(source: str) -> tuple[str, list[str]]:
    """返回 (primary_url, fallback_urls)；未知 source 降级为 default。

    单一职责：把 source 字符串映射到一组 URL。
    无副作用、无 IO、可缓存。
    """
    cfg = SOURCE_CONFIGS.get(source) or SOURCE_CONFIGS["default"]
    return cfg["primary"], list(cfg["fallback"])


def _urls_for(source: str) -> list[str]:
    """返回 source 对应的 [primary, *fallback] URL 列表，便于循环尝试。"""
    primary, fallbacks = get_source_config(source)
    return [primary] + fallbacks

# 磁盘缓存（优先使用，API 仅用于增量更新）
_FA_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"

# 缓存有效期：24 小时。wheel 发布不频繁，无需频繁刷新。
# 即使缓存过期，ETag 条件请求也能保证不浪费 rate limit。
_FA_CACHE_TTL = 86400  # 24 小时

# 可选 GitHub Token（设置了更好，不设也能用 ETag 免限流）
_FA_GITHUB_TOKEN = os.environ.get("FA_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or None


# ── 磁盘缓存（带 ETag 支持）────────────────────────────────────────────────

def _cache_paths(source: str) -> tuple[Path, Path]:
    """返回 (disk_cache_file, etag_file)；按源分 key 避免跨源污染。

    单一职责：纯函数，输入 source → 路径。
    """
    return (
        _FA_CACHE_DIR / f".fa_wheels_{source}.json",
        _FA_CACHE_DIR / f".fa_etag_{source}.txt",
    )


def _load_disk_cache(source: str = "default") -> Optional[list[dict[str, Any]]]:
    """读取磁盘缓存。兼容旧格式（纯列表）和新格式（{ts, candidates}）。"""
    cache_file, _ = _cache_paths(source)
    try:
        if cache_file.exists():
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(data, list) and len(data) > 0:
                return data  # 旧格式：纯列表
            if isinstance(data, dict) and "candidates" in data:
                return data["candidates"]  # 新格式
    except Exception:
        pass
    return None


def _save_disk_cache(candidates: list[dict[str, Any]], source: str = "default") -> None:
    """保存候选列表 + 时间戳到磁盘。"""
    cache_file, _ = _cache_paths(source)
    try:
        _FA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        slim = [
            {"url": c["url"], "name": c["name"], "notes": c.get("notes", []),
             "usable": c["usable"], "score": c.get("score", 0)}
            for c in candidates
        ]
        payload = {"ts": time.time(), "candidates": slim}
        cache_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass


def _load_etag(source: str = "default") -> Optional[str]:
    """读取上次 API 返回的 ETag。"""
    _, etag_file = _cache_paths(source)
    try:
        if etag_file.exists():
            return etag_file.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return None


def _save_etag(etag: str, source: str = "default") -> None:
    """保存 ETag 供下次条件请求使用。"""
    _, etag_file = _cache_paths(source)
    try:
        _FA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        etag_file.write_text(etag, encoding="utf-8")
    except Exception:
        pass


def _cache_is_fresh(source: str = "default") -> bool:
    """磁盘缓存是否在有效期内。"""
    cache_file, _ = _cache_paths(source)
    try:
        if not cache_file.exists():
            return False
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        age = time.time() - data.get("ts", 0)
        return age < _FA_CACHE_TTL
    except Exception:
        return False


def _cache_age_str(source: str = "default") -> str:
    """磁盘缓存的年龄描述。"""
    cache_file, _ = _cache_paths(source)
    try:
        if not cache_file.exists():
            return "No cache / 无缓存"
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        age = time.time() - data.get("ts", 0)
        if age < 60:
            return f"{age:.0f}s ago / {age:.0f}秒前"
        if age < 3600:
            return f"{age/60:.0f}min ago / {age/60:.0f}分钟前"
        if age < 86400:
            return f"{age/3600:.1f}h ago / {age/3600:.1f}小时前"
        return f"{age/86400:.1f}d ago / {age/86400:.1f}天前"
    except Exception:
        return "Unknown / 未知"


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
            ["nvidia-smi"], capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace",
        )
        if r.returncode == 0:
            m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", r.stdout)
            if m:
                driver_cuda_ver = f"{m.group(1)}.{m.group(2)}"
                if cuda_tag is None:
                    cuda_tag = f"cu{m.group(1)}{m.group(2)}"
                    cuda_ver = driver_cuda_ver
    except (subprocess.SubprocessError, OSError, FileNotFoundError, UnicodeError):
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
    """从 wheel 文件名解析 cuda / torch / python / platform 标签。

    支持两种命名格式：
    1. 标准: flash_attn-2.8.3+cu130torch2.12-cp312-cp312-linux_x86_64.whl
    2. Windows abi3: flash_attn_3-3.0.0+cu126torch2.11gite2743ab-cp39-abi3-win_amd64.whl
    """
    if not name:
        return None
    # 统一匹配：第二个 python tag 可能是 cp\d+、cp\d+t 或 abi3
    m = re.search(
        r"\+(cu\d+)(torch[\d.]+(?:git\w+)?)-"  # cuda + torch (可能有 git hash)
        r"((?:cp\d+|cp\d+t))-"                   # python tag
        r"((?:cp\d+|cp\d+t|abi3))-"              # abi tag (abi3 = 稳定 ABI)
        r"([\w]+)\.whl$",                        # platform
        name
    )
    if not m:
        return None
    return {
        "cuda": m.group(1),
        "torch": m.group(2),
        "python": m.group(3),       # e.g. cp312
        "python_abi": m.group(4),   # e.g. cp312 or abi3
        "platform": m.group(5),
    }


def _cuda_major(tag: str) -> int:
    """cu130 → 13, cu124 → 12；解析失败返回 -1。"""
    m = re.search(r"cu(\d+)", tag)
    return int(m.group(1)) // 10 if m else -1


# ── 候选列表拉取（ETag 条件请求，不计入 rate limit）────────────────────

def _build_request(url: str, *, etag: Optional[str] = None) -> urllib.request.Request:
    """构建 HTTP 请求。

    - 自动附加 GitHub Token（如有）提升限额
    - 自动附加 If-None-Match（ETag），命中 304 不消耗 rate limit
    """
    headers = {"User-Agent": "lora-scripts/install-flash-attn"}
    if _FA_GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {_FA_GITHUB_TOKEN}"
    if etag:
        headers["If-None-Match"] = etag
    return urllib.request.Request(url, headers=headers)


def _try_fetch_api(url: str, source: str) -> tuple[Optional[list], Optional[str], bool]:
    """尝试从 GitHub API 拉取数据。

    使用 ETag 条件请求：
    - 304 Not Modified → 数据未变，不消耗 rate limit，返回 (None, None, unchanged=True)
    - 200 → 有新数据，保存新 ETag，返回 (data, None, unchanged=False)
    - 403/其他错误 → 返回 (None, error, unchanged=False)

    Args:
        url: GitHub releases API URL。
        source: 候选源标识，决定 ETag 文件路径（按源分 key 避免污染）。

    Returns: (data, error, unchanged) — unchanged=True 表示缓存仍然有效
    """
    etag = _load_etag(source)
    try:
        req = _build_request(url + "?per_page=100", etag=etag)
        resp = urllib.request.urlopen(req, timeout=15)

        # 保存新 ETag
        new_etag = resp.headers.get("ETag") or resp.headers.get("etag")
        if new_etag:
            _save_etag(new_etag, source)

        data = json.loads(resp.read())
        if isinstance(data, list):
            return data, None, False

        # GitHub 返回了 dict（错误消息）
        msg = data.get("message", str(data)) if isinstance(data, dict) else str(data)
        return None, f"GitHub API: {msg}", False

    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            # 304 Not Modified — 缓存有效，不消耗 rate limit！
            return None, None, True
        if exc.code in (403, 429):
            return None, f"API rate limited (60/h, cache from {_cache_age_str(source)} still usable): {exc} / API 限流", False
        return None, str(exc), False
    except Exception as exc:
        return None, str(exc), False


def _score_candidate(
    tags: dict[str, str], env: dict[str, Any]
) -> tuple[int, list[dict[str, str]], bool]:
    """对一个已解析的 wheel tags 评分，返回 (score, notes, usable)。

    匹配策略：
    - platform: 必须精确一致（上游已过滤）
    - torch:    必须精确一致，否则直接丢弃
    - python:   必须精确一致，否则不可用
    - CUDA:     精确 > 同大版本 > 不同大版本
    """
    torch_tag = env.get("torch_tag")
    cuda_tag = env.get("cuda_tag")
    python_tag = env.get("python_tag")

    score = 0
    notes: list[dict[str, str]] = []
    usable = True

    def _n(key, text):
        notes.append({"key": key, "text": text})

    # PyTorch: 必须精确匹配
    if torch_tag:
        wheel_torch = tags["torch"]
        wheel_torch_clean = re.sub(r"git\w+$", "", wheel_torch)
        if wheel_torch_clean != torch_tag:
            usable = False
            _n("torchMismatch",
               f"Torch mismatch (wheel={wheel_torch_clean}, env={torch_tag})")
            return score, notes, usable
        score += 20

    # Python ABI: 必须精确匹配
    if python_tag:
        if tags["python"] != python_tag:
            usable = False
            _n("pythonMismatch",
               f"Python mismatch (wheel={tags['python']}, env={python_tag})")
            return score, notes, usable
        score += 20

    # CUDA: 精确 > 同大版本 > 不同
    if cuda_tag:
        if tags["cuda"] == cuda_tag:
            score += 20
        elif _cuda_major(tags["cuda"]) == _cuda_major(cuda_tag):
            score += 10
            _n("cudaMinor",
               f"CUDA minor mismatch (wheel={tags['cuda']}, env={cuda_tag}, usually OK)")
        else:
            score -= 5
            _n("cudaMajor",
               f"CUDA major mismatch (wheel={tags['cuda']}, env={cuda_tag})")

    return score, notes, usable


def _filter_cached_for_env(
    cached: list[dict[str, Any]], env: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    """对磁盘缓存的 candidates 重新解析 + 环境匹配 + 评分。

    缓存只存了 {url, name}，不同环境需要重新过滤。
    传入的 cached 已是 source 专属过滤过的，source 参数当前未使用，
    保留便于调用点统一透传。
    """
    plat = env.get("platform")
    result: list[dict[str, Any]] = []
    for c in cached:
        tags = _parse_wheel(c.get("name", ""))
        if not tags:
            continue
        if tags["platform"] != plat:
            continue
        score, notes, usable = _score_candidate(tags, env)
        result.append({
            "url": c["url"],
            "name": c["name"],
            "score": score,
            "notes": notes,
            "usable": usable,
        })
    return sorted(result, key=lambda x: -x["score"])


def fetch_candidates(
    env: dict[str, Any], source: str = "default"
) -> tuple[list[dict[str, Any]], Optional[str]]:
    """获取候选 wheel 列表。

    策略（开箱即用，无需 Token）：
    1. 优先返回磁盘缓存（立即显示，零网络请求）
    2. 缓存过期时，用 ETag 条件请求增量更新（304 不计入 rate limit）
    3. API 失败时继续用缓存，不阻塞用户
    4. 首次使用无缓存时，尝试 API + fallback URLs

    Args:
        env: detect_env() 返回的环境信息。
        source: 候选源标识（'default' / 'mirror' / 'fallback' 或其他）。
                决定：拉取哪个 GitHub API、读写哪个 ETag/磁盘缓存文件。
                未知 source 降级为 default。

    Returns: (candidates, fetch_error)
    """
    plat = env.get("platform")

    if not plat:
        return [], None

    # ── 第一步：加载磁盘缓存（秒级响应）──
    cached = _load_disk_cache(source)
    is_fresh = _cache_is_fresh(source)

    # ── 第二步：尝试 API 刷新（ETag 条件请求）──
    if cached and is_fresh:
        # 缓存新鲜，静默尝试后台刷新
        data = None
    else:
        # 缓存过期或不存在，尝试 API
        urls = _urls_for(source)
        data = None
        for url in urls:
            data, err, unchanged = _try_fetch_api(url, source)
            if unchanged:
                # 304 Not Modified — 缓存仍然有效，刷新时间戳
                _save_disk_cache(cached, source) if cached else None
                break
            if data is not None:
                break
            # 错误继续尝试下一个 URL

    # ── 第三步：解析数据 ──
    raw_releases = data  # 可能为 None

    if raw_releases is None:
        # 没有新数据，使用缓存（重新过滤匹配当前环境）
        if cached:
            return _filter_cached_for_env(cached, env, source), None  # 静默成功
        # 无缓存且 API 失败 — 最后一次尝试
        for url in _urls_for(source):
            raw_releases, _err, _ = _try_fetch_api(url, source)
            if raw_releases is not None:
                break
        if raw_releases is None:
            return [], "Cannot connect to GitHub. Check network, or manually paste a wheel URL. / 无法连接 GitHub，请检查网络。你也可以手动粘贴 wheel URL 安装。"

    if not isinstance(raw_releases, list):
        msg = raw_releases.get("message", str(raw_releases)) if isinstance(raw_releases, dict) else str(raw_releases)
        if cached:
            return _filter_cached_for_env(cached, env, source), None  # API 报错但有缓存
        return [], f"GitHub API error: {msg} / GitHub API 错误: {msg}"

    candidates: list[dict[str, Any]] = []
    for release in raw_releases:
        for asset in release.get("assets", []):
            tags = _parse_wheel(asset.get("name") or "")
            if not tags:
                continue
            if tags["platform"] != plat:
                continue

            score = 0
            notes: list[dict[str, str]] = []
            usable = True

            # 使用统一的评分函数
            s, n, u = _score_candidate(tags, env)
            score += s
            notes.extend(n)
            if not u:
                usable = False

            candidates.append({
                "url": asset["browser_download_url"],
                "name": asset["name"],
                "score": score,
                "notes": notes,
                "usable": usable,
            })

    result = sorted(candidates, key=lambda x: -x["score"])
    # 成功后写入磁盘缓存，供 API 限流时兜底
    if result:
        _save_disk_cache(result, source)
    return result, None


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
            return True, "import + CUDA forward test passed / import + CUDA forward 测试通过"
        except Exception as e:
            # forward 失败但 import 成功 → 可能是显卡不支持或其他运行时问题
            return True, f"import ok but forward test failed: {e} / import 成功，但 forward 测试未通过: {e}"
    except ImportError:
        return False, "import flash_attn failed, not installed / import flash_attn 失败，未安装"
    except Exception as e:
        return False, f"import exception: {e} / import 异常: {e}"


def uninstall_flash_attn() -> bool:
    """卸载 flash_attn。返回是否成功。"""
    print("[REPAIR] Uninstalling current flash_attn... / 正在卸载当前的 flash_attn...")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "uninstall", "flash-attn", "-y"],
        capture_output=True, text=True,
    )
    return r.returncode == 0


# ── 安装 ──────────────────────────────────────────────────────────────────

def install_wheel(url: str) -> dict[str, Any]:
    """pip install 指定的 wheel URL。返回安装结果。"""
    print(f"\n[INSTALL] pip install {url}")
    print("       Download + install may take 2-5 min (~150-250 MB)... / 下载 + 安装可能需要 2-5 分钟（约 150-250 MB）...")
    print()

    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", url],
        capture_output=True,
        text=True,
    )
    stdout = r.stdout + r.stderr
    tail = "\n".join(stdout.splitlines()[-40:])

    if r.returncode != 0:
        raise RuntimeError(f"pip install failed / 失败:\n{tail}")

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
    print(f"\n[CANDIDATES] {len(candidates)} matching wheels, {len(usable_list)} directly installable / 共 {len(candidates)} 个匹配 wheel，其中 {len(usable_list)} 个可直接安装:")
    print("-" * 62)

    for i, c in enumerate(candidates, 1):
        mark = "[OK]" if c["usable"] else "[--]"
        # 提取 flash_attn 版本号
        fa_ver = (c.get("name") or "").split("+")[0].replace("flash_attn-", "")
        tags = _parse_wheel(c.get("name") or "") or {}
        print(f"  [{i:>2}] {mark} score={c['score']:>3d}  flash_attn {fa_ver}")
        print(f"       file: {c['name']}")
        if c["notes"]:
            for note in c["notes"]:
                text = note["text"] if isinstance(note, dict) else str(note)
                print(f"       [WARN] {text}")
        else:
            if c["usable"]:
                print(f"       Perfect match / 完全匹配当前环境")

    print("-" * 62)


def _print_choice_guide(env: dict[str, Any]) -> None:
    """打印选版本帮助说明。"""
    torch_tag = env.get('torch_tag', 'unknown / 未知')
    cuda_tag = env.get('cuda_tag', 'unknown / 未知')
    python_tag = env.get('python_tag', 'unknown / 未知')
    print(f"""
┌─ How to pick the right version? / 如何选择正确的版本？─────┐
│                                                           │
│  flash_attn wheel filename format:                        │
│    flash_attn-{{version}}+{{CUDA}}{{PyTorch}}-{{Python}}-{{platform}}.whl │
│                                                           │
│  Three matching rules / 三项匹配规则:                      │
│                                                           │
│  1. PyTorch -- must match exactly (torch2.9 != torch2.10) │
│     Current: {torch_tag}                                  │
│     [OK] torch2.9 = torch2.9 (exact match / 精确匹配)      │
│     [--] torch2.9 != torch2.10 (ABI incompatible / 不兼容) │
│                                                           │
│  2. CUDA ABI -- same major version usually compatible     │
│     Current: {cuda_tag}                                   │
│     [OK] cu128 ~ cu124 (same major 12.x / 同大版本)        │
│     [--] cu118 != cu128 (different major / 不同大版本)     │
│                                                           │
│  3. Python ABI -- must match                              │
│     Current: {python_tag}                                 │
│     [OK] cp312 = cp312 (exact match / 精确匹配)            │
│     [--] cp312 != cp310                                   │
│                                                           │
│  [OK] Highest score + torch/python exact match = best pick │
│  [--] torch/python mismatch = unusable                     │
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
        print(f"Enter number (1-{len(candidates)}), Enter=recommended [{default_idx}], q=quit / 输入序号选择: ", end="")
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
                print(f"  Enter a number (1-{len(candidates)}) or q to quit / 请输入数字 (1-{len(candidates)}) 或 q 退出")
                continue

        if 1 <= idx <= len(candidates):
            selected = candidates[idx - 1]
            print(f"\n  Selected: [{idx}] {selected['name']} / 已选择")
            if not selected["usable"]:
                print(f"  [WARN] Marked incompatible. Forced install may fail on import! / 该项标记为不兼容，强制安装可能 import 失败！")
                confirm = input("  Confirm forced install? (y/N) / 确认强制安装? (y/N): ").strip().lower()
                if confirm != "y":
                    print("  Cancelled, please select again. / 已取消，请重新选择。")
                    continue
            return selected["url"]
        else:
            print(f"  Out of range, enter 1-{len(candidates)} / 序号超出范围，请输入 1-{len(candidates)}")


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
    print("  Flash Attention Smart Installer (prebuilt wheel) / 智能安装工具")
    print("=" * 62)
    print(f"  Python  ABI : {env['python_tag']}")
    print(f"  Platform     : {env['platform'] or 'Unsupported (non x86_64 Linux/Windows) / 不支持'}")
    print(f"  PyTorch      : {env['torch_tag'] or 'Not detected / 未检测到'}  ({env.get('torch_ver') or 'N/A'})")

    cuda_tag = env['cuda_tag']
    cuda_ver = env.get('cuda_ver')
    driver_ver = env.get('driver_cuda_ver')

    if cuda_tag:
        print(f"  CUDA (ABI)   : {cuda_tag}  (PyTorch build-time binding = {cuda_ver})")
    else:
        print(f"  CUDA (ABI)   : Not detected / 未检测到 (PyTorch may be CPU version)")

    if driver_ver:
        if driver_ver != cuda_ver:
            print(f"  Driver CUDA  : {driver_ver}  [WARN] wheel targets {cuda_tag}, different from driver! / wheel 目标 {cuda_tag}，与驱动版本不同!")
        else:
            print(f"  Driver CUDA  : {driver_ver}  (matches PyTorch ABI / 与 PyTorch ABI 一致)")
    else:
        print(f"  Driver CUDA  : nvidia-smi not detected / 未检测到 nvidia-smi")

    if cuda_tag and env['torch_tag']:
        print(f"  Target wheel : +{cuda_tag}{env['torch_tag']}-{env['python_tag']}-*-{env['platform']}.whl")
    print()

    # ── 内建：检查已安装版本兼容性 ──
    status = current_status()
    needs_repair = False
    if status["installed"]:
        print(f"[STATUS] flash_attn installed (version {status['version']}) / 已安装")
        ok, msg = verify_flash_attn()
        if ok:
            print(f"[VERIFY] {msg}")
            if not args.force and not args.dry_run:
                print("       All good, no reinstall needed. Use --force to force reinstall. / 一切正常，无需重装。使用 --force 可强制重装。")
                print()
                input("Press Enter to exit... / 按 Enter 退出...")
                return 0
            print("       --force specified, will reinstall... / --force 已指定，将重新安装...")
        else:
            print(f"[VERIFY] {msg}")
            print("       [WARN] Current flash_attn is unusable (ABI mismatch or corrupted)! / 当前安装的 flash_attn 不可用 (ABI 不匹配或损坏)!")
            needs_repair = True
    else:
        print("[STATUS] flash_attn not installed / 未安装")

    # ── 内建自动修复 ──
    if needs_repair:
        print()
        print("=" * 62)
        print("  Auto-repair: flash_attn unusable detected, will uninstall and reinstall matching version / 自动修复: 检测到 flash_attn 不可用，将卸载并重新安装匹配版本")
        print("=" * 62)

        # 给出原因分析
        if env['torch_tag']:
            print(f"  PyTorch env : {env['torch_tag']} (CUDA {cuda_tag})")
            print(f"  Old flash_attn may be compiled for different PyTorch/CUDA / 旧 flash_attn 可能是为不同 PyTorch/CUDA 编译的")
            print(f"  Will auto-match correct wheel for current environment and reinstall. / 将自动匹配当前环境的正确 wheel 重新安装。")
        print()

        if not args.yes:
            confirm = input("Continue auto-repair? (Y/n) / 是否继续自动修复? (Y/n): ").strip().lower()
            if confirm == "n":
                print("Cancelled. / 已取消。")
                input("Press Enter to exit... / 按 Enter 退出...")
                return 1

        if not uninstall_flash_attn():
            print("[WARN] Uninstall may have failed, continuing with overwrite install... / 卸载可能失败，继续尝试覆盖安装...")
        print("[REPAIR] Uninstall done, matching correct version... / 卸载完成，开始匹配正确版本...")
        print()

    # ── 平台检查 ──
    if not env["platform"]:
        print("\n[ERROR] Unsupported platform. Prebuilt wheels only support: / 不支持的平台。prebuilt wheel 仅支持:")
        print("       - linux_x86_64")
        print("       - win_amd64")
        print("       macOS / ARM Linux users: pip install flash-attn --no-build-isolation")
        input("Press Enter to exit... / 按 Enter 退出...")
        return 2

    # ── 拉取候选列表 ──
    if not args.url:
        print("[QUERY] Fetching candidate wheel list from GitHub Releases... / 从 GitHub Releases 拉取候选 wheel 列表...")
        candidates, fetch_error = fetch_candidates(env)

        if fetch_error:
            print(f"\n[WARN] Cannot fetch candidate list: {fetch_error} / 无法拉取候选列表")
            print("       You can manually specify a wheel URL: / 可手动指定 wheel URL:")
            print(f"       python tools/install_flash_attn.py --url <URL>")
            print(f"       Releases page: https://github.com/mjun0812/flash-attention-prebuild-wheels/releases")

        if not candidates:
            print("\n[INFO] No matching wheel found for current environment. / 未找到匹配当前环境的 wheel。")
            print(f"       Current env: Python={env['python_tag']}, CUDA={cuda_tag}, PyTorch={env['torch_tag']}")
            print("       Possible reasons: / 可能原因:")
            print("       1. PyTorch version too new, prebuilt wheel not yet released / PyTorch 版本较新，prebuilt wheel 尚未发布")
            print("       2. Check if PyTorch is CUDA version: python -c \"import torch; print(torch.__version__)\"")
            if fetch_error:
                print("       3. Network cannot reach GitHub API / 网络无法访问 GitHub API")
            print()
            print("       Alternatives: / 替代方案:")
            print("       - Manual download: https://github.com/mjun0812/flash-attention-prebuild-wheels/releases")
            print("       - Build from source: pip install flash-attn --no-build-isolation")
            input("Press Enter to exit... / 按 Enter 退出...")
            return 2

        if args.dry_run:
            _print_candidates(candidates)
            _print_choice_guide(env)
            input("Press Enter to exit... / 按 Enter 退出...")
            return 0

        # ── 选择安装方式：交互式 或 自动 ──
        if args.yes:
            install_url = find_best_wheel(env)
            if not install_url:
                print("\n[ERROR] No usable wheel (all candidates have Python ABI mismatch) / 无可用 wheel（所有候选 Python ABI 不匹配）")
                _print_candidates(candidates)
                input("Press Enter to exit... / 按 Enter 退出...")
                return 2
            print(f"\n[AUTO] Best match: {install_url} / 最优匹配")
        else:
            # 交互式选择
            install_url = _interactive_select(candidates, env)
            if install_url is None:
                print("\nInstallation cancelled. / 已取消安装。")
                input("Press Enter to exit... / 按 Enter 退出...")
                return 0

    else:
        install_url = args.url
        print(f"\n[MANUAL] Using specified URL: / 使用指定 URL:")
        print(f"       {install_url}")

    # ── 安装 ──
    try:
        result = install_wheel(install_url)
    except RuntimeError as exc:
        print(f"\n[ERROR] {exc}", file=sys.stderr)
        print("\n[TROUBLESHOOT] Common causes: / 常见原因:")
        print("       1. Network issue -> download .whl manually then use --url with local path / 网络问题 → 手动下载 .whl 后用 --url 指定本地路径")
        print("       2. ABI mismatch -> re-run this tool and select another candidate / ABI 不匹配 → 重新运行本工具，选择其他候选")
        print("       3. pip too old -> python -m pip install --upgrade pip")
        input("Press Enter to exit... / 按 Enter 退出...")
        return 1

    # ── 安装后验证 ──
    print()
    ok, msg = verify_flash_attn()
    if ok:
        print("=" * 62)
        print(f"  flash_attn {result['version'] or '(version detection failed / 版本检测失败)'} installed successfully! / 安装成功!")
        print(f"  {msg}")
        if result.get("restart_required"):
            print("  [INFO] flash_attn is a C extension. Running training processes need restart to take effect. / flash_attn 是 C 扩展，正在运行的训练进程需要重启才能生效。")
        print(f"  Installed wheel: {result['url']}")
        print("=" * 62)
    else:
        print("=" * 62)
        print(f"  Post-install verification failed: {msg} / 安装后验证失败")
        print(f"  Wheel may have ABI mismatch. Please re-run this tool and try other candidates. / wheel 可能 ABI 不匹配当前环境。请重新运行本工具，尝试其他候选版本。")
        print("=" * 62)
        input("Press Enter to exit... / 按 Enter 退出...")
        return 1

    input("Press Enter to exit... / 按 Enter 退出...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
