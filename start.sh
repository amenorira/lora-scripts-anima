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

echo "lora-scripts-anima"

# -- Bootstrap: verify Python exists --
PYTHON_BIN=""
if command -v python3 &>/dev/null; then
    PYTHON_BIN="python3"
elif command -v python &>/dev/null; then
    PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "[FAIL] Python is not installed or not in PATH."
    echo "       Install Python 3.12: sudo apt install python3.12 python3.12-venv"
    echo "       Or: https://www.python.org/downloads/"
    exit 1
fi

PYMAJOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
PYMINOR=$($PYTHON_BIN -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
if [ "$PYMAJOR" -lt 3 ] 2>/dev/null || { [ "$PYMAJOR" -eq 3 ] && [ "$PYMINOR" -lt 10 ]; }; then
    echo "[FAIL] Python 3.10+ required (3.12 recommended)."
    exit 1
fi

IS64=$($PYTHON_BIN -c "import sys; print('64' if sys.maxsize > 2**32 else '32')" 2>/dev/null || echo "?")
if [ "$IS64" = "32" ]; then
    echo "[FAIL] 32-bit Python detected. 64-bit required."
    exit 1
fi

# -- Install function --
do_install() {
    echo ""
    echo "[Install] Starting installation..."
    echo ""

    export PIP_DISABLE_PIP_VERSION_CHECK=1
    export PIP_PREFER_BINARY=1

    if [ ! -f "$VENV_PYTHON" ]; then
        echo "Creating venv..."
        $PYTHON_BIN -m venv venv || { echo "[ERROR] Failed to create venv."; exit 1; }
        echo "Upgrading pip..."
        "$VENV_PYTHON" -m pip install --upgrade pip -q 2>/dev/null
    fi

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

# -- Venv check with broken-venv detection --
export HF_HOME=huggingface
export PYTHONUTF8=1
if [ -f "$VENV_PYTHON" ]; then
    echo "Checking torch..."
    if ! "$VENV_PYTHON" -c "import torch" 2>/dev/null; then
        echo "[Notice] venv exists but torch missing -- repairing..."
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

# -- Launch --
echo "Starting..."

"$VENV_PYTHON" gui.py "$@"
