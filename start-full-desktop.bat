@echo off
setlocal

cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo.
    echo No se encontro npm.cmd.
    echo Instala Node.js para ejecutar la version Full Desktop desde este checkout.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Preparando dependencias de OpenModelica Viewer Full Desktop...
    echo Esto puede tardar la primera vez.
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo No se pudieron instalar las dependencias.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Iniciando OpenModelica Viewer Full Desktop...
echo.
call npm.cmd run desktop
if errorlevel 1 (
    echo.
    echo La version Full Desktop se cerro con un error.
    echo.
    pause
    exit /b 1
)

endlocal
