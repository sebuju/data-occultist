<#
.SYNOPSIS
  Watch physical RAM by category to localise a kernel/driver leak (the "in use is high
  but no process accounts for it" kind that forces a reboot).

.DESCRIPTION
  Samples system memory every -IntervalSec and APPENDS a row to a CSV. Splits physical
  in-use into every nameable bucket, so when the leak ramps you see WHICH one climbs:

    ProcWS_MB     process working sets (full: private + shared). A normal app leak.
    PrivWS_MB     private working sets only (what Task Manager shows per process).
    Shared_MB     ProcWS - PrivWS: shared DLL / mapped-file pages (shared once, never
                  sums in the per-process list -- this is why processes "don't add up").
    Standby_MB    file cache. Reclaimable. NOT a leak even when large.
    Modified_MB   dirty pages pending writeback.
    NonpagedPool  kernel nonpaged pool. A driver leaking here is the classic reboot leak.
    PagedPool_MB  kernel paged pool (resident).
    DriverRes_MB  driver image pages.
    RESIDUE_MB    InUse minus ALL of the above. This is driver-locked / MDL / AWE / page-
                  table memory -- physical RAM that belongs to NO process and NO pool.
                  Near-zero normally. If THIS climbs monotonically, that is your leak and
                  it is kernel-side (a driver locking pages via MDL/AWE), not an app.

  Reading the result:
    * NonpagedPool_MB climbs  -> driver pool leak. Run pooltag_watch.ps1 to name the tag,
                                 then: findstr /s /m "Tag1" C:\Windows\System32\drivers\*.sys
    * PagedPool_MB climbs     -> paged pool leak (same hunt).
    * RESIDUE_MB climbs       -> MDL/driver-locked leak. pooltag won't show it; use RAMMap
                                 (Sysinternals) "Driver Locked" / "Page Table" rows.
    * ProcWS/PrivWS climbs    -> it was a process after all; .procs.csv names it.

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

$counters = @(
  '\Memory\Available MBytes',
  '\Memory\Committed Bytes',
  '\Memory\Standby Cache Reserve Bytes',
  '\Memory\Standby Cache Normal Priority Bytes',
  '\Memory\Standby Cache Core Bytes',
  '\Memory\Modified Page List Bytes',
  '\Memory\Pool Nonpaged Bytes',
  '\Memory\Pool Paged Resident Bytes',
  '\Memory\System Driver Resident Bytes',
  '\Process(_Total)\Working Set',
  '\Process(_Total)\Working Set - Private'
)

function Get-Sample {
  $os    = Get-CimInstance Win32_OperatingSystem
  $inUse = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1KB   # MB, true free (excludes standby)
  $c = Get-Counter $counters
  $g = @{}
  foreach ($s in $c.CounterSamples) { $g[($s.Path -replace '.*\\', '')] = $s.CookedValue }

  $wsFull  = $g['working set'] / 1MB
  $wsPriv  = $g['working set - private'] / 1MB
  $shared  = $wsFull - $wsPriv
  $standby = ($g['standby cache reserve bytes'] + $g['standby cache normal priority bytes'] + $g['standby cache core bytes']) / 1MB
  $modif   = $g['modified page list bytes'] / 1MB
  $np      = $g['pool nonpaged bytes'] / 1MB
  $pp      = $g['pool paged resident bytes'] / 1MB
  $dr      = $g['system driver resident bytes'] / 1MB
  # Everything physical-in-use that is NOT a process page, cache, or named pool.
  # Driver-locked / MDL / AWE / page tables live here. Near-zero on a healthy box.
  $residue = $inUse - $wsFull - $standby - $modif - $np - $pp - $dr

  [pscustomobject]@{
    Time            = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    InUse_MB        = [math]::Round($inUse)
    Avail_MB        = [math]::Round($g['available mbytes'])
    Committed_MB    = [math]::Round($g['committed bytes'] / 1MB)
    ProcWS_MB       = [math]::Round($wsFull)
    PrivWS_MB       = [math]::Round($wsPriv)
    Shared_MB       = [math]::Round($shared)
    Standby_MB      = [math]::Round($standby)
    Modified_MB     = [math]::Round($modif)
    NonpagedPool_MB = [math]::Round($np)
    PagedPool_MB    = [math]::Round($pp)
    DriverRes_MB    = [math]::Round($dr)
    RESIDUE_MB      = [math]::Round($residue)
  }
}

Write-Host "mem_watch: total RAM $totalMB MB | every ${IntervalSec}s | -> $OutFile" -ForegroundColor Cyan
Write-Host "RESIDUE_MB = driver-locked/MDL/page-table memory (the hidden kernel leak). Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

while ($true) {
  $row = Get-Sample
  if ($null -eq $base) { $base = $row.RESIDUE_MB }
  $delta = $row.RESIDUE_MB - $base

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
  $line  = "{0}  inUse {1,6:N0}  avail {2,5:N0}  NPpool {3,5:N0}  residue {4,6:N0} (d{5:+0;-0;0}) MB {6}" -f `
           $row.Time, $row.InUse_MB, $row.Avail_MB, $row.NonpagedPool_MB, $row.RESIDUE_MB, $delta, $low
  Write-Host $line -ForegroundColor $color

  Start-Sleep -Seconds $IntervalSec
}
