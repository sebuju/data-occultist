# app.ps1 - launch the data-rig native webview window (server + window in one process).
# Closing the window stops the in-process server. Console-free: runs via pythonw and
# detaches, so the launching shell returns immediately. Same entry as the desktop
# shortcut and `data-rig app` (both call oc.desktop_main.run_release).
#
#     powershell -ExecutionPolicy Bypass -File scripts\app.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot            # repo root (parent of scripts\)
$pyw  = Join-Path $root '.venv\Scripts\pythonw.exe' # no-console python
$py   = Join-Path $root '.venv\Scripts\python.exe'  # fallback (a console will show)

if (Test-Path $pyw) {
    Start-Process -FilePath $pyw -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
} elseif (Test-Path $py) {
    Start-Process -FilePath $py -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
} else {
    Start-Process -FilePath 'pythonw' -ArgumentList '-m', 'oc.desktop_main' -WorkingDirectory $root
}
