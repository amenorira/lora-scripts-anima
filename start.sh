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

# -- Bootstrap: select a compatible 64-bit Python (3.10-3.12) --
# Prefer an existing compatible venv, then a versioned interpreter. Python
# 3.13/3.14 cannot install some pinned wheels used by this project.
_is_supported_python() {
    "$1" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) and sys.maxsize > 2**32 else 1)' >/dev/null 2>&1
}

PYTHON_BIN=""

if [ -f "$VENV_PYTHON" ]; then
    if ! _is_supported_python "$VENV_PYTHON"; then
        echo "[FAIL] Existing venv uses an unsupported Python version or architecture. / 现有 venv 使用了不受支持的 Python 版本或架构。"
        "$VENV_PYTHON" --version 2>/dev/null || true
        echo "       Supported: 64-bit Python 3.10-3.12 (3.12 recommended). / 支持 64 位 Python 3.10-3.12（推荐 3.12）。"
        echo "       Rename or remove only this project's 'venv' folder, then rerun start.sh. / 请只重命名或删除本项目的 venv 文件夹后重新运行 start.sh。"
        exit 1
    fi
    PYTHON_BIN="$VENV_PYTHON"
else
    for candidate in python3.12 python3.11 python3.10 python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        candidate_path="$(command -v "$candidate")"
        if _is_supported_python "$candidate_path"; then
            PYTHON_BIN="$candidate_path"
            break
        fi
    done
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "[FAIL] No compatible 64-bit Python installation was found. / 未找到兼容的 64 位 Python。"
    echo "       Required: Python 3.10-3.12 (Python 3.12 recommended). / 需要 Python 3.10-3.12（推荐 3.12）。"
    echo "       Python 3.13/3.14 may remain installed side by side. / Python 3.13/3.14 可以并行保留。"
    echo "       Install Python 3.12 and venv support, for example: / 请安装 Python 3.12 和 venv 支持，例如："
    echo "       sudo apt install python3.12 python3.12-venv"
    exit 1
fi

# -- pip mirror HTTPS upgrade (non-invasive, self-contained) --
# 不修改宿主的 pip.conf / 环境变量原值，只在进程内用环境变量接管。原理：pip 配置
# 优先级为 命令行 -i > PIP_* 环境变量 > pip.conf/pip.ini，故 export 的环境变量能
# 压过宿主 pip.conf，且被 PEP 517 构建子进程（vendor/sd-scripts sdist）与 backend.gui
# 运行时 pip 继承，一次接管全程。脚本结束即失效，不留痕。
#
# 逻辑：用 pip config get 只读探测当前生效的 index-url / extra-index-url——
#   http://  → export https:// 等价物 + 登记 PIP_TRUSTED_HOST（升级，避免被忽略）
#   https:// → 不动（已安全）
#   无/默认  → 不动（走官方 PyPI）
# 不内置任何镜像，CN/国外自动适配。torch 的 +cu130 轮子仍由命令行
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
        echo "[Setup] Upgraded HTTP pip mirror to HTTPS; trusted-host: ${merged# } / 已将 HTTP pip 镜像临时升级为 HTTPS。"
    fi
}

# -- Install function --
ensure_musubi_shared_runtime() {
    if [ ! -f "$VENV_PYTHON" ]; then
        echo "[ERROR] Main venv is required before Krea 2 runtime synchronization. / 同步 Krea 2 运行时前需要主 venv。"
        exit 1
    fi

    # vendor/sd-scripts is installed before this project-owned requirement
    # file. The hot path only reads metadata, so normal GUI launches do not
    # download/rewrite packages or import Qwen3-VL.
    if "$VENV_PYTHON" -X utf8 -m tools.ensure_musubi_runtime --check --quiet; then
        return
    fi

    echo "[4/4] Synchronizing shared musubi-tuner Krea 2 dependencies... / 正在同步主环境的 musubi-tuner Krea 2 依赖……"
    "$VENV_PYTHON" -m pip install --upgrade-strategy only-if-needed -r "$SCRIPT_DIR/requirements-musubi-krea2.txt" || { echo "[ERROR] musubi-tuner dependencies install failed. / musubi-tuner 依赖安装失败。"; exit 1; }
    "$VENV_PYTHON" -X utf8 -m tools.ensure_musubi_runtime --check --verify-imports || { echo "[ERROR] Shared musubi runtime verification failed. / musubi 共享运行时校验失败。"; exit 1; }
}

