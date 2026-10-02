@echo off
cd /d "%~dp0.."

if not exist "node_modules" (
    echo Dependencies aren't installed yet.
    echo Please run install.bat first.
    echo.
    pause
    exit /b 1
)

echo ============================================
echo   Starting Receipt System...
echo   Leave this window open - closing it stops the server.
echo   Your browser will open automatically in a few seconds.
echo ============================================
echo.

start "" cmd /c "timeout /t 3 >nul && start http://localhost:3000"

npm start
