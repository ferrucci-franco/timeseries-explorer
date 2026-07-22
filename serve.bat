@echo off
setlocal
chcp 65001 >nul

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

cd /d "%~dp0"

set "SERVER_URL=http://127.0.0.1:%PORT%/index.html"

:run
if "%~1"=="" (
    call :find_free_port
    if errorlevel 1 (
        echo.
        echo No free port was found between 8000 and 8010.
        echo Try manually with: serve.bat 8080
        echo.
        pause
        exit /b 1
    )
)

set "SERVER_URL=http://127.0.0.1:%PORT%/index.html"

where node >nul 2>nul
if %ERRORLEVEL%==0 (
    set "HAS_NODE=1"
)

where npm.cmd >nul 2>nul
if %ERRORLEVEL%==0 (
    if exist "package.json" (
        goto :run_vite
    )
)

if exist "node_modules\vite" (
    goto :run_vite
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    set "PY_CMD=python"
    goto :run_python
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
    set "PY_CMD=py -3"
    goto :run_python
)

if "%HAS_NODE%"=="1" (
    if exist "scripts\portable-server.mjs" (
        goto :run_node_static
    )
)

echo.
echo Starting local server at:
echo   %SERVER_URL%
echo.
echo To stop it, close this window or press Ctrl+C.
echo.
start "" "%SERVER_URL%"
echo.
echo Neither Vite nor Python is available.
echo Install Node.js from https://nodejs.org or use Python 3.
echo.
pause
exit /b 1

:run_node_static
echo.
echo Starting Time Series Explorer Web Preview at:
echo   %SERVER_URL%
echo.
echo This mode matches the web version: no local API and no Live Update.
echo.
echo To stop it, close this window or press Ctrl+C.
echo.
set "OMV_PORT=%PORT%"
set "OMV_WEB_PREVIEW=1"
call node scripts\portable-server.mjs

endlocal
exit /b 0

:run_vite
if not exist "node_modules\.bin\vite.cmd" (
    echo.
    echo Preparing Time Series Explorer dependencies...
    echo This may take a few minutes the first time.
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo Dependency installation failed.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Starting Time Series Explorer Light Web with Vite at:
echo   %SERVER_URL%
echo.
echo This mode matches the web version: no local API and no Live Update.
echo.
echo To stop it, close this window or press Ctrl+C.
echo.
call npm.cmd run dev -- --host 127.0.0.1 --port %PORT% --strictPort --open /index.html
if errorlevel 1 (
    echo.
    echo The Vite server could not start.
    echo If the port is busy, try: serve.bat 8080
    echo.
    pause
    exit /b 1
)

endlocal
exit /b 0

:run_python
echo.
echo Starting Time Series Explorer Light Web with Python at:
echo   %SERVER_URL%
echo.
echo This mode matches the web version: no local API and no Live Update.
echo.
echo To stop it, close this window or press Ctrl+C.
echo.
start "" "%SERVER_URL%"
call %PY_CMD% -m http.server %PORT%

endlocal
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
