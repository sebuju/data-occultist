# app.ps1 - launch the data-occultist native webview window (server + window in one process).
# Closing the window stops the in-process server. Console-free: runs via pythonw and
# detaches, so the launching shell returns immediately. Same entry as the desktop
# shortcut and `data-occultist app` (both call oc.desktop_main.run_release).
#
#     powershell -ExecutionPolicy Bypass -File scripts\app.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\app.ps1 -Dml   # OCR on the iGPU
#
# -Venv / -Dml pick the virtualenv (default .venv); -Dml = .venv-dml (DirectML, iGPU OCR).

param(
    [string]$Venv = '.venv',
    [switch]$Dml
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_console.ps1')          # Resolve-VenvScripts
$root = Split-Path -Parent $PSScriptRoot            # repo root (parent of scripts\)
if ($Dml) { $Venv = '.venv-dml' }
$scripts = Resolve-VenvScripts $root $Venv
$pyw  = Join-Path $scripts 'pythonw.exe'            # no-console python
$py   = Join-Path $scripts 'python.exe'             # fallback (a console will show)

if (Test-Path $pyw) {
    Start-Process -FilePath $pyw -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
} elseif (Test-Path $py) {
    Start-Process -FilePath $py -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
} else {
    Start-Process -FilePath 'pythonw' -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
}
