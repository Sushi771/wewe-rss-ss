@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
set "ENABLE_SCHEDULED_UPDATES=0"
set "DISABLE_SCHEDULED_UPDATES=1"
set "WEWE_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%WEWE_NODE%" goto missing_node
set "WEWE_CHECK="
if /i "%~1"=="--check" set "WEWE_CHECK=--check"
"%WEWE_NODE%" scripts\local-release\desktop-start.cjs %WEWE_CHECK%
if errorlevel 1 goto failed
exit /b 0

:missing_node
echo 找不到本机 Node.js，请先安装项目要求的 Node.js。
goto failed

:failed
echo.
echo 启动检查未通过，请保留上方错误。此入口不会停止现有服务。
pause
exit /b 1
