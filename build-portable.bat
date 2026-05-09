@echo off
setlocal
cd /d "%~dp0"

echo.
echo Building portable distribution...
echo.

call npm run build:portable
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo Portable build failed.
    exit /b %EXITCODE%
)

echo Portable build completed.
echo Output: portable-dist\
exit /b 0
