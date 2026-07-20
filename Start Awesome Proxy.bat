@echo off
REM ============================================================
REM  Awesome Proxy - one-click launcher
REM  Starts the backend server and the web UI, then opens the
REM  app in your default browser. Close this window to stop.
REM ============================================================

title Awesome Proxy
cd /d "%~dp0"

echo.
echo   Awesome Proxy - starting...
echo.

REM Make sure dependencies are installed.
if not exist "node_modules" (
  echo   Installing dependencies for the first time, please wait...
  call npm install
)

REM Start the backend server in its own window.
start "Awesome Proxy - Backend" cmd /c "node server\index.js"

REM Give the backend a moment to bind its port.
timeout /t 2 /nobreak >nul

REM Start the web UI (Vite). It will open the browser automatically.
start "Awesome Proxy - UI" cmd /c "npx vite --config vite.config.web.ts"

REM Wait a bit then open the app in the default browser as a fallback.
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo   Awesome Proxy is running.
echo   - UI:      http://localhost:5173
echo   - Backend: http://127.0.0.1:3456
echo.
echo   Two helper windows were opened (Backend and UI).
echo   Close those windows to stop Awesome Proxy.
echo.
echo   You can close THIS window now.
echo.
pause
