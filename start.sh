#!/usr/bin/env bash
# start.sh - One-stop: environment check -> install -> launch
# Run: bash start.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PYTHON="$SCRIPT_DIR/venv/bin/python"

QUIET=0
for arg in "$@"; do
    if [ "$arg" = "--quiet" ] || [ "$arg" = "-q" ]; then
        QUIET=1
    fi
done

echo "============================================"
echo "  lora-scripts-anima"
echo "============================================"
echo ""

echo "[Check] Checking environment..."
OK=1

# --- 1. Python detection ---
PYTHON_BIN=""
if command -v python3 &>/dev/null; then
    PYTHON_BIN="python3"
elif command -v python &>/dev/null; then
    PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "  [FAIL] Python is not installed or not in PATH."
    echo "         Install Python 3.12: sudo apt install python3.12 python3.12-venv"
    echo "         Or: https://www.python.org/downloads/"
    OK=0
else
    PYVER=$($PYTHON_BIN --version 2>&1)
    PYMAJOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
    PYMINOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)

    if [ "$PYMAJOR" -lt 3 ] 2>/dev/null || { [ "$PYMAJOR" -eq 3 ] && [ "$PYMINOR" -lt 10 ]; }; then
        echo "  [FAIL] $PYVER - Python 3.10+ required (3.12 recommended)."
        OK=0
    else
        IS64=$($PYTHON_BIN -c "import sys; print('64' if sys.maxsize > 2**32 else '32')" 2>/dev/null || echo "?")
        if [ "$IS64" = "64" ]; then
            echo "  [OK] $PYVER (64-bit)"
        elif [ "$IS64" = "32" ]; then
            echo "  [FAIL] 32-bit Python detected. 64-bit required."
            OK=0
        else
            echo "  [OK] $PYVER"
        fi
    fi
fi

# --- 2. GPU / CUDA detection ---
if command -v nvidia-smi &>/dev/null; then
    GPUNAME=$(nvidia-smi -L 2>/dev/null | head -1)
    if [ -n "$GPUNAME" ]; then
        echo "  [OK] GPU: $GPUNAME"
    else
        echo "  [WARN] nvidia-smi found but cannot read GPU info."
    fi
    CUDAVER=$(nvidia-smi 2>/dev/null | grep "CUDA Version" | sed 's/.*CUDA Version: \([0-9.]*\).*/\1/')
    if [ -n "$CUDAVER" ]; then
        CUDA_MAJOR=$(echo "$CUDAVER" | cut -d. -f1)
        CUDA_MINOR=$(echo "$CUDAVER" | cut -d. -f2)
        if [ "$CUDA_MAJOR" -ge 12 ] 2>/dev/null; then
            echo "  [OK] CUDA Version: $CUDAVER (driver)"
        else
            echo "  [WARN] CUDA Version: $CUDAVER (driver) — PyTorch cu128 requires >= 12.8"
        fi
    fi
else
    echo "  [WARN] nvidia-smi not found - no NVIDIA GPU or driver?"
    echo "         This project needs NVIDIA GPU (RTX 30/40/50) for training."
fi

# --- 3. Disk space ---
FREEGB=$(df -BG . 2>/dev/null | awk 'NR==2 {print $4}' | sed 's/G//')
if [ -n "$FREEGB" ]; then
    if [ "$FREEGB" -lt 10 ]; then
        echo "  [FAIL] Disk free: ${FREEGB}GB. Recommend 30GB+."
        OK=0
    elif [ "$FREEGB" -lt 30 ]; then
        echo "  [WARN] Disk free: ${FREEGB}GB. Recommend 30GB+."
    else
        echo "  [OK] Disk free: ${FREEGB}GB"
    fi
else
    echo "  [WARN] Could not check disk space."
fi

echo ""
if [ "$OK" = "0" ]; then
    echo "  Environment check FAILED. Please fix the issues above and re-run."
    exit 1
fi
echo "  Environment check passed."
echo ""

# ============================================================
#  Shared install function
# ============================================================
do_install() {
    echo ""
    echo "[Install] Starting installation..."
    echo ""

    export PIP_DISABLE_PIP_VERSION_CHECK=1
    export PIP_PREFER_BINARY=1

    if [ ! -d "venv" ]; then
        echo "Creating venv..."
        $PYTHON_BIN -m venv venv || { echo "[ERROR] Failed to create venv."; exit 1; }
        echo "Upgrading pip..."
        "$VENV_PYTHON" -m pip install --upgrade pip -q 2>/dev/null
    fi

    export HF_HOME=huggingface

    echo "[1/3] Installing PyTorch 2.10.0+cu128..."
    "$VENV_PYTHON" -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
    if [ $? -ne 0 ]; then echo "[ERROR] PyTorch install failed."; exit 1; fi

    echo "[2/3] Installing sd-scripts dependencies..."
    (cd "$SCRIPT_DIR/vendor/sd-scripts" && "$VENV_PYTHON" -m pip install -r requirements.txt) || { echo "[ERROR] sd-scripts dependencies install failed."; exit 1; }

    echo "[3/3] Installing project dependencies..."
    "$VENV_PYTHON" -m pip install --upgrade -r requirements.txt
    if [ $? -ne 0 ]; then echo "[ERROR] Project dependencies install failed."; exit 1; fi

    echo ""
    echo "[Done] Installation complete!"
}

# ============================================================
#  Venv check with broken-venv detection
# ============================================================
if [ -f "$VENV_PYTHON" ]; then
    if ! "$VENV_PYTHON" -c "import torch" 2>/dev/null; then
        echo "[Notice] venv exists but torch missing — repairing..."
        do_install
    fi
else
    echo "[Notice] Virtual environment (venv) not found."
    if [ "$QUIET" = "1" ]; then
        echo "  --quiet mode: auto-installing..."
        do_install
    else
        echo "   1. Install"
        echo "   2. Exit"
        echo ""
        read -r -p "Enter option (1/2): " CHOICE
        if [ "$CHOICE" != "1" ]; then
            echo "Cancelled."
            exit 0
        fi
        do_install
    fi
fi

# ============================================================
#  Launch
# ============================================================
echo "[Launch] Starting..."
export HF_HOME=huggingface
export PYTHONUTF8=1

echo ""

if FA_VER=$("$VENV_PYTHON" -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
    echo "[flash_attn] OK (version $FA_VER)"
else
    echo "[flash_attn] NOT FOUND. Install via GUI: Environment tab -> Flash Attention"
fi
echo ""

"$VENV_PYTHON" gui.py "$@"
