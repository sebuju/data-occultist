@echo off
rem Double-click entry point for the native webview window (scripts\app.ps1).
rem Starts the server + native window in one process; closing the window stops the
rem server. The window launches detached (pythonw, no console), so this wrapper exits
rem immediately - no pause.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\app.ps1" %*
