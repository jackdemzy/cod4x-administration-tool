@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo BUILD FEHLGESCHLAGEN. Exit-Code: %EXITCODE%
  pause
)
exit /b %EXITCODE%
