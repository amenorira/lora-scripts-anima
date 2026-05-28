@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   lora-scripts-anima - 更新 + 启动
echo ============================================
echo.

REM ── 更新仓库 ──
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 未找到 Git，跳过仓库更新。
    echo.
    goto :check_venv
)

echo [更新] git pull --ff-only origin main ...
git pull --ff-only origin main
if %errorlevel% neq 0 (
    echo [警告] 更新失败（可能有本地修改冲突），继续启动...
) else (
    echo [完成] 仓库已更新。
)
echo.

:check_venv
REM ── Check virtual environment ──
if exist "venv\Scripts\python.exe" (
    goto :run
)

echo [Notice] Virtual environment (venv) not found.
echo         Please run start.bat first for first-time setup.
pause
exit /b 1

:run
echo [Launch] Activating virtual environment...
set HF_HOME=huggingface
set PYTHONUTF8=1

REM ── Deps check ──
venv\Scripts\python.exe tools\check_deps.py 2>nul
if !errorlevel! neq 0 (
    echo [Notice] Dependencies may have changed. Run start.bat to reinstall.
)

REM ── flash-attn check ──
venv\Scripts\python.exe -c "import flash_attn; print('[flash_attn] OK')" 2>nul
if !errorlevel! neq 0 (
    echo [flash_attn] NOT FOUND. RTX 40/50 series: run install-flash-attn.bat
)
echo.

venv\Scripts\python.exe gui.py %*
pause
