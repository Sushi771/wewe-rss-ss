@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

node scripts/build-portable.js

if errorlevel 1 (
    echo.
    echo ❌ 构建过程发生错误!
    pause
    exit /b 1
)

pause


