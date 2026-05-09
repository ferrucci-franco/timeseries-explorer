@echo off
setlocal
cd /d "%~dp0"

echo.
echo Building web and portable distributions...
echo.

call npm run build:all
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo Combined build failed.
    exit /b %EXITCODE%
)

echo All builds completed.
echo Outputs: dist\ and portable-dist\
exit /b 0
