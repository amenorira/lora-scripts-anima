@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ============================================
echo   Anima LoRA Trainer - 启动
echo ============================================
echo.

REM 检查虚拟环境
if exist "venv\Scripts\activate.bat" (
    goto :run
)

echo [提示] 未检测到虚拟环境 (venv)。
echo.
echo    [1] 安装（运行 install.ps1）
echo    [2] 退出
echo.
set /p choice=请输入选项 (1/2): 

if "%choice%"=="1" (
    echo.
    echo [安装] 开始运行 install.ps1 ...
    powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"
    if %errorlevel% neq 0 (
        echo [错误] 安装失败
        pause
        exit /b 1
    )
    echo [完成] 安装完成，开始启动...
    echo.
    goto :run
)
echo 已取消。
pause
exit /b 0

:run
echo [启动] 激活虚拟环境并启动 GUI ...
set HF_HOME=huggingface
set PYTHONUTF8=1
call "venv\Scripts\activate.bat"

REM 检测 flash-attn 状态
python -c "from importlib.metadata import version; print(f'[flash_attn] 已启用 (版本 {version(\"flash_attn\")})')" 2>nul || echo [flash_attn] ❌ 未安装 — RTX 40/50 系建议安装: .\install-flash-attn.bat
echo.

python gui.py %*
pause
