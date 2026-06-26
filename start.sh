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

# -- pip mirror HTTPS upgrade --
# 镜像源经 HTTPS 通常比 HTTP 快且可靠（HTTP 可能被限速/劫持），且 pip 23+ 会把
# HTTP 索引当不安全主机静默忽略，导致 "from versions: none"。HTTP 镜像可能由
# pip.conf（如 AutoDL 的 /etc/pip.conf）或 PIP_* 环境变量注入。本函数两路处理：
#  (1) 改写 pip.conf：把 index-url / extra-index-url 的 http:// 改成 https://，
#      覆盖所有已知位置（/etc、~/.pip、~/.config/pip、venv 内）。一次改完，主进程、
#      PEP 517 构建子进程（vendor/sd-scripts sdist）、gui.py 运行时 pip 全部受益。
#  (2) 升级环境变量：把 PIP_INDEX_URL / PIP_EXTRA_INDEX_URL 的 http:// 改成 https://
#      并登记 PIP_TRUSTED_HOST（去重），兜底源来自环境变量的情况。
# HTTPS/默认源不受影响。AutoDL 为 root + 临时容器，改 /etc/pip.conf 无副作用。
_fix_pip_mirror() {
    local changed=0
    # (1) 改写 pip.conf 中的 http:// -> https://
    local confs="/etc/pip.conf $HOME/.pip/pip.conf $HOME/.config/pip/pip.conf $SCRIPT_DIR/venv/pip.conf"
    for conf in $confs; do
        [ -f "$conf" ] || continue
        [ -w "$conf" ] || continue
        if grep -qiE '^(index-url|extra-index-url)[[:space:]]*=[[:space:]]*http://' "$conf"; then
            # 只替换配置值中的 http://，不动注释行
            sed -i -E 's/^((index-url|extra-index-url)[[:space:]]*=[[:space:]]*)http:\/\//\1https:\/\//I' "$conf"
            changed=1
            echo "[Setup] Upgraded HTTP mirror to HTTPS in $conf"
        fi
    done
    # (2) 升级环境变量（兜底）
    local hosts=""
    for var in PIP_INDEX_URL PIP_EXTRA_INDEX_URL; do
        local val="${!var}"
        if [ -n "$val" ] && [[ "$val" == http://* ]]; then
            local rest="${val#http://}"
            [ -n "$rest" ] || continue
            export "$var=https://$rest"
            hosts="$hosts ${rest%%/*}"
        fi
    done
    if [ -n "$hosts" ]; then
        local merged="$PIP_TRUSTED_HOST"
        for h in $hosts; do
            case " $merged " in *" $h "*) ;; *) merged="$merged $h";; esac
        done
        export PIP_TRUSTED_HOST="${merged# }"
        changed=1
        echo "[Setup] Upgraded HTTP pip mirror env var to HTTPS; trusted-host: ${merged# }"
    fi
}

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
    # 预锁定 setuptools 版本，避免 PyTorch 拉入 82+ 后被 [3/3] 降级
    "$VENV_PYTHON" -m pip install "setuptools>=68,<82" -q || { echo "[ERROR] setuptools pre-lock failed."; exit 1; }
    "$VENV_PYTHON" -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
    if [ $? -ne 0 ]; then echo "[ERROR] PyTorch install failed."; exit 1; fi

    echo "[2/3] Installing sd-scripts dependencies..."
    (cd "$SCRIPT_DIR/vendor/sd-scripts" && "$VENV_PYTHON" -m pip install -r requirements.txt) || { echo "[ERROR] sd-scripts dependencies install failed."; exit 1; }

    echo "[3/3] Installing project dependencies..."
    "$VENV_PYTHON" -m pip install -r requirements.txt
    if [ $? -ne 0 ]; then echo "[ERROR] Project dependencies install failed."; exit 1; fi

    echo ""
    echo "[Done] Installation complete!"
}

# -- Venv check --
export HF_HOME=huggingface
export PYTHONUTF8=1
_fix_pip_mirror
if [ ! -f "$VENV_PYTHON" ]; then
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
"$VENV_PYTHON" gui.py "$@"
