#!/usr/bin/bash
# update-and-start.sh - Git pull + launch
# Run: bash update-and-start.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  lora-scripts-anima - Update + Launch"
echo "============================================"
echo ""

if ! command -v git &>/dev/null; then
    echo "[WARN] Git not found, skipping repo update."
else
    echo "[Update] git pull --ff-only origin main ..."
    if git pull --ff-only origin main; then
        echo "[Done] Repo updated."
    else
        echo "[WARN] Update failed (local changes conflict?), continuing..."
    fi
    echo ""
fi

if [ ! -f "venv/bin/activate" ]; then
    echo "[Notice] Virtual environment (venv) not found."
    echo "        Please run: bash start.sh"
    exit 1
fi

echo "[Launch] Activating virtual environment..."
export HF_HOME=huggingface
export PYTHONUTF8=1
source "venv/bin/activate"

python tools/check_deps.py 2>/dev/null || echo "[Notice] Dependencies may have changed. Run: bash start.sh"
echo ""

if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
    echo "[flash_attn] OK (version $FA_VER)"
else
    echo "[flash_attn] NOT FOUND. RTX 40/50 series: bash install-flash-attn.sh"
fi
echo ""

python gui.py "$@"
