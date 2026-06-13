<#
  Keep the data-rig web UI (and its OCR) alive.

  Run this once and leave it open. It starts the server if it isn't already running,
  and restarts it whenever it exits - including when you KILL the python process by hand
  (e.g. to free the GPU / reset a bloated OCR arena). A kill becomes a clean restart with
  a fresh OCR engine. Stop the supervisor with Ctrl+C (or close the window).

      powershell -ExecutionPolicy Bypass -File scripts\serve.ps1
#>

param(
    [int]$Port = 8000,
    [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot           # repo root (parent of scripts\)
$oc = Join-Path $root ".venv\Scripts\data-rig.exe" # the `data-rig` console script (has `rig`)
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }

function Test-ServerUp {
    # An HTTP probe, NOT a port check: a uvicorn --reload parent whose worker was
    # killed still LISTENS on the port while serving nothing — a port check would
    # call that "up" forever and never restart it.
    try {
        $r = Invoke-WebRequest -Uri ("http://{0}:{1}/api/ocr/device" -f $BindHost, $Port) `
                               -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Stop-WedgedListener {
    # The port is bound but the probe failed -> something is wedged (dead --reload
    # worker, hung OCR). Kill the owning process TREE so the port actually frees.
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Write-Host ("[serve] killing wedged listener pid {0}" -f $c.OwningProcess)
        taskkill /PID $c.OwningProcess /F /T | Out-Null
    }
    for ($i = 0; $i -lt 25 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 200
    }
}

function Start-Server {
    if (Test-Path $oc) {
        & $oc rig --host $BindHost --port $Port
    } else {
        & $py -m oc rig --host $BindHost --port $Port
    }
}

Write-Host ("[serve] supervising {0}:{1}" -f $BindHost, $Port)
$fails = 0
while ($true) {
    if (Test-ServerUp) { Start-Sleep -Seconds 3; $fails = 0; continue }   # already running -> watch

    Stop-WedgedListener   # free the port if something dead/hung still holds it
    Write-Host ("[serve] {0} starting data-rig web UI..." -f (Get-Date -Format HH:mm:ss))
    Push-Location $root
    Start-Server
    Pop-Location
    Write-Host ("[serve] {0} exited - restarting" -f (Get-Date -Format HH:mm:ss))

    if (Test-ServerUp) { $fails = 0 } else { $fails++ }   # crash-loop backoff
    Start-Sleep -Seconds ([Math]::Min(2 + $fails, 15))
}
