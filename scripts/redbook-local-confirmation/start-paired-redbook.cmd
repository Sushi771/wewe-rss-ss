@echo off
chcp 65001 >nul
title Redbook 本机确认 24小时
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-paired-redbook.ps1" %*
set "redbook_exit=%errorlevel%"
echo.
echo Redbook launcher finished. Review any message above. Press any key to close.
pause >nul
exit /b %redbook_exit%
