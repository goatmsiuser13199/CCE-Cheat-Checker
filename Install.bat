@echo off
title CCE Cheat Checker Installer
cd /d "%~dp0"

echo.
echo   CCE Cheat Checker — installer
echo   Double-click install. Close this window only when it says Done.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git is not installed.
  echo Download: https://git-scm.com/download/win
  echo Then re-run this file.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Download LTS: https://nodejs.org/
  echo Then re-run this file.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set ERR=%ERRORLEVEL%

echo.
if %ERR% neq 0 (
  echo Install failed. See messages above.
) else (
  echo You can close this window.
)
pause
exit /b %ERR%
