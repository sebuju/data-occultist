<#
  install.ps1 - one-stop setup for data-occultist on Windows.

  Runs in three phases so it never interrupts you mid-work:
    1. detect   - probe Python, WebView2, NVIDIA GPU, winget (no changes made)
    2. ask       - collect EVERY decision up front (installs, GPU vs CPU, shortcut)
    3. execute   - do it all unattended, then print a summary

  Double-click #install.bat, or:
      powershell -ExecutionPolicy Bypass -File scripts\install.ps1
      powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Cpu   # prefer CPU OCR
      powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Yes   # accept all defaults, no prompts

  Nothing is reinstalled if it already exists. Only the winget sub-installs (Python /
  WebView2, when missing) may raise their own UAC prompts; everything else is user-scope.
#>
[CmdletBinding()]
param(
  [switch]$Cpu,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$venv = Join-Path $root '.venv'
$gaps = New-Object System.Collections.Generic.List[string]

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[install] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }

function Ask($prompt, [bool]$defaultYes = $true) {
  if ($Yes) { return $defaultYes }
  $hint = if ($defaultYes) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "  $prompt $hint"
  if ($a -eq '') { return $defaultYes }
  return ($a -match '^[Yy]')
}

function Test-Winget { return [bool](Get-Command winget -ErrorAction SilentlyContinue) }

# Resolved Python invocation (exe + arg list). Set by Find-Python; used to build the venv.
# Kept as two parts so a full path with spaces (the install-dir fallback) works too.
$script:PyExe = $null
$script:PyArgs = @()

function Test-PyVersion($exe, $argList) {
  # True if `<exe> <args> --version` reports Python 3.11+. --version is quote-free; an
  # embedded-quote `-c` probe is mangled by PowerShell 5.1's native-arg passing.
  try {
    $v = (& $exe @argList --version 2>$null | Select-Object -First 1)
    if ($v -match '(\d+)\.(\d+)') {
      return ([int]$Matches[1] -gt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 11))
    }
  } catch {}
  return $false
}

function Find-Python {
  # Sets $script:PyExe / $script:PyArgs and returns a display string, else $null.
  # `py -3` first so the launcher beats the Microsoft Store alias stub for `python`.
  foreach ($c in @(@('py', @('-3')), @('python', @()), @('python3', @()))) {
    $exe = $c[0]; $ar = $c[1]
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    if (Test-PyVersion $exe $ar) { $script:PyExe = $exe; $script:PyArgs = $ar; return ("$exe $($ar -join ' ')").Trim() }
  }
  # Fallback: PATH can be stale right after a fresh install. Probe the standard install
  # dirs directly and take the newest python.exe (full path, may contain spaces).
  $globs = @("$env:ProgramFiles\Python3*", "${env:ProgramFiles(x86)}\Python3*",
             "$env:LocalAppData\Programs\Python\Python3*")
  foreach ($g in $globs) {
    foreach ($d in (Get-ChildItem -Path $g -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      $px = Join-Path $d.FullName 'python.exe'
      if ((Test-Path $px) -and (Test-PyVersion $px @())) { $script:PyExe = $px; $script:PyArgs = @(); return $px }
    }
  }
  return $null
}

function Update-PathFromRegistry {
  # Rebuild THIS process's PATH from the (freshly-written) Machine + User registry values,
  # so a Python just installed by winget is visible without reopening the terminal.
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

function Test-WebView2 {
  $ids = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  )
  foreach ($k in $ids) {
    try {
      $v = (Get-ItemProperty -Path $k -Name pv -ErrorAction Stop).pv
      if ($v -and $v -ne '0.0.0.0') { return $true }
    } catch {}
  }
  return $false
}

function Install-Winget($id, $label, $url, [switch]$Machine) {
  # Elevate ONLY this install (UAC prompt for winget alone). The rest of the script
  # stays in the normal-user context so the venv + shortcuts are user-owned and land
  # in the right profile. --scope machine keeps Python out of an account-specific dir.
  if (-not (Test-Winget)) {
    Warn "winget not available - install $label manually: $url"
    return $false
  }
  Info "installing $label via winget (a UAC prompt will appear) ..."
  $a = @('install', '-e', '--id', $id, '--accept-source-agreements', '--accept-package-agreements')
  if ($Machine) { $a += @('--scope', 'machine') }
  try {
    $p = Start-Process -FilePath 'winget' -ArgumentList $a -Verb RunAs -Wait -PassThru
    if ($p.ExitCode -ne 0) { Warn "$label installer exited $($p.ExitCode)."; return $false }
    return $true
  } catch {
    Warn "elevation for $label was declined or failed: $($_.Exception.Message)"
    return $false
  }
}

function New-AppShortcut {
  $pyw = Join-Path $venv 'Scripts\pythonw.exe'
  $ico = Join-Path $root 'assets\data-occultist.ico'
  if (-not (Test-Path $pyw)) { return }
  $dirs = @(
    $root,                                          # repo-root data-occultist.lnk (replaces #app.bat)
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'data-occultist')
  )
  $ws = New-Object -ComObject WScript.Shell
  $made = @()
  foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $lnk = $ws.CreateShortcut((Join-Path $d 'data-occultist.lnk'))
    $lnk.TargetPath = $pyw
    $lnk.Arguments = '-m oc.desktop_main'
    $lnk.WorkingDirectory = $root
    if (Test-Path $ico) { $lnk.IconLocation = $ico }
    $lnk.Description = 'data-occultist (desktop)'
    $lnk.Save()
    $made += $d
  }
  Ok ("shortcut created in: " + ($made -join ', '))
}

