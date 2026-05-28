#!/usr/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  安装 Flash Attention（RTX 40/50 系）"
echo "============================================"
echo ""

# 检查 venv
if [ ! -f "venv/bin/activate" ]; then
    echo "[错误] 未找到虚拟环境，请先运行 start.sh"
    exit 1
fi

source "venv/bin/activate"

# 委托给智能 Python 安装脚本
echo "[启动] 运行智能 wheel 匹配安装..."
echo ""
python "tools/install_flash_attn.py" "$@"
exit $?