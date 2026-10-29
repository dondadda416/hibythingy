@echo off
cd /d "%~dp0"
echo Running make-playlists.js...
node scripts\make-playlists.js
echo.
pause
