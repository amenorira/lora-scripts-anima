@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title lora-scripts-anima

set _QUIET=0
for %%a in (%*) do if /i "%%a"=="--quiet" set _QUIET=1
for %%a in (%*) do if /i "%%a"=="-q" set _QUIET=1

REM -- Bootstrap: select a compatible 64-bit Python (3.10-3.12) --
REM Prefer an existing compatible venv, then Python Launcher 3.12. If only a
REM newer Python exists, offer a side-by-side per-user Python 3.12 install.
call :select_python
if !errorlevel! neq 0 (
    pause
    exit /b 1
)

echo [Setup] Using Python from !_PYTHON_SOURCE!: !_PYTHON_EXE!
"!_PYTHON_EXE!" --version

REM -- pip mirror HTTPS upgrade (non-invasive, self-contained) --
REM Do not modify host pip.ini / original env values; take over via process env
REM vars only. pip precedence: CLI -i > PIP_* env > pip.ini, so exported env vars
REM override host pip.ini and are inherited by PEP 517 build subprocesses
REM (vendor/sd-scripts sdist) and gui.py runtime pip. Gone when script exits.
REM Logic: probe index-url/extra-index-url via `pip config get` (read-only) --
REM   http://  -> export https:// equivalent + register PIP_TRUSTED_HOST (upgrade)
REM   https:// -> leave as-is (already safe)
REM   none     -> leave as-is (use official PyPI)
REM No built-in mirror; auto-adapts CN/abroad. Probe uses the selected Python;
REM host pip.conf is the same regardless of which compatible interpreter reads it.
set _PIP_FIXED=0
for %%k in (global.index-url global.extra-index-url) do (
    for /f "delims=" %%v in ('"!_PYTHON_EXE!" -m pip config get %%k 2^>nul') do (
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
    "!_PYTHON_EXE!" -m venv venv
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

:select_python
set "_PYTHON_EXE="
set "_PYTHON_SOURCE="

REM A valid project venv must win even if the host's `python` is a Store alias.
if exist "venv\Scripts\python.exe" (
    "venv\Scripts\python.exe" -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,13) and sys.maxsize > 2**32 else 1)" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [FAIL] Existing venv uses an unsupported Python version or architecture.
        "venv\Scripts\python.exe" --version 2>nul
        echo        Supported: 64-bit Python 3.10-3.12 ^(3.12 recommended^).
        echo        Rename or remove only this project's "venv" folder, then rerun start.bat.
        exit /b 1
    )
    set "_PYTHON_EXE=%CD%\venv\Scripts\python.exe"
    set "_PYTHON_SOURCE=existing venv"
    exit /b 0
)

REM Prefer Python Launcher so Python 3.12 can coexist with Python 3.13/3.14.
for %%v in (3.12 3.11 3.10) do (
    if not defined _PYTHON_EXE (
        for /f "delims=" %%i in ('py -%%v -c "import sys; print(sys.executable)" 2^>nul') do (
            call :try_python_candidate "%%i" "Python Launcher"
        )
    )
)

REM Check common per-user locations even when py.exe is unavailable.
if not defined _PYTHON_EXE call :try_python_candidate "%LocalAppData%\Programs\Python\Python312\python.exe" "per-user install"
if not defined _PYTHON_EXE call :try_python_candidate "%LocalAppData%\Python\pythoncore-3.12-64\python.exe" "Python install manager"
if not defined _PYTHON_EXE call :try_python_candidate "%ProgramFiles%\Python312\python.exe" "system install"

REM Scan every PATH result. Do not stop at a Microsoft Store placeholder.
for %%c in (python3.12.exe python3.11.exe python3.10.exe python3.exe python.exe) do (
    if not defined _PYTHON_EXE (
        for /f "delims=" %%i in ('where %%c 2^>nul') do (
            if not defined _PYTHON_EXE (
                call :try_path_candidate "%%i"
            )
        )
    )
)

if defined _PYTHON_EXE exit /b 0

echo [Notice] No compatible 64-bit Python installation was found.
echo          Required: Python 3.10-3.12 ^(Python 3.12 recommended^).
echo          Python 3.13/3.14 may remain installed, but cannot create this venv.
echo.
if "!_QUIET!"=="1" (
    set "_PY_INSTALL_CHOICE=1"
) else (
    echo    1. Install Python 3.12 for the current user ^(recommended^)
    echo    2. Exit
    set /p _PY_INSTALL_CHOICE="Enter option (1/2): "
)

if not "!_PY_INSTALL_CHOICE!"=="1" (
    echo [FAIL] Compatible Python is required. Existing Python versions do not need removal.
    exit /b 1
)

call :install_python312
exit /b !errorlevel!

:try_path_candidate
set "_CANDIDATE=%~1"
echo(!_CANDIDATE!| findstr /i /c:"WindowsApps" >nul
if errorlevel 1 call :try_python_candidate "!_CANDIDATE!" "PATH"
exit /b 0

:try_python_candidate
set "_CANDIDATE=%~1"
if not exist "!_CANDIDATE!" exit /b 0
"!_CANDIDATE!" -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,13) and sys.maxsize > 2**32 else 1)" >nul 2>&1
if !errorlevel! equ 0 (
    set "_PYTHON_EXE=!_CANDIDATE!"
    set "_PYTHON_SOURCE=%~2"
)
exit /b 0

:install_python312
set "_PYTHON_INSTALL_URL=https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
set "_PYTHON_INSTALLER=%TEMP%\python-3.12.10-amd64.exe"
set "_PYTHON_INSTALL_DIR=%LocalAppData%\Programs\Python\Python312"

echo [Setup] Downloading official Python 3.12.10 installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:_PYTHON_INSTALL_URL -OutFile $env:_PYTHON_INSTALLER; $sig=Get-AuthenticodeSignature -LiteralPath $env:_PYTHON_INSTALLER; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notlike '*Python Software Foundation*') { throw 'Python installer signature verification failed' }"
if !errorlevel! neq 0 (
    echo [ERROR] Python 3.12 download or signature verification failed.
    echo         Manual download: !_PYTHON_INSTALL_URL!
    exit /b 1
)

echo [Setup] Installing Python 3.12 for the current user ^(side by side^)...
start /wait "" "!_PYTHON_INSTALLER!" /quiet InstallAllUsers=0 AssociateFiles=0 Shortcuts=0 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 TargetDir="!_PYTHON_INSTALL_DIR!"
set "_PYTHON_INSTALL_RC=!errorlevel!"
del /q "!_PYTHON_INSTALLER!" >nul 2>&1
if not "!_PYTHON_INSTALL_RC!"=="0" (
    echo [ERROR] Python 3.12 installer failed with code !_PYTHON_INSTALL_RC!.
    exit /b 1
)

call :try_python_candidate "!_PYTHON_INSTALL_DIR!\python.exe" "automatic per-user install"
if not defined _PYTHON_EXE (
    echo [ERROR] Python 3.12 installation completed, but python.exe was not found.
    exit /b 1
)

echo [Done] Python 3.12 installed without changing the default PATH.
exit /b 0
