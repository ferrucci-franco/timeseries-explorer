@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Timeseries Explorer - Development Server

if /i "%~1"=="--help" goto :help

set "PORT=%~1"
if "%PORT%"=="" (
  call :find_free_port
  if errorlevel 1 (
    echo.
    echo [ERROR] No free port found between 8000 and 8010.
    echo         Try manually with: %~nx0 8080
    echo.
    pause
    exit /b 1
  )
)

echo ============================================================
echo    Timeseries Explorer - Development Server
echo ============================================================
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  echo         Install Node.js from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

set "CURRENT_BRANCH="
where git.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "CURRENT_BRANCH=%%B"
)

if defined CURRENT_BRANCH (
  echo Git branch: %CURRENT_BRANCH%
) else (
  echo Git branch: unavailable or detached HEAD
)
echo.

if not exist "node_modules\" (
  echo Installing project dependencies. This may take a few minutes...
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
  echo.
)

echo Starting http://127.0.0.1:%PORT%/
echo The browser will open when the server is ready.
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C or close this window to stop the server.
echo.

call npm.cmd run dev -- --host 127.0.0.1 --port %PORT% --strictPort --open

echo.
echo The development server has stopped.
pause
exit /b 0

:find_free_port
for %%P in (8000 8001 8002 8003 8004 8005 8006 8007 8008 8009 8010) do (
    netstat -ano | findstr /R /C:":%%P " >nul 2>nul
    if errorlevel 1 (
        set "PORT=%%P"
        exit /b 0
    )
)
exit /b 1

:help
echo Usage: %~nx0 [PORT]
echo.
echo Starts the development server for the branch currently checked out
echo in this working directory. It does not switch Git branches.
echo If PORT is omitted, the first free port between 8000 and 8010 is used.
echo.
echo To use another branch, stop the server, run:
echo   git switch BRANCH_NAME
echo and then start this file again.
exit /b 0
