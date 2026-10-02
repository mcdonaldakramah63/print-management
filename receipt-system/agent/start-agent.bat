@echo off
cd /d "%~dp0"

if not exist "config.json" (
    echo config.json not found in this folder.
    echo.
    echo Copy config.example.json to config.json first, then edit it:
    echo   - backendUrl : e.g. http://localhost:3000 if testing on this same PC
    echo   - agentApiKey: from Print Monitoring ^> Register agent in the app
    echo.
    pause
    exit /b 1
)

echo ============================================
echo   Starting Print Monitor Agent...
echo   Leave this window open - closing it stops monitoring.
echo ============================================
echo.

node agent.js
pause
