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

:: Install pkg globally if not already present.
:: Inside the block below, "if errorlevel 1" is checked at run time - a
:: percent-errorlevel check there would be expanded when the block is parsed.
where pkg >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pkg...
    call npm install -g pkg
    if errorlevel 1 (
        echo ERROR: Failed to install pkg.
        pause
        exit /b 1
    )
)
echo pkg found.
echo.

:: Create output folder
if not exist "dist" mkdir dist

:: Build the exe
echo Building receipt-system.exe ...
echo This will take 1-3 minutes while pkg downloads the Node runtime.
echo.
call pkg . --targets node18-win-x64 --output dist\receipt-system.exe --compress GZip
if %errorlevel% neq 0 (
    echo.
    echo ERROR: pkg build failed. See above for details.
    pause
    exit /b 1
)

:: Copy public folder alongside the exe (static files must be external)
echo.
echo Copying public assets...
if exist "dist\public" rd /s /q "dist\public"
xcopy /e /i /q "public" "dist\public"

:: Copy .env.example as a template if no .env exists in dist
if not exist "dist\.env" (
    if exist ".env.example" (
        copy /y ".env.example" "dist\.env" >nul
    ) else (
        echo SESSION_SECRET=change-this-to-a-long-random-string> "dist\.env"
        echo PORT=3000>> "dist\.env"
    )
    echo Created dist\.env - edit it to set a real SESSION_SECRET before deploying.
)

echo.
echo ============================================
echo   Build complete!
echo.
echo   Output: dist\receipt-system.exe
echo.
echo   To distribute, copy the entire dist\ folder.
echo   The exe, public\ folder, and .env must stay together.
echo.
echo   Run: dist\receipt-system.exe
echo   Then open: http://localhost:3000
echo ============================================
echo.
pause
