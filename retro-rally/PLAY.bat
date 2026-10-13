@echo off
rem Retro Rally launcher: starts the server and opens the browser.
cd /d "%~dp0"
start "RetroRally helper" /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8080"
echo ============================================
echo   RETRO RALLY - server starting...
echo   Game: http://localhost:8080
echo   Stop the game: Ctrl+C in this window
echo ============================================
node src\server.js
