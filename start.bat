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

REM -- pip mirror HTTPS upgrade (non-invasive, self-contained) --
REM Do not modify host pip.ini / original env values; take over via process env
REM vars only. pip precedence: CLI -i > PIP_* env > pip.ini, so exported env vars
REM override host pip.ini and are inherited by PEP 517 build subprocesses
REM (vendor/sd-scripts sdist) and gui.py runtime pip. Gone when script exits.
REM Logic: probe index-url/extra-index-url via `pip config get` (read-only) --
REM   http://  -> export https:// equivalent + register PIP_TRUSTED_HOST (upgrade)
REM   https:// -> leave as-is (already safe)
REM   none     -> leave as-is (use official PyPI)
REM No built-in mirror; auto-adapts CN/abroad. Probe uses system python (available
REM before venv exists); host pip.conf is the same regardless of which python reads it.
set _PIP_FIXED=0
for %%k in (global.index-url global.extra-index-url) do (
    for /f "delims=" %%v in ('python -m pip config get %%k 2^>nul') do (
        set "_val=%%v"
        if "!_val:~0,7!"=="http://" if not "!_val:~7!"=="" (
            for /f "delims=/" %%h in ("!_val:~7!") do set "_host=%%h"
            set "_probe= !PIP_TRUSTED_HOST! "
            echo !_probe!| findstr /i /c:" !_host! " >nul
            if errorlevel 1 set "PIP_TRUSTED_HOST=!PIP_TRUSTED_HOST! !_host!" & set _PIP_FIXED=1
            if "%%k"=="global.extra-index-url" (set "PIP_EXTRA_INDEX_URL=https://!_val:~7!") else (set "PIP_INDEX_URL=https://!_val:~7!")
        )
    )
)
REM Also handle existing PIP_* env vars (fallback: source from env not config)
for %%v in (PIP_INDEX_URL PIP_EXTRA_INDEX_URL) do (
    if defined %%v (
        set "_val=!%%v!"
        if "!_val:~0,7!"=="http://" if not "!_val:~7!"=="" (
            for /f "delims=/" %%h in ("!_val:~7!") do set "_host=%%h"
            set "_probe= !PIP_TRUSTED_HOST! "
            echo !_probe!| findstr /i /c:" !_host! " >nul
            if errorlevel 1 set "PIP_TRUSTED_HOST=!PIP_TRUSTED_HOST! !_host!" & set _PIP_FIXED=1
            set "%%v=https://!_val:~7!"
        )
    )
)
if "!_PIP_FIXED!"=="1" for /f "tokens=* delims= " %%a in ("!PIP_TRUSTED_HOST!") do set "PIP_TRUSTED_HOST=%%a"
if "!_PIP_FIXED!"=="1" echo [Setup] Upgraded HTTP pip mirror to HTTPS; trusted-host: !PIP_TRUSTED_HOST!

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
REM Pre-lock setuptools to prevent PyTorch pulling in 82+, then [3/3] downgrading it.
venv\Scripts\python.exe -m pip install "setuptools>=68,<82" -q
if !errorlevel! neq 0 (echo [ERROR] setuptools pre-lock failed. && pause && exit /b 1)
venv\Scripts\python.exe -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
if !errorlevel! neq 0 (echo [ERROR] PyTorch install failed. && pause && exit /b 1)

echo [2/3] Installing sd-scripts deps...
pushd vendor\sd-scripts
..\..\venv\Scripts\python.exe -m pip install -r requirements.txt
set _SD_RC=!errorlevel!
popd
if !_SD_RC! neq 0 (echo [ERROR] sd-scripts deps failed. && pause && exit /b 1)

echo [3/3] Installing project deps...
venv\Scripts\python.exe -m pip install -r requirements.txt
if !errorlevel! neq 0 (echo [ERROR] Project deps failed. && pause && exit /b 1)

echo [Done] Installation complete!
set HF_HOME=huggingface
set PYTHONUTF8=1
REM 默认走 hf-mirror.com 镜像加速；国外用户可 set HF_ENDPOINT=https://huggingface.co 回直连
if not defined HF_ENDPOINT set HF_ENDPOINT=https://hf-mirror.com
goto :launch

:run_venv
set HF_HOME=huggingface
set PYTHONUTF8=1
if not defined HF_ENDPOINT set HF_ENDPOINT=https://hf-mirror.com

:launch
venv\Scripts\python.exe gui.py %*
pause
exit /b 0
