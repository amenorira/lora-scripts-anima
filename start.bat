@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ============================================
echo   SD-Trainer (Anima) 一键启动
echo ============================================
echo.

REM 检查 git 是否可用
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 未找到 Git，将跳过仓库更新。
    echo.
    goto :check_venv
)

echo [更新] 拉取本仓库最新代码...
echo       已排除 logs/ output/ sd-models/ venv/ config/autosave/ 等本地文件
git pull --ff-only origin main
if %errorlevel% neq 0 (
    echo [警告] 更新失败（可能有本地修改冲突），继续使用当前版本。
)
echo.

:check_venv
REM 检查虚拟环境
if exist "venv\Scripts\activate" (
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
) else (
    echo 已取消。
    pause
    exit /b 0
)

:run
echo [启动] 激活虚拟环境并启动 GUI ...
set HF_HOME=huggingface
set PYTHONUTF8=1

call "venv\Scripts\activate.bat"
python gui.py %*

pause
