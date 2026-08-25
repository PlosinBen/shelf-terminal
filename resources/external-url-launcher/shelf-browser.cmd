@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0shelf-browser.ps1" "%~1"
exit /b %ERRORLEVEL%
