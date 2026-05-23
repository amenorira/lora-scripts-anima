@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   lora-scripts-anima - 更新本仓库
echo ============================================
echo.

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Git，请先安装 Git for Windows
    echo        https://git-scm.com/download/win
    pause
    exit /b 1
)

echo [更新] git pull --ff-only origin main ...
git pull --ff-only origin main
if %errorlevel% neq 0 (
    echo [警告] 更新失败，可能有本地修改冲突。
    echo        请先 git stash 或 git commit 本地修改后再试。
    pause
    exit /b 1
)
echo.
echo [完成] 仓库已更新到最新版本。
pause
