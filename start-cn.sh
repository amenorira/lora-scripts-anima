#!/usr/bin/bash
# start-cn.sh - One-stop entry with China mirrors
# Run: bash start-cn.sh
# pip: Tsinghua Mirror  |  PyTorch: Aliyun Mirror

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  lora-scripts-anima - CN Mirror"
echo "  pip: Tsinghua  |  PyTorch: Aliyun"
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
    echo "         Or: https://registry.npmmirror.com/-/binary/python/3.12.9/"
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

# --- 2. GPU detection ---
if command -v nvidia-smi &>/dev/null; then
    GPUNAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    if [ -n "$GPUNAME" ]; then
        echo "  [OK] GPU: $GPUNAME"
    else
        echo "  [WARN] nvidia-smi found but cannot read GPU info."
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

# --- Venv check ---
if [ -f "venv/bin/activate" ]; then
    echo "[Launch] Activating virtual environment..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"

    python tools/check_deps.py 2>/dev/null || echo "[Notice] Dependencies may be incomplete. Re-run start-cn.sh to install."
    echo ""

    if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
        echo "[flash_attn] OK (version $FA_VER)"
    else
        echo "[flash_attn] NOT FOUND. RTX 40/50 series: bash install-flash-attn.sh"
    fi
    echo ""

    python gui.py "$@"
    exit 0
fi

# --- Venv not found, offer install ---
echo "[Notice] Virtual environment (venv) not found."
echo "   1. Install"
echo "   2. Exit"
echo ""
read -r -p "Enter option (1/2): " CHOICE

if [ "$CHOICE" != "1" ]; then
    echo "Cancelled."
    exit 0
fi

# --- Install with CN mirrors ---
echo ""
echo "[Install] Starting installation (CN mirrors)..."
echo "  pip: https://pypi.tuna.tsinghua.edu.cn/simple"
echo "  torch: https://mirrors.aliyun.com/pytorch-wheels/cu128"
echo ""

export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"

if [ ! -d "venv" ]; then
    echo "Creating venv..."
    $PYTHON_BIN -m venv venv || { echo "[ERROR] Failed to create venv."; exit 1; }
fi

source "venv/bin/activate"
export HF_HOME=huggingface

echo "[1/3] Installing PyTorch 2.10.0 + CUDA 12.8..."
CUDA_VER=$(nvidia-smi 2>/dev/null | grep -oiP 'CUDA Version: \K[\d\.]+' || echo "")
if [ -z "$CUDA_VER" ]; then
    CUDA_VER=$(nvcc --version 2>/dev/null | grep -oiP 'release \K[\d\.]+' || echo "")
fi
CUDA_MAJOR=$(echo "$CUDA_VER" | awk -F'.' '{print $1}')

if [ -n "$CUDA_MAJOR" ] && [ "$CUDA_MAJOR" -ge 12 ]; then
    echo "  Detected CUDA $CUDA_VER, installing PyTorch 2.10.0+cu128..."
    pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --index-url https://mirrors.aliyun.com/pytorch-wheels/cu128
elif [ -n "$CUDA_MAJOR" ] && [ "$CUDA_MAJOR" -eq 11 ]; then
    echo "  Detected CUDA $CUDA_VER, installing PyTorch 2.4.0+cu118..."
    pip install torch==2.4.0+cu118 torchvision==0.19.0+cu118 --index-url https://mirrors.aliyun.com/pytorch-wheels/cu118
    pip install --no-deps xformers==0.0.27.post2+cu118 --index-url https://mirrors.aliyun.com/pytorch-wheels/cu118
else
    echo "  No CUDA detected or unsupported version. Installing PyTorch 2.10.0+cu128..."
    pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --index-url https://mirrors.aliyun.com/pytorch-wheels/cu128
fi
if [ $? -ne 0 ]; then echo "[ERROR] PyTorch install failed."; exit 1; fi

echo "[2/3] Installing sd-scripts dependencies..."
pip install -r vendor/sd-scripts/requirements.txt
if [ $? -ne 0 ]; then echo "[ERROR] sd-scripts dependencies install failed."; exit 1; fi

echo "[3/3] Installing project dependencies..."
pip install --upgrade -r requirements.txt
if [ $? -ne 0 ]; then echo "[ERROR] Project dependencies install failed."; exit 1; fi

echo ""
echo "[Done] Installation complete!"
echo ""

# --- Launch ---
echo "[Launch] Starting GUI..."
export PYTHONUTF8=1
python gui.py "$@"
