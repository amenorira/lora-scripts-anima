#!/usr/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  SD-Trainer (Anima) 一键启动"
echo "============================================"
echo ""

# 检查 git 是否可用
if ! command -v git &> /dev/null; then
    echo "[警告] 未找到 Git，将跳过仓库更新。"
    echo ""
else
    echo "[更新] 拉取本仓库最新代码..."
    echo "       已排除 logs/ output/ sd-models/ venv/ config/autosave/ 等本地文件"
    git pull --ff-only origin main || echo "[警告] 更新失败（可能有本地修改冲突），继续使用当前版本。"
    echo ""
fi

# 检查虚拟环境
if [ -f "venv/bin/activate" ]; then
    echo "[启动] 激活虚拟环境并启动 GUI ..."
    export HF_HOME=huggingface
    export PYTHONUTF8=1
    source "venv/bin/activate"
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