# Test hook: dot-source with OC_INSTALL_TEST=1 to load the functions above WITHOUT
# running detect/ask/execute, so they can be unit-checked. No effect in normal use.
if ($env:OC_INSTALL_TEST -eq '1') { return }

# === 1. DETECT ===============================================================
Info 'detecting prerequisites ...'
$pyCmd   = Find-Python
$hasWV2  = Test-WebView2
$hasGpu  = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$winget  = Test-Winget

Write-Host ''
Write-Host '  Python 3.11+ : ' -NoNewline; if ($pyCmd) { Write-Host "found ($pyCmd)" -ForegroundColor Green } else { Write-Host 'missing' -ForegroundColor Yellow }
Write-Host '  WebView2     : ' -NoNewline; if ($hasWV2) { Write-Host 'found' -ForegroundColor Green } else { Write-Host 'missing' -ForegroundColor Yellow }
Write-Host '  NVIDIA GPU   : ' -NoNewline; if ($hasGpu) { Write-Host 'found' -ForegroundColor Green } else { Write-Host 'none' -ForegroundColor Yellow }
Write-Host '  winget       : ' -NoNewline; if ($winget) { Write-Host 'available' -ForegroundColor Green } else { Write-Host 'absent' -ForegroundColor Yellow }
Write-Host ''

# === 2. ASK (everything up front) ===========================================
Info 'a few questions, then it runs unattended:'
$doPython   = $false
$doWebView2 = $false
if (-not $pyCmd)  { $doPython   = Ask 'Install Python 3.12 (via winget)?' $true }
if (-not $hasWV2) { $doWebView2 = Ask 'Install Edge WebView2 runtime (needed for the desktop window)?' $true }

$useGpu = $false
if ($Cpu)        { $useGpu = $false }
elseif ($hasGpu) { $useGpu = Ask 'Use GPU OCR (downloads onnxruntime-gpu + CUDA wheels, ~2-3 GB)?' $true }

$doShortcut = Ask 'Create a "data-occultist" app shortcut on Desktop + Start menu?' $false

# === 3. EXECUTE (no more prompts) ===========================================
Write-Host ''
Info 'working ...'

if ($doPython) {
  [void](Install-Winget 'Python.Python.3.12' 'Python 3.12' 'https://www.python.org/downloads/' -Machine)
  Update-PathFromRegistry        # see the freshly-installed Python in THIS session
  $pyCmd = Find-Python           # also probes the install dirs if PATH is still stale
}
if ($doWebView2) { [void](Install-Winget 'Microsoft.EdgeWebView2Runtime' 'Edge WebView2 Runtime' 'https://developer.microsoft.com/microsoft-edge/webview2/') }

if (-not $pyCmd) {
  $gaps.Add('Python 3.11+ (installed, but not yet visible - reopen the terminal and re-run install)')
} else {
  if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Info 'creating venv ...'
    & $PyExe @PyArgs -m venv $venv
  } else { Ok 'venv already exists.' }

  $vpy = Join-Path $venv 'Scripts\python.exe'
  Info 'upgrading pip ...'
  & $vpy -m pip install --upgrade pip --quiet
  Info 'installing data-occultist (dev + desktop extras) ...'
  & $vpy -m pip install -e "$root[dev,desktop]"

  # rapidocr (core dep) ships no ONNX runtime; install exactly one. Never both -
  # a mixed CPU/GPU onnxruntime clobbers each other's DLLs and fails to load.
  if ($useGpu) {
    Info 'installing GPU OCR (onnxruntime-gpu + CUDA wheels) ...'
    & $vpy -m pip uninstall -y onnxruntime
    & $vpy -m pip install -e "$root[gpu]"
  } else {
    Info 'installing CPU OCR (onnxruntime) ...'
    & $vpy -m pip uninstall -y onnxruntime-gpu
    & $vpy -m pip install onnxruntime
  }
}

if (-not $hasWV2 -and -not $doWebView2) { $gaps.Add('Edge WebView2 Runtime (browser UI via data-occultist serve still works without it)') }
if ($doShortcut -and $pyCmd -and -not $gaps.Count) { New-AppShortcut }

# === summary =================================================================
Write-Host ''
if ($gaps.Count -eq 0) {
  Ok 'done. Launch the app via the "data-occultist" shortcut (if created), or:'
  Write-Host '    .\.venv\Scripts\Activate.ps1'
  Write-Host '    data-occultist serve    # browser UI at http://127.0.0.1:8000  (alias: occ serve)'
  Write-Host '    data-occultist app    # server + native window (from a terminal)'
  Write-Host '    data-occultist view   # native window onto an already-running server'
  exit 0
} else {
  Warn 'setup finished with gaps:'
  foreach ($g in $gaps) { Write-Host "    - $g" -ForegroundColor Yellow }
  exit 1
}
