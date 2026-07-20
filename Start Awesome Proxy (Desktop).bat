@echo off
REM ============================================================
REM  Awesome Proxy - desktop (Electron) launcher
REM  Builds if needed, then launches the native desktop window.
REM  Close this window to stop the app.
REM ============================================================

title Awesome Proxy (Desktop)
cd /d "%~dp0"

echo.
echo   Awesome Proxy (Desktop) - starting...
echo.

if not exist "node_modules" (
  echo   Installing dependencies for the first time, please wait...
  call npm install
)

REM Build the renderer + electron main if they are missing.
if not exist "dist-electron\main.js" (
  echo   Building the app for the first time, please wait...
  call npm run build
)

REM Launch Electron directly against the built files.
call npx electron .

echo.
echo   Awesome Proxy has exited.
pause
