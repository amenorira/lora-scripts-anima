#!/usr/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  lora-scripts-anima - Update + Start / 更新并启动"
echo "============================================"
echo ""

# -- Git pull / 拉取更新 --
if command -v git &> /dev/null; then
    echo "[UPDATE] git pull --ff-only origin main ..."
    if git pull --ff-only origin main; then
        echo "[OK] Repository updated / 仓库已更新."
    else
        echo "[WARN] Update failed (may have local changes), continuing / 更新失败（可能有本地修改），继续启动..."
    fi
else
    echo "[WARN] Git not found, skipping update / 未找到 Git，跳过更新."
fi
echo ""

# -- Check venv / 检查虚拟环境 --
if [ -f "venv/bin/activate" ]; then
    echo "[START] Activating venv / 激活虚拟环境..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"

    # Dependency check / 依赖完整性检测
    echo "[CHECK] Verifying Python deps / 检查 Python 依赖..."
    if ! python tools/check_deps.py; then
        echo ""
        echo "[WARN] Dependencies may have changed after update / 仓库更新后依赖可能不完整."
        echo "   [1] Auto-fix / 自动修复"
        echo "   [2] Skip and continue / 忽略并继续启动"
        echo ""
        read -p "Please select / 请输入选项 (1/2): " fix_choice
        if [ "$fix_choice" = "1" ]; then
            echo "[FIX] Installing missing deps / 正在安装缺失依赖..."
            python tools/check_deps.py --fix
            if [ $? -ne 0 ]; then
                echo "[ERROR] Fix failed, run install.sh manually / 修复失败，请手动运行 install.sh"
                exit 1
            fi
            echo "[OK] Dependencies fixed / 依赖修复完成"
        fi
    fi
    echo ""

    # flash-attn check / 检测 flash-attn
    if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
        echo "[flash_attn] OK (version / 版本 $FA_VER)"
    else
        echo "[flash_attn] NOT FOUND / 未找到 -- RTX 40/50 series recommended: bash install-flash-attn.sh"
    fi
    echo ""

    python gui.py "$@"
else
    echo "[INFO] venv not found / 未检测到虚拟环境 (venv)."
    echo ""
    echo "   [1] Install / 安装 (run install.sh)"
    echo "   [2] Exit / 退出"
    echo ""
    read -p "Please select / 请输入选项 (1/2): " choice

    if [ "$choice" = "1" ]; then
        echo ""
        echo "[INSTALL] Running install.sh / 开始安装..."
        bash "$SCRIPT_DIR/install.sh"
        if [ $? -ne 0 ]; then
            echo "[ERROR] Install failed / 安装失败"
            exit 1
        fi
        echo "[OK] Install done, starting / 安装完成，开始启动..."
        echo ""
        export HF_HOME=huggingface
        export PYTHONUTF8=1
        source "venv/bin/activate"
        python gui.py "$@"
    else
        echo "Cancelled / 已取消."
        exit 0
    fi
fi
