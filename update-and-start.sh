#!/usr/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  lora-scripts-anima - 更新 + 启动"
echo "============================================"
echo ""

# ── 更新仓库 ──
if ! command -v git &>/dev/null; then
    echo "[警告] 未找到 Git，跳过仓库更新。"
    echo ""
else
    echo "[更新] git pull --ff-only origin main ..."
    if ! git pull --ff-only origin main; then
        echo "[警告] 更新失败（可能有本地修改冲突），继续启动..."
    else
        echo "[完成] 仓库已更新。"
    fi
    echo ""
fi

# ── Check virtual environment ──
if [ -f "venv/bin/activate" ]; then
    echo "[Launch] Activating virtual environment..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"

    # Deps check
    python tools/check_deps.py 2>/dev/null || {
        echo "[Notice] Dependencies may have changed. Run start.sh to reinstall."
    }

    # flash-attn check
    if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
        echo "[flash_attn] OK (version $FA_VER)"
    else
        echo "[flash_attn] NOT FOUND. RTX 40/50 series: run bash install-flash-attn.sh"
    fi
    echo ""

    python gui.py "$@"
else
    echo "[Notice] Virtual environment (venv) not found."
    echo "        Please run start.sh first for first-time setup."
    exit 1
fi
