@echo off
rem Double-click entry point for install.ps1.
rem
rem .ps1 files open in Notepad on double-click (and ExecutionPolicy blocks them), so
rem this wrapper launches PowerShell with the policy bypassed. It runs as the NORMAL
rem user on purpose: the venv, pip packages and shortcuts must be user-owned and land
rem in YOUR profile. install.ps1 elevates only the specific winget system-installs
rem (Python / WebView2) that actually need admin, via their own UAC prompt.
rem Pass-through args work:  install.bat -Cpu   /   install.bat -Yes
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
