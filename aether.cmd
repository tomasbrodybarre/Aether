@echo off
title Aether
cd /d "%~dp0"

:: Start the dev server in the background
start "Aether Dev Server" /min cmd /c "npm run dev"

:: Wait for the server to be ready, then open browser
echo Starting Aether...
:wait
timeout /t 1 /nobreak >nul
curl -s -o nul http://localhost:3000 2>nul
if errorlevel 1 goto wait

start "" http://localhost:3000
echo Aether is running at http://localhost:3000
echo Close this window or press Ctrl+C to stop.
