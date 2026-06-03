"""
训练产物 — 预览样本扫描 + 历史记录 + 日志文件读取
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "output"
CONFIG_AUTOSAVE = REPO_ROOT / "config" / "autosave"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# ── scan_history 缓存 ────────────────────────────────────
_history_cache: tuple[float, list[dict]] | None = None
_HISTORY_CACHE_TTL = 30  # 秒


# ── 预览样本 ──────────────────────────────────────────────

def newest_previews(output_dir: str | None = None, limit: int = 6) -> list[dict]:
    """扫描最新的训练样本图（checkpoints/sample/ → sample/ → output_dir 根）"""
    roots: list[Path] = []
    if output_dir:
        od = Path(output_dir)
        roots.extend([od / "sample", od])           # checkpoints/sample/, checkpoints/
        roots.append(od.parent / "sample")           # run_dir/sample/ (兼容旧结构)
    roots.extend([OUTPUT_DIR / "sample", OUTPUT_DIR])

    found: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*"),
                        key=lambda x: x.stat().st_mtime if x.is_file() else 0,
                        reverse=True):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and p not in seen:
                seen.add(p)
                found.append(p)
                if len(found) >= limit * 2:
                    break
        if len(found) >= limit:
            break

    found.sort(key=lambda p: p.stat().st_mtime)
    selected = found[-limit:] if len(found) > limit else found

    result = []
    for p in selected:
        try:
            rel = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
        except ValueError:
            rel = str(p)
        # Security: validate resolved path stays within REPO_ROOT
        resolved = p.resolve()
        if not str(resolved).startswith(str(REPO_ROOT.resolve())):
            continue
        result.append({
            "name": p.name,
            "url": f"/preview-image?path={rel}",
            "size": p.stat().st_size,
        })
    return result


# ── 历史记录 ──────────────────────────────────────────────

def _parse_toml_config(path: Path) -> dict | None:
    """从 TOML 配置文件中提取关键参数"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        params = {}
        for key in ["output_name", "pretrained_model_name_or_path",
                     "learning_rate", "network_dim", "network_alpha",
                     "max_train_epochs", "model_train_type", "output_dir",
                     "train_data_dir"]:
            m = re.search(
                rf'^{key}\s*=\s*["\']?(?P<v>[^"\'\n#]+)["\']?\s*$',
                text, re.MULTILINE
            )
            if m:
                params[key] = m.group("v").strip().strip('"').strip("'")
        return params
    except (OSError, Exception):
        return None


def scan_history() -> list[dict]:
    """扫描训练记录：优先从 output/*/config.toml（运行文件夹），回退到 config/autosave/"""
    global _history_cache
    now = time.time()
    if _history_cache and now - _history_cache[0] < _HISTORY_CACHE_TTL:
        return _history_cache[1]

    history = []
    seen_names = set()  # 按 output_name+timestamp 去重

    # ── 优先：扫描运行文件夹（每个训练一个目录） ──
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if not run_dir.is_dir():
                continue
            config_file = run_dir / "config.toml"
            if not config_file.exists():
                continue

            params = _parse_toml_config(config_file)
            if not params:
                continue

            st = config_file.stat()
            key = (params.get("output_name", ""), run_dir.name)
            if key in seen_names:
                continue
            seen_names.add(key)

            # 模型文件名（取 basename）
            model_path = params.get("pretrained_model_name_or_path", "")
            model_name = Path(model_path).name if model_path else "Unknown"

            # 读取 result.json 获取训练状态
            status = ""
            duration = ""
            result_file = run_dir / "result.json"
            if result_file.exists():
                try:
                    rj = json.loads(result_file.read_text(encoding="utf-8"))
                    status = rj.get("status", "")
                    duration = rj.get("duration_str", "")
                except Exception:
                    pass

            try:
                rel_run_dir = str(run_dir.relative_to(REPO_ROOT)).replace("\\", "/")
            except ValueError:
                rel_run_dir = str(run_dir).replace("\\", "/")

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "run_dir": rel_run_dir,
                "config_file": config_file.name,
                "name": params.get("output_name", run_dir.name),
                "model": model_name,
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
                "dataset": params.get("train_data_dir", ""),
                "status": status,
                "duration": duration,
            })

    # ── 回退/补充：扫描 autosave（可能有些旧记录只有 toml 没目录） ──
    if CONFIG_AUTOSAVE.exists():
        for cfg_path in sorted(CONFIG_AUTOSAVE.glob("*.toml"),
                               key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
            # 跳过 prompt 文件
            if cfg_path.name.endswith("-promopt.txt"):
                continue

            params = _parse_toml_config(cfg_path)
            if not params:
                continue

            key = (params.get("output_name", ""), cfg_path.stem)
            if key in seen_names:
                continue
            seen_names.add(key)

            st = cfg_path.stat()
            model_path = params.get("pretrained_model_name_or_path", "")
            model_name = Path(model_path).name if model_path else "Unknown"
            run_dir = params.get("output_dir", "")

            try:
                rel_run_dir = str(Path(run_dir).relative_to(REPO_ROOT)).replace("\\", "/") if run_dir else ""
            except ValueError:
                rel_run_dir = str(run_dir).replace("\\", "/") if run_dir else ""

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "run_dir": rel_run_dir,
                "config_file": cfg_path.name,
                "name": params.get("output_name", cfg_path.stem),
                "model": model_name,
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
                "dataset": params.get("train_data_dir", ""),
                "status": "",
                "duration": "",
            })

    _history_cache = (time.time(), history)
    return history


# ── 训练日志读取 ──────────────────────────────────────────

# 日志 tail 读取的最大字节数（约 500-1000 行）
_LOG_TAIL_BYTES = 64 * 1024


def _tail_file(path: Path, max_bytes: int = _LOG_TAIL_BYTES) -> list[str]:
    """高效读取文件尾部内容（不加载整个文件到内存）"""
    try:
        size = path.stat().st_size
        if size == 0:
            return []
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if size <= max_bytes:
                f.seek(0)
                return f.read().split("\n")
            f.seek(size - max_bytes)
            # 丢弃第一行（可能是不完整的行）
            content = f.read()
            first_newline = content.find("\n")
            if first_newline >= 0:
                content = content[first_newline + 1:]
            return content.split("\n")
    except OSError:
        return []


def read_train_log(task_id: str, output_dir: Path | None = None) -> list[str]:
    """读取训练任务的实时日志（tail 方式，高性能）。
    优先从指定 output_dir 读取，否则扫描 output/ 子目录"""
    task_id_short = task_id[:8]

    # 先在指定目录查找
    if output_dir and output_dir.exists():
        for log_file in sorted(output_dir.glob(f"train_{task_id_short}*.log"),
                               key=lambda p: p.stat().st_mtime, reverse=True):
            lines = _tail_file(log_file)
            if lines:
                return lines

    # 回退：扫描所有运行子目录
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.iterdir(),
                              key=lambda p: p.stat().st_mtime if p.is_dir() else 0,
                              reverse=True):
            if not run_dir.is_dir():
                continue
            for log_file in sorted(run_dir.glob(f"train_{task_id_short}*.log"),
                                   key=lambda p: p.stat().st_mtime, reverse=True):
                lines = _tail_file(log_file)
                if lines:
                    return lines

    return []
