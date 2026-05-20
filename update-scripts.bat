@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo   SD-Trainer - 更新 kohya-ss/sd-scripts 脚本
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "TEMP_DIR=%SCRIPT_DIR%_sdscripts_temp"

REM 检查 git 是否可用
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 git，请先安装 Git for Windows
    echo 下载地址: https://git-scm.com/download/win
    pause
    exit /b 1
)

echo [1/4] 正在克隆最新的 kohya-ss/sd-scripts ...
if exist "%TEMP_DIR%" (
    rmdir /s /q "%TEMP_DIR%"
)
git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git "%TEMP_DIR%"
if %errorlevel% neq 0 (
    echo [错误] 克隆失败，请检查网络连接
    pause
    exit /b 1
)
echo [OK] 克隆完成

echo [2/4] 正在删除旧版 scripts/stable 和 scripts/dev ...
if exist "%SCRIPT_DIR%scripts\stable" (
    rmdir /s /q "%SCRIPT_DIR%scripts\stable"
    echo [OK] 已删除 scripts/stable
)
if exist "%SCRIPT_DIR%scripts\dev" (
    rmdir /s /q "%SCRIPT_DIR%scripts\dev"
    echo [OK] 已删除 scripts/dev
)

echo [3/4] 正在复制新版脚本到 scripts/ ...
REM 从克隆的仓库中复制所有文件到 scripts/（排除 .git 等）
xcopy "%TEMP_DIR%\*" "%SCRIPT_DIR%scripts\" /E /Y /I /Q
REM 删除可能被复制过来的 .git 目录
if exist "%SCRIPT_DIR%scripts\.git" (
    rmdir /s /q "%SCRIPT_DIR%scripts\.git"
)
if exist "%SCRIPT_DIR%scripts\.gitignore" (
    del /q "%SCRIPT_DIR%scripts\.gitignore"
)
if exist "%SCRIPT_DIR%scripts\.github" (
    rmdir /s /q "%SCRIPT_DIR%scripts\.github"
)
echo [OK] 复制完成

echo [4/4] 清理临时文件 ...
rmdir /s /q "%TEMP_DIR%"
echo [OK] 清理完成

echo.
echo ============================================
echo   更新完成！
echo   scripts/ 目录现在是单一版本的最新 sd-scripts
echo   mikazuki/app/api.py 及其他脚本的路径已同步更新
echo ============================================
echo.

pause
