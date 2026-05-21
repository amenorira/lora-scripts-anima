@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   安装 Flash Attention（RTX 40/50 系）
echo ============================================
echo.

REM 检查 venv
if not exist "venv\Scripts\activate.bat" (
    echo [错误] 未找到虚拟环境，请先运行 install.ps1
    pause
    exit /b 1
)

call "venv\Scripts\activate.bat"

REM 委托给智能 Python 安装脚本
echo [启动] 运行智能 wheel 匹配安装...
echo.
python "tools\install_flash_attn.py" %*
exit /b %errorlevel%
