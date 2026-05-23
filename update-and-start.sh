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

# ── 检查虚拟环境 ──
if [ -f "venv/bin/activate" ]; then
    echo "[启动] 激活虚拟环境..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"

    # 检测 flash-attn
    if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
        echo "[flash_attn] OK (版本 $FA_VER)"
    else
        echo "[flash_attn] NOT FOUND — RTX 40/50 系建议: bash install-flash-attn.sh"
    fi
    echo ""

    python gui.py "$@"
else
    echo "[提示] 未检测到虚拟环境 (venv)。"
    echo ""
    echo "   [1] 安装（运行 install.sh）"
    echo "   [2] 退出"
    echo ""
    read -p "请输入选项 (1/2): " choice

    if [ "$choice" = "1" ]; then
        echo ""
        echo "[安装] 开始运行 install.sh ..."
        bash "$SCRIPT_DIR/install.sh"
        if [ $? -ne 0 ]; then
            echo "[错误] 安装失败"
            exit 1
        fi
        echo "[完成] 安装完成，开始启动..."
        echo ""
        export HF_HOME=huggingface
        export PYTHONUTF8=1
        source "venv/bin/activate"
        python gui.py "$@"
    else
        echo "已取消。"
        exit 0
    fi
fi
