@echo off
REM Keep this wrapper ASCII-only; bilingual UTF-8 output is handled by PowerShell.
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title lora-scripts-anima

if not exist "%~dp0tools\bootstrap_windows.ps1" (
    echo [ERROR] Windows bootstrap script is missing.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap_windows.ps1" %*
set "_ANIMA_RC=%ERRORLEVEL%"

if "%_ANIMA_RC%"=="23" goto :restart_after_repair

pause
exit /b %_ANIMA_RC%

:restart_after_repair
if "%ANIMA_BOOTSTRAP_RESTARTED%"=="1" (
    echo [WARN] Bootstrap already restarted once; please run start.bat again.
    pause
    exit /b 1
)
set "ANIMA_BOOTSTRAP_RESTARTED=1"
call "%~f0" %*
exit /b %ERRORLEVEL%
