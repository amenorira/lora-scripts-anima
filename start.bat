@echo off
echo lora-scripts-anima
setlocal enabledelayedexpansion
cd /d "%~dp0"
title lora-scripts-anima

set _QUIET=0
for %%a in (%*) do if /i "%%a"=="--quiet" set _QUIET=1
for %%a in (%*) do if /i "%%a"=="-q" set _QUIET=1

REM -- Bootstrap: verify Python exists --
set _PYPATH=
for /f "tokens=*" %%i in ('where python 2^>nul') do if "!_PYPATH!"=="" set _PYPATH=%%i

if "!_PYPATH!"=="" (
    echo [FAIL] Python is not installed or not in PATH.
    echo        Download: https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe
    pause
    exit /b 1
)

echo !_PYPATH! | findstr /i "WindowsApps" >nul
if !errorlevel! equ 0 (
    echo [FAIL] Microsoft Store Python placeholder detected.
    pause
    exit /b 1
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set _PYVER=%%i
    echo [FAIL] !_PYVER! - Python 3.10+ required.
    pause
    exit /b 1
)

python -c "import sys; sys.exit(0 if sys.maxsize > 2**32 else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    echo [FAIL] 32-bit Python detected. 64-bit required.
    pause
    exit /b 1
)

REM -- Venv check --
if exist "venv\Scripts\python.exe" goto :run_venv

echo [Notice] Virtual environment (venv) not found.
if "!_QUIET!"=="1" (
    echo   --quiet mode: auto-installing...
    goto :install
)
echo    1. Install
echo    2. Exit
set /p _CHOICE="Enter option (1/2): "

if not "%_CHOICE%"=="1" (echo Cancelled. && pause && exit /b 0)

:install
echo.
echo [Install] Starting installation...

set PIP_DISABLE_PIP_VERSION_CHECK=1
set PIP_PREFER_BINARY=1

if not exist "venv\Scripts\python.exe" (
    echo Creating venv...
    python -m venv venv
    if !errorlevel! neq 0 (echo [ERROR] Failed to create venv. && pause && exit /b 1)
    echo Upgrading pip...
    venv\Scripts\python.exe -m pip install --upgrade pip -q
)

echo [1/3] Installing PyTorch 2.10.0+cu128...
venv\Scripts\python.exe -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
if !errorlevel! neq 0 (echo [ERROR] PyTorch install failed. && pause && exit /b 1)

echo [2/3] Installing sd-scripts deps...
pushd vendor\sd-scripts
..\..\venv\Scripts\python.exe -m pip install -r requirements.txt
set _SD_RC=!errorlevel!
popd
if !_SD_RC! neq 0 (echo [ERROR] sd-scripts deps failed. && pause && exit /b 1)

echo [3/3] Installing project deps...
venv\Scripts\python.exe -m pip install --upgrade -r requirements.txt
if !errorlevel! neq 0 (echo [ERROR] Project deps failed. && pause && exit /b 1)

echo [Done] Installation complete!
set HF_HOME=huggingface
set PYTHONUTF8=1
goto :launch

:run_venv
set HF_HOME=huggingface
set PYTHONUTF8=1

REM Quick torch sanity check
echo Checking torch...
venv\Scripts\python.exe -c "import torch" 2>nul
if !errorlevel! neq 0 (
    echo [Notice] venv exists but torch missing -- repairing...
    goto :install
)

:launch
echo Starting...
venv\Scripts\python.exe gui.py %*
pause
exit /b 0
