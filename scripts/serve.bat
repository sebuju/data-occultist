@echo off
rem Keep the data-rig web UI + OCR alive (restarts on manual kill). Double-click or run it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
