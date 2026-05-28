@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title lora-scripts-anima

echo ============================================
echo   lora-scripts-anima
echo ============================================

echo [Check] Checking environment...
set _OK=1

set _PYPATH=
for /f "tokens=*" %%i in ('where python 2^>nul') do if "!_PYPATH!"=="" set _PYPATH=%%i

if "!_PYPATH!"=="" (
    echo   [FAIL] Python is not installed or not in PATH.
    echo          Download: https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe
    set _OK=0
    goto :check_gpu
)

echo !_PYPATH! | findstr /i "WindowsApps" >nul
if !errorlevel! equ 0 (
    echo   [FAIL] Microsoft Store Python placeholder detected.
    set _OK=0
    goto :check_gpu
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set _PYVER=%%i
    echo   [FAIL] !_PYVER! - Python 3.10+ required.
    set _OK=0
    goto :check_gpu
)

python -c "import sys; sys.exit(0 if sys.maxsize > 2**32 else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    echo   [FAIL] 32-bit Python detected. 64-bit required.
    set _OK=0
    goto :check_gpu
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo   [OK] %%i (64-bit)

:check_gpu
where nvidia-smi >nul 2>&1
if %errorlevel% neq 0 (
    echo   [WARN] nvidia-smi not found.
) else (
    for /f "tokens=*" %%i in ('nvidia-smi --query-gpu=name --format=csv,noheader 2^>nul') do set _GPU=%%i
    if defined _GPU (echo   [OK] GPU: !_GPU!) else (echo   [WARN] Cannot read GPU info.)
)

set _DRIVE=%~d0
for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "[math]::Round((Get-PSDrive -Name '!_DRIVE:~0,1!').Free/1GB)" 2^>nul`) do set _FREEGB=%%a
if defined _FREEGB (
    if !_FREEGB! LSS 10 (echo   [FAIL] Disk free: !_FREEGB! GB) else if !_FREEGB! LSS 30 (echo   [WARN] Disk free: !_FREEGB! GB) else (echo   [OK] Disk free: !_FREEGB! GB)
) else (
    echo   [WARN] Could not check disk space.
)

echo.
if "!_OK!"=="0" (
    echo   Environment check FAILED.
    pause
    exit /b 1
)
echo   Environment check passed.
echo.

if exist "venv\Scripts\python.exe" goto :run

echo [Notice] Virtual environment (venv) not found.
echo    1. Install
echo    2. Exit
set /p _CHOICE="Enter option (1/2): "

if not "%_CHOICE%"=="1" (echo Cancelled. && pause && exit /b 0)

echo.
echo [Install] Starting installation...

if not exist "venv\Scripts\python.exe" (
    echo Creating venv...
    python -m venv venv
    if !errorlevel! neq 0 (echo [ERROR] Failed to create venv. && pause && exit /b 1)
)

echo [1/3] Installing PyTorch...
venv\Scripts\python.exe -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
if !errorlevel! neq 0 (echo [ERROR] PyTorch install failed. && pause && exit /b 1)

echo [2/3] Installing sd-scripts deps...
venv\Scripts\python.exe -m pip install -r vendor\sd-scripts\requirements.txt
if !errorlevel! neq 0 (echo [ERROR] sd-scripts deps failed. && pause && exit /b 1)

echo [3/3] Installing project deps...
venv\Scripts\python.exe -m pip install --upgrade -r requirements.txt
if !errorlevel! neq 0 (echo [ERROR] Project deps failed. && pause && exit /b 1)

echo [Done] Installation complete!

:run
echo [Launch] Starting...
set HF_HOME=huggingface
set PYTHONUTF8=1

venv\Scripts\python.exe tools\check_deps.py 2>nul
if !errorlevel! neq 0 echo [Notice] Dependencies may be incomplete.

venv\Scripts\python.exe -c "import flash_attn; print('[flash_attn] OK')" 2>nul
if !errorlevel! neq 0 echo [flash_attn] NOT FOUND. Run install-flash-attn.bat

echo.
venv\Scripts\python.exe gui.py %*
pause
exit /b 0
