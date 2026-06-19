# start_server.ps1 - kill any uvicorn on the port and (re)start the dev server.
# Usage:  .\start_server.ps1            (foreground, default :8000, auto-reload)
#         .\start_server.ps1 -Port 8001
#         .\start_server.ps1 -Background  (detached; returns immediately)
#         .\start_server.ps1 -NoReload   (single process; no auto-reload)
#
# Auto-reload is ON by default for dev. Caveat: under --reload uvicorn runs a
# reloader parent that OWNS the listen socket and a worker child that does the
# work; killing the worker by hand leaves the parent holding the port with
# nobody serving it - requests hang and nothing respawns the worker. Use
# -NoReload for the single-process mode a manual-kill / supervisor
# (scripts\serve.ps1) workflow needs.
param(
  [int]$Port = 8000,
  [switch]$Background,
  [switch]$NoReload
)

$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot '_console.ps1'); Enable-AnsiColors   # render uvicorn's ANSI colors
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
Set-Location $root
$py = Join-Path $root '.venv\Scripts\python.exe'

# remind me of the flags without opening this file
Write-Host "flags: -Port <n> (default 8000)  -Background (detached)  -NoReload (single process)" -ForegroundColor DarkGray
Write-Host ("active: port=$Port  reload=" + (-not $NoReload) + "  background=$Background") -ForegroundColor DarkGray

# kill any running uvicorn worker(s)
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'uvicorn' } |
  ForEach-Object { taskkill /PID $_.ProcessId /F /T | Out-Null }

# wait for the port to free (max ~5s)
for ($i = 0; $i -lt 25 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
  Start-Sleep -Milliseconds 200
}

$uvArgs = @('-m', 'uvicorn', 'oc.web.app:app', '--host', '127.0.0.1', '--port', "$Port")
if (-not $NoReload) {
  # auto-reload, but never restart on edits under scripts/ or tests/ (not served code).
  # reload-exclude globs are fnmatch-matched against the full path, so wrap in * and cover
  # both path separators for Windows.
  # Watch ONLY the served source. With a bare --reload uvicorn watches the whole cwd -
  # which includes config/ and data/, so every teach save (the app writing a profile)
  # both restarts the server AND has the watcher lock the file mid-write (WinError 5 on
  # the atomic replace). Scoping to src/oc means data writes never trigger a reload.
  $uvArgs += @('--reload', '--reload-dir', (Join-Path $root 'src\oc'))
}
if ($Background) {
  Start-Process -FilePath $py -ArgumentList $uvArgs -WorkingDirectory $root -WindowStyle Hidden
  Write-Host "server (re)started on http://127.0.0.1:$Port (background)"
} else {
  Write-Host "server starting on http://127.0.0.1:$Port - Ctrl+C to stop"
  # Do NOT block PS inside the child (& $py): under --reload uvicorn runs a reloader
  # PARENT + worker child, and on Windows the parent stops honoring Ctrl+C after the
  # first auto-reload (a known uvicorn issue) - the server looks "unkillable". Instead
  # run detached-but-attached (-NoNewWindow keeps logs streaming) and poll from PS, so
  # Ctrl+C interrupts our OWN Start-Sleep; the finally then force-kills the whole tree
  # (reloader + worker), which dies even when the reloader has wedged.
  $proc = Start-Process -FilePath $py -ArgumentList $uvArgs -WorkingDirectory $root -NoNewWindow -PassThru
  try {
    while (-not $proc.HasExited) { Start-Sleep -Milliseconds 250 }
  } finally {
    if (-not $proc.HasExited) { taskkill /PID $proc.Id /F /T | Out-Null }
  }
}
