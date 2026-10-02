@echo off
setlocal

echo ============================================
echo   Receipt System - Windows EXE Builder
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found.
    echo Install Node.js LTS from https://nodejs.org then re-run this script.
    echo.
    pause
    exit /b 1
)
echo Node.js found:
node -v
echo (Building the apps needs Node.js 22.13 or newer.)
echo.

:: Move to project root (one level up from windows\)
cd /d "%~dp0.."

:: Install dependencies (includes compiling better-sqlite3 for Windows)
echo Installing dependencies...
echo This may take a minute on first run.
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm install failed. See above for details.
    echo Make sure you have internet access and try again.
    pause
    exit /b 1
)
echo.

:: Build ReceiptSystem.exe and PrintMonitorAgent.exe (Node single-executable apps)
echo Building the apps...
call npm run build:exe
if errorlevel 1 (
    echo.
    echo ERROR: build failed. See above for details.
    pause
    exit /b 1
)
echo.
echo ============================================
echo   Build complete!
echo.
echo   Output: dist\ReceiptSystem-win-x64\ (and a .zip of it)
echo     ReceiptSystem.exe      - the whole system, double-click to start
echo     PrintMonitorAgent.exe  - for PCs that have a printer
echo.
echo   Copy the folder anywhere; your data is kept in a "data"
echo   folder next to ReceiptSystem.exe.
echo ============================================
echo.
pause
