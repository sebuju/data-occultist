<#
.SYNOPSIS
  Watch physical RAM + the hidden driver-locked memory over time to catch the slow leak.

.DESCRIPTION
  Samples system memory every -IntervalSec and APPENDS a row to a CSV. The key column is
  UNACCOUNTED_MB = physical-in-use minus PRIVATE process working sets minus kernel pools minus
  driver-resident image. That residue is driver-locked / MDL / AWE memory -- the leak that is
  invisible to Task Manager. Watch it climb; the timestamp where it jumps tells you what you
  launched. A second CSV (.procs.csv) logs the top processes each sample, so a plain process
  leak shows up too.

  NB: we use \Process(_Total)\Working Set - Private, NOT summed WorkingSet64. Full working sets
  double-count shared pages (every DLL counted once per process), which made UNACCOUNTED go
  large-negative and useless. Private WS counts each physical page once.

  Counter names are English-locale; on a localized Windows the \Memory\* paths differ.

.EXAMPLE
  .\scripts\mem_watch.ps1
.EXAMPLE
  .\scripts\mem_watch.ps1 -IntervalSec 30 -OutFile C:\temp\leak.csv
#>
param(
  [int]$IntervalSec = 60,
  [string]$OutFile = "$PSScriptRoot\mem_watch.csv",
  [int]$TopProcs = 6      # also dump top-N processes by Private bytes alongside each sample (0 = off)
)

$ErrorActionPreference = 'SilentlyContinue'
$totalMB  = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$procFile = $OutFile -replace '\.csv$', '.procs.csv'
$base = $null

function Get-Sample {
  $os    = Get-CimInstance Win32_OperatingSystem
  $inUse = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1KB
  $c = Get-Counter '\Memory\Available MBytes','\Memory\Pool Nonpaged Bytes',`
                   '\Memory\Pool Paged Resident Bytes','\Memory\Committed Bytes',`
                   '\Memory\System Driver Resident Bytes',`
                   '\Process(_Total)\Working Set - Private'
  $g = @{}
  foreach ($s in $c.CounterSamples) { $g[($s.Path -replace '.*\\', '')] = $s.CookedValue }
  $privWS = $g['working set - private'] / 1MB   # each physical page counted once (no shared double-count)
  $np = $g['pool nonpaged bytes'] / 1MB
  $pp = $g['pool paged resident bytes'] / 1MB
  $dr = $g['system driver resident bytes'] / 1MB
  [pscustomobject]@{
    Time            = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    InUse_MB        = [math]::Round($inUse)
    Avail_MB        = [math]::Round($g['available mbytes'])
    PrivWS_MB       = [math]::Round($privWS)
    NonpagedPool_MB = [math]::Round($np)
    PagedPool_MB    = [math]::Round($pp)
    DriverRes_MB    = [math]::Round($dr)
    Committed_MB    = [math]::Round($g['committed bytes'] / 1MB)
    UNACCOUNTED_MB  = [math]::Round($inUse - $privWS - $np - $pp - $dr)
  }
}

Write-Host "mem_watch: total RAM $totalMB MB | every ${IntervalSec}s | -> $OutFile" -ForegroundColor Cyan
Write-Host "UNACCOUNTED_MB = driver-locked/MDL/AWE (the hidden leak). Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

while ($true) {
  $row = Get-Sample
  if ($null -eq $base) { $base = $row.UNACCOUNTED_MB }
  $delta = $row.UNACCOUNTED_MB - $base

  $row | Export-Csv -Path $OutFile -NoTypeInformation -Append

  if ($TopProcs -gt 0) {
    Get-Process | Group-Object ProcessName | ForEach-Object {
      [pscustomobject]@{
        Time    = $row.Time
        App     = $_.Name
        Priv_MB = [math]::Round(($_.Group | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)
        WS_MB   = [math]::Round(($_.Group | Measure-Object WorkingSet64    -Sum).Sum / 1MB)
      }
    } | Sort-Object Priv_MB -Descending | Select-Object -First $TopProcs |
      Export-Csv -Path $procFile -NoTypeInformation -Append
  }

  $low   = if ($row.Avail_MB -lt 1000) { 'LOW!' } else { '' }
  $color = if ($row.Avail_MB -lt 1000) { 'Red' } elseif ($delta -gt 200) { 'Yellow' } else { 'Gray' }
  $line  = "{0}  inUse {1,6:N0}  avail {2,5:N0}  locked {3,6:N0} (d{4:+0;-0;0})  commit {5,7:N0} MB {6}" -f `
           $row.Time, $row.InUse_MB, $row.Avail_MB, $row.UNACCOUNTED_MB, $delta, $row.Committed_MB, $low
  Write-Host $line -ForegroundColor $color

  Start-Sleep -Seconds $IntervalSec
}
