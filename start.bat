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

REM RTX 50 系 / Hopper+ 推荐 flash-attn
echo [提示] RTX 4090/5090 建议安装 flash-attn 以获得最佳性能
echo        pip install flash-attn --no-build-isolation
echo.

python gui.py %*
pause
