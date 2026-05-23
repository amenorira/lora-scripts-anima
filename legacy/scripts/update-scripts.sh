#!/usr/bin/env bash
set -e

echo "============================================"
echo "  lora-scripts-anima - 更新 kohya-ss/sd-scripts 脚本"
echo "============================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="${SCRIPT_DIR}/_sdscripts_temp"

# 检查 git 是否可用
if ! command -v git &>/dev/null; then
    echo "[错误] 未找到 git，请先安装 git"
    echo "Ubuntu/Debian: sudo apt install git"
    echo "CentOS/RHEL:   sudo yum install git"
    exit 1
fi

# [1/4] 克隆最新版
echo "[1/4] 正在克隆最新的 kohya-ss/sd-scripts ..."
rm -rf "$TEMP_DIR"
git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git "$TEMP_DIR"
echo "[OK] 克隆完成"

# [2/4] 删除旧版目录
echo "[2/4] 正在删除旧版 sd-scripts/stable 和 sd-scripts/dev ..."
rm -rf "${SCRIPT_DIR}/../vendor/sd-scripts/stable"
echo "[OK] 已删除 vendor/sd-scripts/stable"
rm -rf "${SCRIPT_DIR}/../vendor/sd-scripts/dev"
echo "[OK] 已删除 sd-scripts/dev"

# [3/4] 复制新版
echo "[3/4] 正在复制新版脚本到 sd-scripts/ ..."
# 复制所有文件到 sd-scripts/，但排除 .git 目录
rsync -a "$TEMP_DIR/" "${SCRIPT_DIR}/../vendor/sd-scripts/" --exclude='.git' --exclude='.gitignore' --exclude='.github' 2>/dev/null || \
    cp -rf "$TEMP_DIR"/* "${SCRIPT_DIR}/../vendor/sd-scripts/" 2>/dev/null
# 如果 rsync 不可用，用 cp + 手动清理
rm -rf "${SCRIPT_DIR}/../vendor/sd-scripts/.git" 2>/dev/null || true
rm -f "${SCRIPT_DIR}/../vendor/sd-scripts/.gitignore" 2>/dev/null || true
rm -rf "${SCRIPT_DIR}/../vendor/sd-scripts/.github" 2>/dev/null || true
echo "[OK] 复制完成"

# [4/4] 清理
echo "[4/4] 清理临时文件 ..."
rm -rf "$TEMP_DIR"
echo "[OK] 清理完成"

echo ""
echo "============================================"
echo "  更新完成！"
echo "  sd-scripts/ 目录现在是单一版本的最新 sd-scripts"
echo "  backend/app/api.py 及其他脚本的路径已同步更新"
echo "============================================"
echo ""
