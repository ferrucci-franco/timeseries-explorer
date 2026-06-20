@echo off
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

cd /d "%~dp0"

set "SERVER_URL=http://localhost:%PORT%/index.html"

:run
if "%~1"=="" (
    call :find_free_port
    if errorlevel 1 (
        echo.
        echo No se encontro un puerto libre entre 8000 y 8010.
        echo Prueba manualmente con: serve.bat 8080
        echo.
        pause
        exit /b 1
    )
)

set "SERVER_URL=http://localhost:%PORT%/index.html"

where node >nul 2>nul
if %ERRORLEVEL%==0 (
    set "HAS_NODE=1"
)

where npm >nul 2>nul
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
echo Iniciando servidor local en:
echo   %SERVER_URL%
echo.
echo Para detenerlo, cierra esta ventana o presiona Ctrl+C.
echo.
start "" "%SERVER_URL%"
echo.
echo No se encontro ni Vite ni Python disponibles.
echo Instala dependencias con npm install o usa Python 3.
echo.
pause
exit /b 1

:run_node_static
echo.
echo Iniciando Time Series Explorer Web Preview en:
echo   %SERVER_URL%
echo.
echo Este modo reproduce la version web: no incluye API local ni Live Update.
echo.
echo Para detenerlo, cierra esta ventana o presiona Ctrl+C.
echo.
set "OMV_PORT=%PORT%"
set "OMV_WEB_PREVIEW=1"
call node scripts\portable-server.mjs

endlocal
exit /b 0

:run_vite
echo.
echo Iniciando Time Series Explorer Light Web con Vite en:
echo   %SERVER_URL%
echo.
echo Este modo reproduce la version web: no incluye API local ni Live Update.
echo.
echo Para detenerlo, cierra esta ventana o presiona Ctrl+C.
echo.
start "" "%SERVER_URL%"
call npm run dev -- --host 127.0.0.1 --port %PORT% --strictPort

endlocal
exit /b 0

:run_python
echo.
echo Iniciando Time Series Explorer Light Web con Python en:
echo   %SERVER_URL%
echo.
echo Este modo reproduce la version web: no incluye API local ni Live Update.
echo.
echo Para detenerlo, cierra esta ventana o presiona Ctrl+C.
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
