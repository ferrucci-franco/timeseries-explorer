@echo off
setlocal

cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo.
    echo npm.cmd was not found.
    echo Install Node.js to run the Full Desktop version from this checkout.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Preparing Time Series Explorer Full Desktop dependencies...
    echo This may take a while the first time.
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
echo Starting Time Series Explorer Full Desktop...
echo.
call npm.cmd run desktop
if errorlevel 1 (
    echo.
    echo The Full Desktop version exited with an error.
    echo.
    pause
    exit /b 1
)

endlocal
