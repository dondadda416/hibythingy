@echo off
title HiBy Hub — Git Setup
cd /d "%~dp0"

echo.
echo  Setting up Git repository for HiBy Hub...
echo.

:: Remove any partial .git dir from previous attempt
if exist ".git" (
    echo  Removing partial .git folder...
    rmdir /s /q ".git"
)

:: Init
git init -b main
git config user.name "cidstar"
git config user.email "cindy@dataonthespot.com"

:: Stage everything (.gitignore will exclude node_modules, cache, config.js)
git add -A

:: First commit
git commit -m "Initial commit: HiBy Hub v1.0"

echo.
echo  ============================================================
echo  Local repo ready! Now:
echo.
echo  1. Go to https://github.com/new
echo  2. Name it:  hiby-hub
echo  3. Set it to Private (or Public — your call)
echo  4. Do NOT add README / .gitignore / license (we have them)
echo  5. Click "Create repository"
echo  6. Copy the repo URL (e.g. https://github.com/cidstar/hiby-hub.git)
echo  7. Come back here and paste the URL when asked
echo.
set /p REPO_URL="  Paste your GitHub repo URL here: "

git remote add origin %REPO_URL%
git push -u origin main

echo.
echo  Done! Your repo is live at %REPO_URL%
echo.
pause
