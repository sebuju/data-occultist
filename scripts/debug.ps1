# debug.ps1 - open the web UI in a fast DEBUG launch: no boot veil, no expanded log
# bar, and every slow boot step (stray-OCR kill, boot-OCR settle wait) skipped. Starts
# the dev server in the background if it is not already up, then opens the browser at
# the ?debug=1 URL. The gating lives in graph/main.js (see the `dbg` block there).
#
#     powershell -ExecutionPolicy Bypass -File scripts\debug.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\debug.ps1 -Load     # load game too
#     powershell -ExecutionPolicy Bypass -File scripts\debug.ps1 -Settle   # + drain OCR
#     powershell -ExecutionPolicy Bypass -File scripts\debug.ps1 -Pretty   # pretty view
#
# Toggle any single slow step back on with the switches; each maps to a URL flag.
param(
  [int]$Port = 8000,
  [switch]$Load,      # load the selected game (default: bare shell, instant)
  [switch]$Settle,    # wait for the boot OCR round to drain before showing
  [switch]$Kill,      # kill + await a stray OCR worker from a prior session
  [switch]$Veil,      # show the full-page boot spinner
  [switch]$BootLog,   # expand the log bar during boot
  [switch]$Pretty     # boot into the pretty dashboard (view=pretty)
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot            # repo root (parent of scripts\)
$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }

function Test-ServerUp {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/ocr/device" -f $Port) `
                           -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (-not (Test-ServerUp)) {
  Write-Host ("[debug] starting server on 127.0.0.1:{0} (background)..." -f $Port)
  $uvArgs = @('-m', 'uvicorn', 'oc.web.app:app', '--host', '127.0.0.1', '--port', "$Port",
              '--reload', '--reload-dir', (Join-Path $root 'src\oc'))
  Start-Process -FilePath $py -ArgumentList $uvArgs -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 60 -and -not (Test-ServerUp); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-ServerUp)) { Write-Host '[debug] server did not come up in time'; exit 1 }
}

# Build the query. debug=1 turns every slow step off; a switch forces one back on.
$q = @('debug=1')
if ($Pretty)  { $q += 'view=pretty' }
if ($Load)    { $q += 'load=1' }
if ($Settle)  { $q += 'settle=1' }
if ($Kill)    { $q += 'kill=1' }
if ($Veil)    { $q += 'veil=1' }
if ($BootLog) { $q += 'bootlog=1' }
$url = ("http://127.0.0.1:{0}/?{1}" -f $Port, ($q -join '&'))

Write-Host ("[debug] opening {0}" -f $url)
Start-Process $url
