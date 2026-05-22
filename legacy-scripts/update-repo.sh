#!/usr/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Anima LoRA Trainer - 更新本仓库"
echo "============================================"
echo ""

if ! command -v git &>/dev/null; then
    echo "[错误] 未找到 git，请先安装 git"
    echo "       Ubuntu/Debian: sudo apt install git"
    exit 1
fi

echo "[更新] git pull --ff-only origin main ..."
if ! git pull --ff-only origin main; then
    echo "[警告] 更新失败，可能有本地修改冲突。"
    echo "       请先 git stash 或 git commit 本地修改后再试。"
    exit 1
fi
echo ""
echo "[完成] 仓库已更新到最新版本。"
