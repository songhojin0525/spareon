@echo off
rem Opens the progress board in your browser. Closing this window stops the board.
cd /d "%~dp0.."
node scripts\board.mjs --web --open %*
if errorlevel 1 (
  echo.
  echo Could not start the board. Is Node.js installed? Run stage S00 first.
)
pause
