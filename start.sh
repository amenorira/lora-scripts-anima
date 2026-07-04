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

# -- pip mirror HTTPS upgrade (non-invasive, self-contained) --
# 不修改宿主的 pip.conf / 环境变量原值，只在进程内用环境变量接管。原理：pip 配置
# 优先级为 命令行 -i > PIP_* 环境变量 > pip.conf/pip.ini，故 export 的环境变量能
# 压过宿主 pip.conf，且被 PEP 517 构建子进程（vendor/sd-scripts sdist）与 gui.py
# 运行时 pip 继承，一次接管全程。脚本结束即失效，不留痕。
#
# 逻辑：用 pip config get 只读探测当前生效的 index-url / extra-index-url——
#   http://  → export https:// 等价物 + 登记 PIP_TRUSTED_HOST（升级，避免被忽略）
#   https:// → 不动（已安全）
#   无/默认  → 不动（走官方 PyPI）
# 不内置任何镜像，CN/国外自动适配。torch 的 +cu128 轮子仍由命令行
# --extra-index-url 取得，与镜像源互不干扰。
_fix_pip_mirror() {
    local hosts=""
    local py="$VENV_PYTHON"
    [ -f "$py" ] || py="$PYTHON_BIN"
    # 探测 pip 配置中的 index-url 与 extra-index-url（涵盖 pip.conf 与环境变量合并后的生效值）
    for key in global.index-url global.extra-index-url; do
        local val
        val="$("$py" -m pip config get "$key" 2>/dev/null)" || continue
        [ -n "$val" ] || continue
        if [[ "$val" == http://* ]]; then
            local rest="${val#http://}"
            [ -n "$rest" ] || continue
            local var="PIP_INDEX_URL"
            [ "$key" = "global.extra-index-url" ] && var="PIP_EXTRA_INDEX_URL"
            export "$var=https://$rest"
            hosts="$hosts ${rest%%/*}"
        fi
    done
    # 同时处理已有的 PIP_* 环境变量（兜底：源仅来自 env 而非 config 的情况）
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
        echo "[Setup] Upgraded HTTP pip mirror to HTTPS; trusted-host: ${merged# }"
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
# 默认走 hf-mirror.com 镜像加速；国外用户可 export HF_ENDPOINT=https://huggingface.co 回直连
# （仅当用户未自行设置 HF_ENDPOINT 时才赋默认值）
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
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
