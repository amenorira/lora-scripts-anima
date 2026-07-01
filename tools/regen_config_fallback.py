#!/usr/bin/env python
"""从 field_registry（SSOT）重新生成 frontend/js/config.js 的 FALLBACK_COMMON 块。

config.js 第 ~15 行有一份硬编码 FALLBACK_COMMON，作为 /api/fields 不可达时的离线副本
（前端静态资源与 /api/fields 同进程 serve，所以严格意义上几乎不会用到，但仍承担
"首屏 Alpine 初始化、fetch 尚未完成时立即可用"的职责）。

历史上它是手写的 → 容易与 registry 漂移（network_dropout 旧 show_if、conv_dim/rank_dropout
旧 show_if、noise_offset 族缺 group 等都是这种漂移的产物）。本脚本以 registry 为唯一来源，
用与 /api/fields 完全相同的 get_fields_json() 序列化输出，重写那一行，消除漂移源。

用法:
    python tools/regen_config_fallback.py            # 默认重写 frontend/js/config.js
    python tools/regen_config_fallback.py --check    # 仅比对，不写入（CI/diff 检查）
    python tools/regen_config_fallback.py --path frontend/js/config.js
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 让 tools/ 作为脚本直接运行时也能 import 到 backend 包
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DEFAULT_CONFIG_PATH = Path("frontend/js/config.js")

# 匹配 config.js 中那行单行声明：const FALLBACK_COMMON = [...];
# 用非贪婪到行尾的 `;`，假定它独占一行（当前就是这个写法）。
_FALLBACK_LINE_RE = re.compile(
    r"^const\s+FALLBACK_COMMON\s*=\s*\[.*\];\s*$",
    re.MULTILINE,
)


def _build_fallback_line(sections: list[dict]) -> str:
    """与 config.js 现有写法一致：紧凑 JSON、单行、以 const ... = [...]; 包裹。"""
    # separators=(",", ":") 去掉所有冗余空白，与现有 fallback 风格一致且 diff 最小。
    payload = json.dumps(sections, separators=(",", ":"), ensure_ascii=False)
    return f"const FALLBACK_COMMON = {payload};"


def regen(config_path: Path, check_only: bool = False) -> int:
    from backend.training.field_registry import get_fields_json

    sections = get_fields_json().get("sections", [])
    if not sections:
        print("ERROR: registry returned no sections", file=sys.stderr)
        return 2

    target_line = _build_fallback_line(sections)

    if not config_path.exists():
        print(f"ERROR: config file not found: {config_path}", file=sys.stderr)
        return 2

    text = config_path.read_text(encoding="utf-8")

    if not _FALLBACK_LINE_RE.search(text):
        print(
            "ERROR: could not locate single-line `const FALLBACK_COMMON = [...];` declaration.\n"
            "       请确认 config.js 该行未被拆成多行或被改写。",
            file=sys.stderr,
        )
        return 3

    new_text = _FALLBACK_LINE_RE.sub(target_line, text, count=1)

    if new_text == text:
        print(f"OK: {config_path} already in sync with registry ({len(sections)} sections).")
        return 0

    if check_only:
        print(f"DRIFT: {config_path} FALLBACK_COMMON differs from registry.")
        print("       Run without --check to regenerate.")
        return 1

    config_path.write_text(new_text, encoding="utf-8")
    print(f"OK: regenerated FALLBACK_COMMON in {config_path} ({len(sections)} sections, "
          f"{len(target_line)} chars).")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    ap.add_argument("--path", type=Path, default=DEFAULT_CONFIG_PATH,
                    help=f"path to config.js (default: {DEFAULT_CONFIG_PATH})")
    ap.add_argument("--check", action="store_true",
                    help="只比对不写入；若漂移返回 1（适合 CI/预提交检查）")
    args = ap.parse_args()
    return regen(args.path, check_only=args.check)


if __name__ == "__main__":
    raise SystemExit(main())