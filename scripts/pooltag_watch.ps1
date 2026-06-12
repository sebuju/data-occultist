<#
.SYNOPSIS
  poolmon without the WDK. Logs the top kernel pool TAGS by bytes each interval, so a
  driver that leaks nonpaged/paged pool is named directly. Pairs with mem_watch.ps1:
  when mem_watch's NonpagedPool_MB / PagedPool_MB column climbs, the tag growing here is
  the culprit; map tag -> driver with:
      findstr /s /m "Tagx" C:\Windows\System32\drivers\*.sys

.DESCRIPTION
  Calls NtQuerySystemInformation(SystemPoolTagInformation). x64 nonpaged pool tagging is
  on by default, so this works with no gflags change. Appends two views to CSV:
    <out>            top tags this sample (Tag, NonPaged_MB, Paged_MB)
    <out>.delta.csv  tags whose NonPaged+Paged grew the most vs the PREVIOUS sample
  Watch the delta file: a steady climber on the same tag every interval = the leak.

.EXAMPLE
  .\scripts\pooltag_watch.ps1 -IntervalSec 60 -Top 15
#>
param(
  [int]$IntervalSec = 60,
  [string]$OutFile = "$PSScriptRoot\pooltag_watch.csv",
  [int]$Top = 15
)

$ErrorActionPreference = 'Stop'
$deltaFile = $OutFile -replace '\.csv$', '.delta.csv'

if (-not ([System.Management.Automation.PSTypeName]'NtPool').Type) {
  Add-Type -Namespace '' -Name 'NtPool' -MemberDefinition @'
[DllImport("ntdll.dll")]
public static extern int NtQuerySystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength, out int ReturnLength);
'@
}

# SystemPoolTagInformation = 0x16. x64 SYSTEM_POOLTAG stride = 40 bytes:
#   +0  Tag[4]   +16 PagedUsed(SIZE_T)   +32 NonPagedUsed(SIZE_T)
function Get-PoolTags {
  $cls = 0x16
  $len = 1MB
  for ($try = 0; $try -lt 8; $try++) {
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)
    try {
      $ret = 0
      $st  = [NtPool]::NtQuerySystemInformation($cls, $buf, $len, [ref]$ret)
      if ($st -eq -1073741820) { $len = [Math]::Max($ret, $len * 2); continue }  # 0xC0000004 INFO_LENGTH_MISMATCH
      if ($st -ne 0) { throw ("NtQuerySystemInformation failed: 0x{0:X8}" -f $st) }
      $count = [Runtime.InteropServices.Marshal]::ReadInt32($buf, 0)
      $bytes = New-Object byte[] ($count * 40 + 8)
      [Runtime.InteropServices.Marshal]::Copy($buf, $bytes, 0, $bytes.Length)
      $out = New-Object System.Collections.Generic.List[object]
      for ($i = 0; $i -lt $count; $i++) {
        $o = 8 + $i * 40
        $tag = [System.Text.Encoding]::ASCII.GetString($bytes, $o, 4).TrimEnd([char]0, ' ')
        if (-not $tag) { continue }
        $paged    = [BitConverter]::ToInt64($bytes, $o + 16)
        $nonpaged = [BitConverter]::ToInt64($bytes, $o + 32)
        $out.Add([pscustomobject]@{ Tag = $tag; NonPaged = $nonpaged; Paged = $paged })
      }
      return $out
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
  }
  throw "buffer never large enough"
}

Write-Host "pooltag_watch: every ${IntervalSec}s | -> $OutFile (+ .delta.csv). Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "Watch the .delta.csv -- a tag that grows every sample is the leaking driver." -ForegroundColor DarkGray
Write-Host ""

$prev = @{}
while ($true) {
  $ts   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $tags = Get-PoolTags

  # absolute snapshot: top tags by total pool bytes
  $tags | Sort-Object { $_.NonPaged + $_.Paged } -Descending | Select-Object -First $Top | ForEach-Object {
    [pscustomobject]@{
      Time        = $ts
      Tag         = $_.Tag
      NonPaged_MB = [math]::Round($_.NonPaged / 1MB, 1)
      Paged_MB    = [math]::Round($_.Paged / 1MB, 1)
    }
  } | Export-Csv -Path $OutFile -NoTypeInformation -Append

  # delta vs previous sample: biggest growers
  $grow = foreach ($t in $tags) {
    $p = $prev[$t.Tag]
    $d = ($t.NonPaged + $t.Paged) - $p
    if ($p -and $d -gt 0) {
      [pscustomobject]@{ Time = $ts; Tag = $t.Tag; Grew_KB = [math]::Round($d / 1KB); Now_MB = [math]::Round(($t.NonPaged + $t.Paged)/1MB,1) }
    }
  }
  $grow | Sort-Object Grew_KB -Descending | Select-Object -First $Top |
    Export-Csv -Path $deltaFile -NoTypeInformation -Append

  $prev = @{}
  foreach ($t in $tags) { $prev[$t.Tag] = $t.NonPaged + $t.Paged }

  $topNow = $tags | Sort-Object { $_.NonPaged + $_.Paged } -Descending | Select-Object -First 3
  $line = "$ts  " + (($topNow | ForEach-Object { "{0}={1:N0}MB" -f $_.Tag, (($_.NonPaged + $_.Paged)/1MB) }) -join '  ')
  Write-Host $line -ForegroundColor Gray

  Start-Sleep -Seconds $IntervalSec
}
