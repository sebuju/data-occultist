<#
.SYNOPSIS
  Logs per-process HANDLE counts each interval to catch a handle/EPROCESS leak. Pairs with
  mem_watch.ps1's Proc pool tag: when Proc climbs, the process whose HandleCount climbs in
  lockstep here is the leaker (it is holding handles to dead child-processes, pinning their
  EPROCESS in nonpaged pool until reboot).

.DESCRIPTION
  Appends two views to CSV:
    <out>            top processes by handle count this sample (Name, Id, Handles, Priv_MB)
    <out>.delta.csv  processes whose handle count GREW vs the previous sample, biggest first
  Keyed by PID so a process that exits and a new one reusing the name don't blur together.
  Watch the delta file while Warframe runs: a process that grows handles EVERY sample is it.

.EXAMPLE
  .\scripts\handle_watch.ps1 -IntervalSec 60 -Top 20
#>
param(
  [int]$IntervalSec = 60,
  [string]$OutFile = "$PSScriptRoot\handle_watch.csv",
  [int]$Top = 20
)

$ErrorActionPreference = 'SilentlyContinue'
$deltaFile = $OutFile -replace '\.csv$', '.delta.csv'

Write-Host "handle_watch: every ${IntervalSec}s | -> $OutFile (+ .delta.csv). Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "Watch .delta.csv while Warframe runs -- the process growing handles every sample is the leaker." -ForegroundColor DarkGray
Write-Host ""

$prev = @{}   # key "pid|name" -> handle count
while ($true) {
  $ts    = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $procs = Get-Process | ForEach-Object {
    [pscustomobject]@{
      Key     = "$($_.Id)|$($_.ProcessName)"
      Name    = $_.ProcessName
      Id      = $_.Id
      Handles = $_.HandleCount
      Priv_MB = [math]::Round($_.PrivateMemorySize64 / 1MB)
    }
  }

  # absolute: top handle holders
  $procs | Sort-Object Handles -Descending | Select-Object -First $Top | ForEach-Object {
    [pscustomobject]@{ Time = $ts; Name = $_.Name; Id = $_.Id; Handles = $_.Handles; Priv_MB = $_.Priv_MB }
  } | Export-Csv -Path $OutFile -NoTypeInformation -Append

  # delta vs previous sample (same PID): biggest growers
  $grow = foreach ($p in $procs) {
    $was = $prev[$p.Key]
    if ($null -ne $was) {
      $d = $p.Handles - $was
      if ($d -gt 0) { [pscustomobject]@{ Time = $ts; Name = $p.Name; Id = $p.Id; GrewHandles = $d; Now = $p.Handles } }
    }
  }
  $grow | Sort-Object GrewHandles -Descending | Select-Object -First $Top |
    Export-Csv -Path $deltaFile -NoTypeInformation -Append

  $prev = @{}
  foreach ($p in $procs) { $prev[$p.Key] = $p.Handles }

  $totH = ($procs | Measure-Object Handles -Sum).Sum
  $topG = $grow | Sort-Object GrewHandles -Descending | Select-Object -First 1
  $tg   = if ($topG) { "  topGrower {0}+{1}" -f $topG.Name, $topG.GrewHandles } else { "" }
  Write-Host ("{0}  procs {1,3}  handles {2,7:N0}{3}" -f $ts, $procs.Count, $totH, $tg) -ForegroundColor Gray

  Start-Sleep -Seconds $IntervalSec
}
