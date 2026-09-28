@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
node scripts\prepare-local.cjs
echo.
echo 当前服务不会被此入口停止或迁移。请查看 docs\LOCAL_RELEASE_REHEARSAL.md。
pause
exit /b 1
