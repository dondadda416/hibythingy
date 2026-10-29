@echo off
title HiBy Hub
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║        HiBy Hub — Control Center         ║
echo  ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Download it from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Kill any existing server on port 3847 (so restarts always work cleanly)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr :3847 ^| findstr LISTENING') do (
    echo  Stopping previous instance ^(PID %%a^)...
    taskkill /F /PID %%a >nul 2>&1
)

:: Install npm packages if node_modules is missing or incomplete
if not exist node_modules (
    echo  First run — installing dependencies...
    echo  ^(this only happens once^)
    echo.
    npm install
    echo.
) else if not exist node_modules\node-id3 (
    echo  Installing missing dependency: node-id3...
    echo.
    npm install node-id3
    echo.
) else if not exist "node_modules\@anthropic-ai" (
    echo  Installing missing dependency: @anthropic-ai/sdk...
    echo.
    npm install @anthropic-ai/sdk
    echo.
)

:: Open browser after a short delay, then start server
echo  Opening dashboard at http://localhost:3847
echo  Press Ctrl+C to stop Hub.
echo.
start /b cmd /c "timeout /t 2 >nul && start http://localhost:3847"

:: Start cloudflared tunnel in background
start /b "" cloudflared tunnel run
echo Started cloudflared tunnel.
echo.

node server.js

pause