do_install() {
    echo ""
    echo "[Install] Starting installation... / 开始安装……"
    echo ""

    export PIP_DISABLE_PIP_VERSION_CHECK=1
    export PIP_PREFER_BINARY=1

    if [ ! -f "$VENV_PYTHON" ]; then
        echo "Creating venv... / 正在创建 venv……"
        $PYTHON_BIN -m venv venv || { echo "[ERROR] Failed to create venv. / 创建 venv 失败。"; exit 1; }
        echo "Upgrading pip... / 正在升级 pip……"
        "$VENV_PYTHON" -m pip install --upgrade pip -q 2>/dev/null
    fi

    echo "[1/4] Installing PyTorch 2.10.0+cu130... / 正在安装 PyTorch 2.10.0+cu130……"
    # 预锁定 setuptools 版本，避免 PyTorch 拉入 82+ 后被 [3/4] 降级
    "$VENV_PYTHON" -m pip install "setuptools>=68,<82" -q || { echo "[ERROR] setuptools pre-lock failed. / setuptools 版本预锁定失败。"; exit 1; }
    "$VENV_PYTHON" -m pip install torch==2.10.0+cu130 torchvision==0.25.0+cu130 --extra-index-url https://download.pytorch.org/whl/cu130
    if [ $? -ne 0 ]; then echo "[ERROR] PyTorch install failed. / PyTorch 安装失败。"; exit 1; fi

    echo "[2/4] Installing sd-scripts dependencies... / 正在安装 sd-scripts 依赖……"
    (cd "$SCRIPT_DIR/vendor/sd-scripts" && "$VENV_PYTHON" -m pip install -r requirements.txt) || { echo "[ERROR] sd-scripts dependencies install failed. / sd-scripts 依赖安装失败。"; exit 1; }

    echo "[3/4] Installing project dependencies... / 正在安装项目依赖……"
    "$VENV_PYTHON" -m pip install -r requirements.txt
    if [ $? -ne 0 ]; then echo "[ERROR] Project dependencies install failed. / 项目依赖安装失败。"; exit 1; fi

    ensure_musubi_shared_runtime

    echo ""
    echo "[Done] Installation complete! / 安装完成！"
}

# -- Venv check --
export HF_HOME=huggingface
export PYTHONUTF8=1
# 默认走 hf-mirror.com 镜像加速；国外用户可 export HF_ENDPOINT=https://huggingface.co 回直连
# （仅当用户未自行设置 HF_ENDPOINT 时才赋默认值）
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
STARTUP_HOOKS="$SCRIPT_DIR/tools/python_startup"
case ":${PYTHONPATH:-}:" in
    *":$STARTUP_HOOKS:"*) ;;
    *) export PYTHONPATH="$STARTUP_HOOKS${PYTHONPATH:+:$PYTHONPATH}" ;;
esac
_fix_pip_mirror
if [ ! -f "$VENV_PYTHON" ]; then
    echo "[Setup] Initial setup is required. / 检测到需要完成首次安装配置。"
    echo "[Setup] Using Python: $PYTHON_BIN / 正在使用 Python：$PYTHON_BIN"
    "$PYTHON_BIN" --version
    echo "[Notice] Virtual environment (venv) not found. / 未找到虚拟环境（venv）。"
    if [ "$QUIET" = "1" ]; then
        echo "  --quiet mode: auto-installing... / --quiet 模式：自动安装……"
        do_install
    else
        echo "   1. Install / 安装"
        echo "   2. Exit / 退出"
        echo ""
        read -r -p "Enter option (1/2) / 请输入选项 (1/2): " CHOICE
        if [ "$CHOICE" != "1" ]; then
            echo "Cancelled. / 已取消。"
            exit 0
        fi
        do_install
    fi
fi

# -- Managed CUDA runtime migration --
"$VENV_PYTHON" -X utf8 -m tools.ensure_runtime
if [ $? -ne 0 ]; then
    echo "[ERROR] CUDA 13.0 runtime synchronization failed. / CUDA 13.0 运行时同步失败。"
    exit 1
fi

# -- Shared Krea 2 dependency convergence --
ensure_musubi_shared_runtime

# -- Launch (backend.gui emits the first timestamped console line) --
"$VENV_PYTHON" -m backend.gui "$@"
