@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   安装 Flash Attention（RTX 40/50 系）
echo ============================================
echo.

REM 检查 venv
if not exist "venv\Scripts\activate.bat" (
    echo [错误] 未找到虚拟环境，请先运行 install.ps1
    pause
    exit /b 1
)

call "venv\Scripts\activate.bat"

REM 先检查是否已安装
python -c "import flash_attn; print(flash_attn.__version__)" 2>nul
if %errorlevel% equ 0 (
    echo [已安装] Flash Attention 已就绪，无需重复安装。
    pause
    exit /b 0
)

echo [检测] 检查 GPU 和 CUDA 环境...
python -c "import torch; print(f'CUDA {torch.version.cuda}, PyTorch {torch.__version__}, GPU: {torch.cuda.get_device_name(0)}')"

echo.
echo [安装] 尝试 pip install flash-attn（优先预编译 wheel）...
echo.

REM 先尝试直接 pip（可能命中预编译 wheel）
pip install flash-attn 2>nul
if %errorlevel% equ 0 goto :done

:try_prebuilt
echo [安装] 尝试 pip install flash-attn（预编译 wheel）...
pip install flash-attn 2>nul
if %errorlevel% equ 0 goto :done

REM 预编译未命中（Windows 通常没有）。自动检测 CUDA 版本匹配社区 wheel
echo.
echo [提示] Windows 无官方预编译 wheel，尝试匹配社区预编译版...

REM 获取环境信息
for /f "tokens=*" %%i in ('python -c "import torch; print(torch.version.cuda.replace('.',''))" 2^>nul') do set CUDA_VER=%%i
for /f "tokens=1,2 delims=." %%a in ('python -c "import torch; print(torch.__version__.split('+')[0])" 2^>nul') do set TORCH_VER=%%a.%%b
for /f "tokens=*" %%i in ('python -c "import sys; print(f'cp{sys.version_info.major}{sys.version_info.minor}')" 2^>nul') do set PY_VER=%%i
if "%CUDA_VER%"=="" set CUDA_VER=128
if "%TORCH_VER%"=="" set TORCH_VER=2.5.1

echo        CUDA: %CUDA_VER%  PyTorch: %TORCH_VER%  Python: %PY_VER%

REM 尝试从 GitHub 下载预编译 wheel
set WHEEL_NAME=flash_attn-2.7.4.post1+cu%CUDA_VER%torch%TORCH_VER%-%PY_VER%-%PY_VER%-win_amd64.whl
set WHEEL_URL=https://github.com/bdashore3/flash-attention/releases/download/v2.7.4.post1/%WHEEL_NAME%

echo        尝试下载: %WHEEL_NAME%
curl -L -o "%WHEEL_NAME%" "%WHEEL_URL%" 2>nul
if exist "%WHEEL_NAME%" (
    echo        安装中...
    pip install "%WHEEL_NAME%" 2>nul
    del "%WHEEL_NAME%" 2>nul
    if %errorlevel% equ 0 goto :done
)

REM 全部失败，给手动指引
echo.
echo [提示] 自动安装未成功，请手动处理:
echo       1. 下载预编译 wheel: https://github.com/bdashore3/flash-attention/releases
echo          选择匹配 CUDA %CUDA_VER% + Python 3.12 + torch 2.6 的 .whl
echo       2. pip install 下载的.whl
echo       3. 或编译安装: pip install flash-attn --no-build-isolation
pause
exit /b 1

:done
echo.
echo [完成] Flash Attention 安装成功！
python -c "import flash_attn; print(f'版本: {flash_attn.__version__}')"
pause
