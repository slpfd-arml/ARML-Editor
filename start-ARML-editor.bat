@echo off
title ARML Editor
cd /d "%~dp0"

REM ============================================================
REM  Turnkey Node.js detection
REM  ------------------------------------------------------------
REM  If a portable copy of Node.js has been dropped into
REM  node-portable\ (see node-portable\PLACE-NODE-HERE.txt), use
REM  THAT instead of anything installed system-wide - so this tool
REM  works on a machine with no Node.js on it at all, no admin
REM  rights, nothing installed, just the thumb drive. Falls back to
REM  a system install if no portable copy is present, so this still
REM  works unchanged on a machine that already has Node.js.
REM ============================================================
set "NODE_EXE=node"
set "NPM_CMD=npm"

if exist "node-portable\node.exe" (
  echo Using the bundled copy of Node.js - nothing else to install.
  set "NODE_EXE=%~dp0node-portable\node.exe"
  set "NPM_CMD=%~dp0node-portable\npm.cmd"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Node.js wasn't found on this computer, and there's no bundled
    echo copy in node-portable\ either.
    echo.
    echo Either install Node.js from https://nodejs.org and run this
    echo file again, or see node-portable\PLACE-NODE-HERE.txt for how
    echo to add a portable copy that needs no install at all.
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo First-time setup - installing dependencies, this only happens once...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo.
    echo Setup failed. Make sure Node.js is installed: https://nodejs.org
    pause
    exit /b 1
  )
  echo.
)

echo Starting the ARML Editor...
echo.
echo A browser tab should open automatically. If it shows an error the very
echo first time, just refresh the page - the server takes a moment to start.
echo.
echo To stop the tool, close this window.
echo.

start "" "http://localhost:3000"
"%NODE_EXE%" server.js

echo.
echo Server stopped.
pause >nul
