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
    echo "[错误] 未找到虚拟环境，请先运行 install.bash"
    exit 1
fi

source "venv/bin/activate"

# 先检查是否已安装
if python -c "import flash_attn; print(flash_attn.__version__)" 2>/dev/null; then
    echo "[已安装] Flash Attention 已就绪，无需重复安装。"
    exit 0
fi

echo "[检测] 检查 GPU 和 CUDA 环境..."
python -c "import torch; print(f'CUDA {torch.version.cuda}, PyTorch {torch.__version__}, GPU: {torch.cuda.get_device_name(0)}')" || true

echo ""
echo "[安装] pip install flash-attn（优先预编译 wheel）..."
echo ""

# Linux 通常有预编译 wheel
if pip install flash-attn 2>/dev/null; then
    echo ""
    echo "[完成] Flash Attention 安装成功！"
    python -c "import flash_attn; print(f'版本: {flash_attn.__version__}')"
    exit 0
fi

# 预编译未命中，尝试编译
echo "[提示] 预编译 wheel 未命中，尝试编译安装（约 10-20 分钟）..."
echo "       pip install flash-attn --no-build-isolation"
echo ""
read -p "是否继续编译安装？(y/n): " confirm
if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    pip install flash-attn --no-build-isolation
    echo ""
    echo "[完成] Flash Attention 安装成功！"
    python -c "import flash_attn; print(f'版本: {flash_attn.__version__}')"
else
    echo "已取消。"
fi