@echo off
cd /d "%~dp0"
set NO_PROXY=localhost,127.0.0.1,0.0.0.0
echo Starting WeWe RSS Server...

echo Releasing port 4000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do (
    echo Killing PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

start /b cmd /c "timeout /t 3 >nul && start http://localhost:4000/dash"
call pnpm run start:server
echo.
echo Server stopped or failed to start.
pause
