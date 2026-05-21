#!/usr/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Anima LoRA Trainer - 启动"
echo "============================================"
echo ""

# 检查虚拟环境
if [ -f "venv/bin/activate" ]; then
    echo "[启动] 激活虚拟环境并启动 GUI ..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"

    # 检测 flash-attn 状态
    if FA_VER=$(python -c "from importlib.metadata import version; print(version('flash_attn'))" 2>/dev/null); then
        echo "[flash_attn] ✅ 已启用 (版本 $FA_VER)"
    else
        echo "[flash_attn] ❌ 未安装 — RTX 40/50 系建议安装: bash install-flash-attn.sh"
    fi
    echo ""

    python gui.py "$@"
else
    echo "[提示] 未检测到虚拟环境 (venv)。"
    echo ""
    echo "   [1] 安装（运行 install.bash）"
    echo "   [2] 退出"
    echo ""
    read -p "请输入选项 (1/2): " choice

    if [ "$choice" = "1" ]; then
        echo ""
        echo "[安装] 开始运行 install.bash ..."
        bash "$SCRIPT_DIR/install.bash"
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
