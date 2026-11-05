@echo off
setlocal
chcp 65001 >nul
"%~dp0..\runtime\node.exe" "%~dp0update-entry.cjs"
if errorlevel 1 pause
endlocal
