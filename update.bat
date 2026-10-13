@echo off
REM Keep this wrapper ASCII-only; bilingual output is handled by PowerShell.
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title lora-scripts-anima update

if not exist "%~dp0tools\bootstrap_windows.ps1" (
    echo [ERROR] Windows bootstrap script is missing.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap_windows.ps1" --bootstrap-action=update %*
set "_ANIMA_RC=%ERRORLEVEL%"
pause
exit /b %_ANIMA_RC%
