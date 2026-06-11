@echo off
rem Keep the teaching UI + OCR alive (restarts on manual kill). Double-click or run it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
