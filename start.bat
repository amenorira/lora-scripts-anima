@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   lora-scripts-anima
echo ============================================
echo.

REM ============================================================
REM  ENVIRONMENT CHECK (all checks run, issues accumulated)
REM ============================================================
echo [Check] Checking environment...
set _OK=1

REM --- 1. Python detection ---
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo   [FAIL] Python is not installed or not in PATH.
    echo          Download: https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe
    echo          Or: winget install Python.Python.3.12
    echo          !! Check [Add Python to PATH] during install !!
    set _OK=0
    goto :check_gpu
)

REM Check if MS Store stub
python -c "import sys; sys.exit(0 if 'WindowsApps' in sys.executable else 1)" >nul 2>&1
if !errorlevel! equ 0 (
    echo   [FAIL] Microsoft Store Python placeholder (not a real Python).
    echo          Install from python.org (link above).
    set _OK=0
    goto :check_gpu
)

REM Check version
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set _PYVER=%%i
    echo   [FAIL] !_PYVER! - Python 3.10+ required (3.12 recommended).
    set _OK=0
    goto :check_gpu
)

REM Check 64-bit
python -c "import struct; sys.exit(0 if struct.calcsize('P')==8 else 1)" >nul 2>&1
if !errorlevel! neq 0 (
    echo   [FAIL] 32-bit Python detected. 64-bit required.
    set _OK=0
    goto :check_gpu
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo   [OK] %%i (64-bit)

REM --- 2. GPU detection ---
:check_gpu
where nvidia-smi >nul 2>&1
if %errorlevel% neq 0 (
    echo   [WARN] nvidia-smi not found - no NVIDIA GPU or driver?
    echo          This project needs NVIDIA GPU (RTX 30/40/50) for training.
) else (
    for /f "tokens=*" %%i in ('nvidia-smi --query-gpu=name --format=csv,noheader 2^>nul') do set _GPU=%%i
    if defined _GPU (
        echo   [OK] GPU: !_GPU!
    ) else (
        echo   [WARN] nvidia-smi found but cannot read GPU info.
    )
)

REM --- 3. Disk space ---
for %%d in ("%~dp0.") do set _DRIVE=%%~dd
for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "[math]::Round((Get-PSDrive -Name '%_DRIVE:~0,1%').Free/1GB)"`) do set _FREEGB=%%a
if defined _FREEGB (
    if !_FREEGB! LSS 10 (
        echo   [FAIL] Disk free: !_FREEGB! GB. Recommend 30GB+.
        set _OK=0
    ) else if !_FREEGB! LSS 30 (
        echo   [WARN] Disk free: !_FREEGB! GB. Recommend 30GB+.
    ) else (
        echo   [OK] Disk free: !_FREEGB! GB
    )
) else (
    echo   [WARN] Could not check disk space.
)

echo.
if "!_OK!"=="0" (
    echo   Environment check FAILED. Please fix the issues above and re-run.
    echo.
    pause
    exit /b 1
)
echo   Environment check passed.
echo.

REM ============================================================
REM  VENV CHECK
REM ============================================================
if exist "venv\Scripts\python.exe" (
    goto :run
)

echo [Notice] Virtual environment (venv) not found.
echo.
echo    1. Install
echo    2. Exit
echo.
set /p _CHOICE="Enter option (1/2): "

if not "%_CHOICE%"=="1" (
    echo Cancelled.
    pause
    exit /b 0
)

REM ============================================================
REM  INSTALL (inline, no external scripts)
REM ============================================================
echo.
echo [Install] Starting installation...
echo.

if not exist "venv\Scripts\python.exe" (
    echo Creating venv...
    python -m venv venv
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create venv.
        pause
        exit /b 1
    )
)

echo [1/3] Installing PyTorch 2.10.0 + CUDA 12.8...
venv\Scripts\python.exe -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
if !errorlevel! neq 0 (
    echo [ERROR] PyTorch install failed.
    pause
    exit /b 1
)

echo [2/3] Installing sd-scripts dependencies...
venv\Scripts\python.exe -m pip install -r vendor\sd-scripts\requirements.txt
if !errorlevel! neq 0 (
    echo [ERROR] sd-scripts dependencies install failed.
    pause
    exit /b 1
)

echo [3/3] Installing project dependencies...
venv\Scripts\python.exe -m pip install --upgrade -r requirements.txt
if !errorlevel! neq 0 (
    echo [ERROR] Project dependencies install failed.
    pause
    exit /b 1
)

echo.
echo [Done] Installation complete!
echo.

REM ============================================================
REM  LAUNCH
REM ============================================================
:run
echo [Launch] Activating virtual environment...
set HF_HOME=huggingface
set PYTHONUTF8=1

REM Check deps (non-fatal)
venv\Scripts\python.exe tools\check_deps.py 2>nul
if !errorlevel! neq 0 (
    echo [Notice] Dependencies may be incomplete. Re-run start.bat to install.
)

REM Check flash-attn (non-fatal)
venv\Scripts\python.exe -c "import flash_attn; print('[flash_attn] OK')" 2>nul
if !errorlevel! neq 0 (
    echo [flash_attn] NOT FOUND. RTX 40/50 series: run install-flash-attn.bat
)
echo.

venv\Scripts\python.exe gui.py %*
pause
exit /b 0
