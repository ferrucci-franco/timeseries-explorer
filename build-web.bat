@echo off
setlocal
cd /d "%~dp0"

echo.
echo Building web distribution...
echo.

call npm run build:web
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo Web build failed.
    exit /b %EXITCODE%
)

echo Web build completed.
echo Output: dist\
exit /b 0
