@echo off
rem Opens the agents view (orc and subagents with their messages) in this console. Press a to switch to the board, q to quit.
cd /d "%~dp0.."
node scriptsoard.mjs --agents %*
if errorlevel 1 (
  echo.
  echo Could not start the agents view. Is Node.js installed? Run stage S00 first.
  pause
)
