"""
训练产物 — 预览样本扫描 + 历史记录 + 日志文件读取
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "output"
CONFIG_AUTOSAVE = REPO_ROOT / "config" / "autosave"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


# ── 预览样本 ──────────────────────────────────────────────

def newest_previews(output_dir: str | None = None, limit: int = 6) -> list[dict]:
    """扫描最新的训练样本图"""
    roots = []
    if output_dir:
        roots.extend([Path(output_dir) / "sample", Path(output_dir)])
    roots.extend([OUTPUT_DIR / "sample", OUTPUT_DIR])

    found: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*"),
                        key=lambda x: x.stat().st_mtime if x.is_file() else 0,
                        reverse=True):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
                if p not in found:
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
        result.append({
            "name": p.name,
            "url": f"/preview-image?path={rel}",
            "size": p.stat().st_size,
        })
    return result


# ── 历史记录 ──────────────────────────────────────────────

def scan_history() -> list[dict]:
    """扫描历史训练记录"""
    history = []
    if not CONFIG_AUTOSAVE.exists():
        return history

    for cfg_path in sorted(CONFIG_AUTOSAVE.glob("*.toml"),
                           key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
        try:
            st = cfg_path.stat()
            params = {}
            text = cfg_path.read_text(encoding="utf-8", errors="replace")
            for key in ["output_name", "pretrained_model_name_or_path",
                         "learning_rate", "network_dim", "network_alpha",
                         "max_train_epochs", "model_train_type"]:
                m = re.search(
                    rf'^{key}\s*=\s*["\']?(?P<v>[^"\'\n#]+)["\']?\s*$',
                    text, re.MULTILINE
                )
                if m:
                    params[key] = m.group("v").strip().strip('"').strip("'")

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "config_file": cfg_path.name,
                "name": params.get("output_name", cfg_path.stem),
                "model": Path(params.get("pretrained_model_name_or_path", "")).name or "Unknown",
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
            })
        except (OSError, Exception):
            continue

    return history


# ── 训练日志读取 ──────────────────────────────────────────

def read_train_log(task_id: str, output_dir: Path | None = None) -> list[str]:
    """读取训练任务的实时日志"""
    od = output_dir or OUTPUT_DIR
    task_id_short = task_id[:8]
    for log_file in sorted(od.glob(f"train_{task_id_short}*.log"),
                           key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            text = log_file.read_text(encoding="utf-8", errors="replace")
            return text.split("\n")
        except OSError:
            continue
    return []
