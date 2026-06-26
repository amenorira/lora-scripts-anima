@echo off
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

REM -- pip mirror bypass (PEP 517 subprocess fallback) --
REM Every pip install below forces the base index to official PyPI via
REM -i https://pypi.org/simple (highest priority, overrides pip.conf and env
REM vars). But PEP 517 build subprocesses (vendor/sd-scripts sdist builds) do
REM not inherit CLI args, only the environment, so still strip PIP_* index /
REM trusted-host vars as a fallback so they also fall back to default PyPI.
set _PIP_STRIPPED=0
for %%v in (PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST) do (
    if defined %%v (
        set "%%v="
        set _PIP_STRIPPED=1
    )
)
if "!_PIP_STRIPPED!"=="1" echo [Setup] Stripped pip mirror env vars; using official PyPI.

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
    venv\Scripts\python.exe -m pip install --upgrade pip -q -i https://pypi.org/simple
)

echo [1/3] Installing PyTorch 2.10.0+cu128...
REM Pre-lock setuptools to prevent PyTorch pulling in 82+, then [3/3] downgrading it.
venv\Scripts\python.exe -m pip install "setuptools>=68,<82" -q -i https://pypi.org/simple
if !errorlevel! neq 0 (echo [ERROR] setuptools pre-lock failed. && pause && exit /b 1)
venv\Scripts\python.exe -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 -i https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cu128
if !errorlevel! neq 0 (echo [ERROR] PyTorch install failed. && pause && exit /b 1)

echo [2/3] Installing sd-scripts deps...
pushd vendor\sd-scripts
..\..\venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.org/simple
set _SD_RC=!errorlevel!
popd
if !_SD_RC! neq 0 (echo [ERROR] sd-scripts deps failed. && pause && exit /b 1)

echo [3/3] Installing project deps...
venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.org/simple
if !errorlevel! neq 0 (echo [ERROR] Project deps failed. && pause && exit /b 1)

echo [Done] Installation complete!
set HF_HOME=huggingface
set PYTHONUTF8=1
goto :launch

:run_venv
set HF_HOME=huggingface
set PYTHONUTF8=1

:launch
venv\Scripts\python.exe gui.py %*
pause
exit /b 0
