# restart.ps1 — kill any uvicorn on the port and (re)start the dev server.
# Usage:  .\restart.ps1            (foreground, default :8000)
#         .\restart.ps1 -Port 8001
#         .\restart.ps1 -Background  (detached; returns immediately)
#         .\restart.ps1 -Reload     (dev only: auto-reload on code change)
#
# NOTE: -Reload is OFF by default on purpose. Under --reload uvicorn runs a
# reloader parent that OWNS the listen socket and a worker child that does the
# work; killing the worker by hand (to free the GPU) leaves the parent holding
# the port with nobody serving it — every request then hangs instead of being
# refused, and nothing ever respawns the worker. Without --reload there is one
# process: kill it and a supervisor (scripts\serve.ps1) can restart it cleanly.
param(
  [int]$Port = 8000,
  [switch]$Background,
  [switch]$Reload
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root
$py = Join-Path $root '.venv\Scripts\python.exe'

# kill any running uvicorn worker(s)
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'uvicorn' } |
  ForEach-Object { taskkill /PID $_.ProcessId /F /T | Out-Null }

# wait for the port to free (max ~5s)
for ($i = 0; $i -lt 25 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
  Start-Sleep -Milliseconds 200
}

$uvArgs = @('-m', 'uvicorn', 'oc.web.app:app', '--host', '127.0.0.1', '--port', "$Port")
if ($Reload) { $uvArgs += '--reload' }
if ($Background) {
  Start-Process -FilePath $py -ArgumentList $uvArgs -WorkingDirectory $root -WindowStyle Hidden
  Write-Host "server (re)started on http://127.0.0.1:$Port (background)"
} else {
  Write-Host "server starting on http://127.0.0.1:$Port - Ctrl+C to stop"
  & $py @uvArgs
}
