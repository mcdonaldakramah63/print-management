@echo off
setlocal

echo ============================================
echo   Receipt System - Windows Setup
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js was not found on this PC.
    echo.
    echo Install Node.js LTS first from:
    echo   https://nodejs.org
    echo Then re-run this script.
    echo.
    pause
    exit /b 1
)

echo Node.js found:
node -v
echo.

cd /d "%~dp0.."

if not exist ".env" (
    echo Creating .env from .env.example...
    copy /y ".env.example" ".env" >nul
    echo IMPORTANT: open .env in Notepad and set a real SESSION_SECRET before real use.
    echo.
)

echo Installing dependencies - this can take a minute...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo npm install failed. See the error above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete!
echo   Double-click start.bat to launch the app.
echo ============================================
pause
