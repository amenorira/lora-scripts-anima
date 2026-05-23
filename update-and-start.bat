@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   lora-scripts-anima - Update + Start / 更新并启动
echo ============================================
echo.

REM -- Git pull / 拉取更新 --
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Git not found, skipping update / 未找到 Git，跳过更新.
    echo.
    goto :check_venv
)

echo [UPDATE] git pull --ff-only origin main ...
git pull --ff-only origin main
if %errorlevel% neq 0 (
    echo [WARN] Update failed (may have local changes), continuing / 更新失败（可能有本地修改），继续启动...
) else (
    echo [OK] Repository updated / 仓库已更新.
)
echo.

:check_venv
REM -- Check venv / 检查虚拟环境 --
if exist "venv\Scripts\activate.bat" (
    goto :run
)

echo [INFO] venv not found / 未检测到虚拟环境 (venv).
echo.
echo    [1] Install / 安装 (run install.ps1)
echo    [2] Exit / 退出
echo.
set /p choice=Please select / 请输入选项 (1/2):

if "%choice%"=="1" (
    echo.
    echo [INSTALL] Running install.ps1 / 开始安装...
    powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"
    if %errorlevel% neq 0 (
        echo [ERROR] Install failed / 安装失败
        pause
        exit /b 1
    )
    echo [OK] Install done, starting / 安装完成，开始启动...
    echo.
    goto :run
)
echo Cancelled / 已取消.
pause
exit /b 0

:run
echo [START] Activating venv / 激活虚拟环境...
set HF_HOME=huggingface
set PYTHONUTF8=1
call "venv\Scripts\activate.bat"

REM -- Dependency check / 依赖完整性检测 --
echo [CHECK] Verifying Python deps / 检查 Python 依赖...
python tools\check_deps.py
if %errorlevel% neq 0 (
    echo.
    echo [WARN] Dependencies may have changed after update / 仓库更新后依赖可能不完整.
    echo    [1] Auto-fix / 自动修复
    echo    [2] Skip and continue / 忽略并继续启动
    echo.
    set /p fix_choice=Please select / 请输入选项 (1/2):
    if "!fix_choice!"=="1" (
        echo [FIX] Installing missing deps / 正在安装缺失依赖...
        python tools\check_deps.py --fix
        if !errorlevel! neq 0 (
            echo [ERROR] Fix failed, run install.ps1 manually / 修复失败，请手动运行 install.ps1
            pause
            exit /b 1
        )
        echo [OK] Dependencies fixed / 依赖修复完成
    )
)
echo.

REM -- flash-attn check / 检测 flash-attn --
python -c "import flash_attn; print('[flash_attn] OK')" 2>nul || echo [flash_attn] NOT FOUND / 未找到 -- RTX 40/50 series recommended: .\install-flash-attn.bat
echo.

python gui.py %*
pause
