# Elevated Razer kill - stops the leak holder so the kernel closes its handles and
# frees the pinned EPROCESS objects (Proc pool). Writes result to kill_result.txt.
$ErrorActionPreference = 'SilentlyContinue'
$before = [math]::Round((Get-Counter '\Memory\Pool Nonpaged Bytes').CounterSamples[0].CookedValue / 1MB)

# stop the service first so it can't respawn its children
Stop-Service "Razer Synapse Service" -Force
sc.exe stop "Razer Synapse Service" | Out-Null

# kill every Razer / GameManager process
Get-Process | Where-Object { $_.ProcessName -match 'Razer|GameManager' } | Stop-Process -Force
taskkill /F /IM "GameManagerService.exe" /IM "RazerCentralService.exe" 2>$null | Out-Null

# make it permanent so it does not auto-start again
Set-Service "Razer Synapse Service" -StartupType Manual

Start-Sleep -Seconds 3
$after = [math]::Round((Get-Counter '\Memory\Pool Nonpaged Bytes').CounterSamples[0].CookedValue / 1MB)

$out = @()
$out += "NP_before_MB = $before"
$out += "NP_after_MB  = $after"
$out += "freed_MB     = $($before - $after)"
$out += "survivors:"
$out += (Get-Process | Where-Object { $_.ProcessName -match 'Razer|GameManager' } |
         Select-Object Name, Id, HandleCount | Out-String)
$out | Out-File -FilePath "D:\git\oc\scripts\kill_result.txt" -Encoding utf8
